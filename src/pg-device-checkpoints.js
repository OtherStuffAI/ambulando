import { getWorkspaceDb } from './db.js';

export const canonicalClientId = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
export const checkpointRevision = value => typeof value === 'string' && /^\d+$/.test(value);
export const DEVICE_CACHE_OWNER_KEY = 'record-device-cache-owner';
export function createDeviceCacheId(random = globalThis.crypto) {
  // getRandomValues is also available in native HTTP/FIPS contexts where
  // randomUUID is restricted to secure origins.
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function deviceCheckpointScope(context) {
  return JSON.stringify([context.baseUrl, context.appNpub, context.workspaceId, context.sessionNpub]);
}
export function validateCheckpoint(value, device) {
  if (value?.protocol_version !== 2 || value.client_id !== device.clientId
    || !checkpointRevision(value.checkpoint_revision) || !value.authority_epoch
    || !value.initial_cursor || device.authorityEpoch && value.authority_epoch !== device.authorityEpoch) {
    throw new Error('Invalid Tower device checkpoint identity');
  }
  return value;
}

// These operations run only through the service-owned materialisation worker.
// Device metadata lives with its rows, never in browser preferences/localStorage.
export async function commitDeviceMetadata(cursorKey, action) {
  const db = getWorkspaceDb();
  return db.transaction('rw', db.sync_state, db.pg_record_rows, async () => {
    await assertDeviceLease(db, action.deviceLease);
    const state = (await db.sync_state.get(cursorKey))?.value || { cursor: null };
    if (action.type === 'inspect') {
      const owner = (await db.sync_state.get(DEVICE_CACHE_OWNER_KEY))?.value;
      const identityMatches = Boolean(owner && state.device && owner.cursorKey === cursorKey
        && owner.clientId === state.device.clientId && owner.scope === state.device.scope);
      const canonicalCount = await db.pg_record_rows.count();
      // Auxiliary lanes only add Tower-authorized rows for this owner; builds
      // before 2462 did so without recounting. Fewer rows means lost bodies.
      const countRegressed = identityMatches && canonicalCount < Number(owner.canonicalCount || 0);
      return { state, owner, canonicalCount, identityMatches, countRegressed, cacheMatches: identityMatches && !countRegressed };
    }
    if (action.type === 'owner_count') {
      const owner = (await db.sync_state.get(DEVICE_CACHE_OWNER_KEY))?.value;
      if (!state.device || owner?.cursorKey !== cursorKey || owner.clientId !== state.device.clientId
        || owner.scope !== state.device.scope || state.device.scope !== action.scope) throw new Error('Device cache generation changed');
      await db.sync_state.put({ key: DEVICE_CACHE_OWNER_KEY, value: { ...owner, canonicalCount: await db.pg_record_rows.count() } });
      return state;
    }
    const device = state.device;
    const owner = (await db.sync_state.get(DEVICE_CACHE_OWNER_KEY))?.value;
    if (!device || device.scope !== action.scope || device.clientId !== action.clientId
      || owner?.clientId !== device.clientId || owner.scope !== device.scope
      || Number(state.localGeneration || 0) !== action.localGeneration) throw new Error('Device cache generation changed');
    if (action.type === 'registered') {
      validateCheckpoint(action.checkpoint, device);
      if (state.cursor || device.registered) return state;
      const checkpoint = action.checkpoint;
      const next = { ...state, cursor: checkpoint.initial_cursor, device: { ...device, registered: true,
        extension: action.extension || device.extension || null,
        largeRecords: action.largeRecords || device.largeRecords || null,
        authorityEpoch: checkpoint.authority_epoch, revision: checkpoint.checkpoint_revision } };
      await db.sync_state.put({ key: cursorKey, value: next });
      return next;
    }
    if (action.type === 'acknowledged') {
      validateCheckpoint(action.checkpoint, device);
      if (state.cursor !== action.cursor || device.pendingAck?.cursor !== action.cursor) throw new Error('Device acknowledgement changed');
      if (action.checkpoint.checkpoint_cursor !== action.cursor) throw new Error('Tower acknowledged a different position');
      if (BigInt(action.checkpoint.checkpoint_revision) < BigInt(device.revision)) throw new Error('Checkpoint revision regressed');
      const next = { ...state, device: { ...device, revision: action.checkpoint.checkpoint_revision, pendingAck: null } };
      await db.sync_state.put({ key: cursorKey, value: next });
      return next;
    }
    if (action.type === 'adopted') {
      validateCheckpoint(action.checkpoint, device);
      const checkpoint = action.checkpoint;
      if (!checkpoint.checkpoint_cursor || BigInt(checkpoint.checkpoint_revision) <= BigInt(device.revision)) {
        throw new Error('Invalid adopted Tower device checkpoint');
      }
      const next = { ...state, cursor: checkpoint.checkpoint_cursor, resetting: false, applyingPage: null,
        snapshotId: null, snapshotRetirement: null, snapshotReconciliationPending: false,
        snapshotComplete: true, converged: true, handover: null,
        device: { ...device, registered: true, authorityEpoch: checkpoint.authority_epoch,
          revision: checkpoint.checkpoint_revision, pendingAck: null } };
      await db.sync_state.put({ key: cursorKey, value: next });
      if (action.adoptionStateKey) {
        if (!String(action.adoptionStateKey).startsWith('record-sync-aux:')) throw new Error('Invalid cache adoption state key');
        await db.sync_state.delete(action.adoptionStateKey);
      }
      await db.sync_state.put({ key: DEVICE_CACHE_OWNER_KEY, value: { ...owner,
        cursorKey, scope: device.scope, clientId: device.clientId, canonicalCount: await db.pg_record_rows.count() } });
      return next;
    }
    if (action.type === 'retired') {
      const next = { ...state, obsoleteDevices: (state.obsoleteDevices || []).filter(d => d.clientId !== action.obsoleteClientId) };
      await db.sync_state.put({ key: cursorKey, value: next });
      return next;
    }
    throw new Error('Invalid device metadata operation');
  });
}

const discoveries = new Map();
export async function discoverRecordCapabilities(context, readService) {
  const key = deviceCheckpointScope(context);
  if (!discoveries.has(key)) {
    const pending = Promise.resolve().then(() => readService({ baseUrl: context.baseUrl, appNpub: context.appNpub }))
      .then(service => {
        const protocolVersion = service?.record_sync?.device_checkpoints === true
          && service.record_sync.protocol_versions?.includes(2) ? 2 : 1;
        return { protocolVersion, extension: protocolVersion === 2
          && service.record_sync.extensions?.includes('bounded_snapshot_v1') ? 'bounded_snapshot_v1' : null,
          largeRecords: protocolVersion === 2 && service.record_sync.extensions?.includes('bounded_snapshot_v1')
            && service.record_sync.extensions?.includes('chunked_v1') ? 'chunked_v1' : null,
          priorityFeed: service?.record_sync?.priority_feed === true,
          contextClosure: service?.record_sync?.context_closure === true,
          repairManifest: service?.record_sync?.repair_manifest === true,
          selectiveRepair: service?.record_sync?.selective_repair === true,
          cacheAdoption: service?.record_sync?.cache_adoption?.version === 1 };
      })
      .catch(error => {
        // Only absent service routes represent older servers. Authentication,
        // transport and authority failures must never silently negotiate down.
        if ([404, 406, 501].includes(error.status)) return { protocolVersion: 1, extension: null,
          priorityFeed: false, contextClosure: false, repairManifest: false, selectiveRepair: false, cacheAdoption: false };
        discoveries.delete(key);
        throw error;
      });
    discoveries.set(key, pending);
  }
  return discoveries.get(key);
}

export async function discoverRecordProtocol(context, readService) {
  return (await discoverRecordCapabilities(context, readService)).protocolVersion;
}

export function validateBoundedHandover(page, authorityEpoch) {
  const h = page.handover;
  if (!h || !(h.target_position === null || checkpointRevision(h.target_position))
    || !checkpointRevision(h.through_position) || !checkpointRevision(h.access_revision)
    || h.authority_epoch !== authorityEpoch || typeof h.complete !== 'boolean'
    || h.complete !== !page.has_more || h.complete && (page.mode !== 'delta'
      || h.target_position === null || BigInt(h.through_position) < BigInt(h.target_position))) {
    throw new Error('Invalid bounded snapshot handover');
  }
  return h;
}

export function withDeviceCacheLock(name, run, locks = globalThis.navigator?.locks) {
  if (!locks?.request) throw new Error('Device checkpoints require browser Web Locks to coordinate this cache');
  return locks.request(`flightdeck-record-cache:${name}`, { mode: 'exclusive' }, run);
}

export function recordCheckpointError(error) {
  let payload = error.payload || {};
  try { payload = JSON.parse(error.responseText || JSON.stringify(payload)); } catch {}
  return { code: error.code || payload.code || payload.error, payload };
}

export const CACHE_ADOPTION_RESTARTS = 3;
export function isRestartableAdoptionError(error) {
  const { code, payload } = recordCheckpointError(error);
  return error?.status === 409 && (String(code || '').startsWith('adoption_')
    || code === 'client_already_checkpointed' || payload?.recovery?.strategy === 'restart_cache_adoption');
}

// Network orchestration is invoked by the service's cursor recovery port;
// every mutation is dispatched to its existing worker materialisation port.
export async function syncDeviceRecords({ context, options, readState, materialize, readPage, readChunk, client, assertCurrent, cursorKey, preparePage, assertHeld = async () => {} }) {
  const scope = deviceCheckpointScope(context);
  const transport = { baseUrl: context.baseUrl, appNpub: context.appNpub, timeoutMs: options.timeoutMs || 30000, diagnosticOperation: options.diagnosticOperation };
  let state = await readState(cursorKey);
  const inspection = await materialize({ protocol_version: 2, device_action: { type: 'inspect' } });
  state = inspection.state;
  if (state?.device?.extension && state.device.scope === scope && state.device.extension !== options.extension) throw new Error('Negotiated record sync extension is unavailable');
  if (state?.device?.largeRecords && state.device.scope === scope && state.device.largeRecords !== options.largeRecords) throw new Error('Negotiated large record extension is unavailable');
  await materialize({ protocol_version: 2, large_record_action: { type: 'discard' } });
  let applied = 0, resets = 0, repairAttempted = false;
  let cachedRows = Number(inspection.canonicalCount || 0);
  const update = async action => {
    assertCurrent();
    state = await materialize({ protocol_version: 2, device_action: { ...action, scope,
      clientId: state.device.clientId, localGeneration: Number(state.localGeneration || 0) } });
    assertCurrent();
  };
  const replace = async (preserveViews, accessLost = false, newDeviceIdentity = false) => {
    assertCurrent();
    await materialize({ protocol_version: 2, reset_authority: true, local_apply_options: {
      preserveViews, accessLost, expectedCursor: state?.cursor || null, expectedGeneration: Number(state?.localGeneration || 0), deviceScope: scope,
      newDeviceIdentity,
    } });
    if (!preserveViews) cachedRows = 0;
    state = await readState(cursorKey);
  };
  // Keep this device's identity only when its retained rows will be adopted.
  // Without adoption a reused id would re-snapshot behind Tower's committed
  // checkpoint, so that fallback still registers a fresh cache.
  const recover = (identityBoundary = false) => replace(true, false,
    identityBoundary || !(options.cacheAdoption === true && cachedRows > 0));
  const ownedHere = state?.device && state.device.scope === scope && canonicalClientId(state.device.clientId);
  if (ownedHere && inspection.countRegressed && typeof options.repair === 'function') {
    // Rows below the committed owner count were lost locally. Restore only the
    // missing/stale bodies from the manifest and keep the durable checkpoint.
    options.onProgress?.({ stage: 'repairing', recoveryReason: 'cache_count_regressed', applied: 0,
      cursorPresent: Boolean(state.cursor), mode: 'unavailable', protocolVersion: 2 });
    await options.repair({ reason: 'cache_count_regressed', cursor: state.cursor });
    assertCurrent();
    inspection.cacheMatches = true;
  }
  if (ownedHere && inspection.cacheMatches) {
    state = await materialize({ protocol_version: 2, device_action: { type: 'owner_count', scope } });
  }
  if (!inspection.cacheMatches || !ownedHere) {
    // Adoption replaces the authoritative snapshot, never upgrades a v1 cursor.
    // An unrelated authority must be hidden, whereas the same cache's v1 views
    // remain available until the replacement's snapshot handover completes.
    // A v1 fallback reset records an owner without a device scope for this
    // same cache; it remains the same physical cache, not another identity.
    const sameOwner = !inspection.owner || inspection.owner.scope === scope
      || (inspection.owner.scope == null && inspection.owner.cursorKey === cursorKey);
    await replace(sameOwner && (!state?.device || state.device.scope === scope), false,
      !(options.cacheAdoption === true && cachedRows > 0));
  }
  // Interrupted prefixes keep the preceding opaque cursor. Tower may repin a
  // completed round on replay; older clients also saved that prefix's target.
  // Re-authorize through a fresh snapshot instead of accepting target drift.
  if (options.extension === 'bounded_snapshot_v1' && state.applyingPage) await recover();
  const retireObsolete = async () => {
    for (const obsolete of state.obsoleteDevices || []) {
      if (obsolete.scope !== scope || obsolete.clientId === state.device.clientId || !canonicalClientId(obsolete.clientId)) continue;
      assertCurrent();
      await client(context.workspaceId, obsolete.clientId, { ...transport, operation: 'retire' });
      await update({ type: 'retired', obsoleteClientId: obsolete.clientId });
    }
  };
  const acknowledge = async () => {
    const intent = state.device.pendingAck;
    if (!intent) return;
    await assertHeld();
    assertCurrent();
    try {
      const checkpoint = await client(context.workspaceId, state.device.clientId, { ...transport,
        operation: 'ack', cursor: intent.cursor, expectedRevision: intent.expectedRevision, largeRecordReceipts: intent.largeRecordReceipts });
      await update({ type: 'acknowledged', cursor: intent.cursor, checkpoint });
    } catch (error) {
      const { code } = recordCheckpointError(error);
      if (!['checkpoint_conflict', 'checkpoint_regression'].includes(code)) throw error;
      options.onProgress?.({ stage: 'recovery', recoveryReason: code, applied, cursorPresent: Boolean(state.cursor), mode: 'unavailable', protocolVersion: 2 });
      // Read is diagnostic/revision evidence only. The next page MUST still
      // start at the locally committed cursor. It replaces durable ack intent.
      validateCheckpoint(await client(context.workspaceId, state.device.clientId, { ...transport, operation: 'read' }), state.device);
      assertCurrent();
      // A manifest token cannot be bypassed by fetching a dependent page. A
      // non-idempotent checkpoint conflict repairs through a fresh snapshot;
      // never promote the diagnostic server checkpoint into local data.
      if (intent.largeRecordReceipts?.length) throw Object.assign(new Error('Large record checkpoint needs authorised repair'), { status: 409, code: 'reset_required' });
    }
  };
  // Adoption failures restart adoption with a fresh session; they never escalate
  // to a snapshot or another device id. A checkpoint race rebases onto the
  // server revision of this same client.
  const adoptCache = async () => {
    let expectedCheckpointRevision = state.device.revision;
    for (let attempt = 0; ; attempt++) {
      try {
        return await options.adopt({ clientId: state.device.clientId, expectedCheckpointRevision, restart: attempt > 0 });
      } catch (error) {
        if (!isRestartableAdoptionError(error) || attempt >= CACHE_ADOPTION_RESTARTS) throw error;
        const { code } = recordCheckpointError(error);
        options.onProgress?.({ stage: 'recovery', recoveryReason: code, applied, cursorPresent: Boolean(state.cursor),
          mode: 'adoption', fullSnapshot: false, protocolVersion: 2 });
        await new Promise(resolve => setTimeout(resolve, Math.min(4000, (options.adoptionBackoffMs ?? 250) * 2 ** attempt)));
        assertCurrent();
        const checkpoint = validateCheckpoint(await client(context.workspaceId, state.device.clientId, { ...transport, operation: 'read' }), state.device);
        expectedCheckpointRevision = checkpoint.checkpoint_revision;
      }
    }
  };
  const settleDeferred = async () => {
    if (typeof options.repairDeferred !== 'function') return;
    try { await options.repairDeferred(); }
    catch (error) {
      // Deferred identities stay durable for the next sync; they never block delta.
      options.onProgress?.({ stage: 'repair-deferred-paused', error: error?.message || String(error), applied,
        cursorPresent: Boolean(state.cursor), mode: 'unavailable', protocolVersion: 2 });
    }
  };
  let deferredSettled = false;
  for (let pages = 1; pages <= (options.maxPages || 1000); pages++) {
    try {
      if (!state.device.registered) {
        const checkpoint = validateCheckpoint(await client(context.workspaceId, state.device.clientId,
          { ...transport, operation: 'register' }), state.device);
        await update({ type: 'registered', checkpoint, extension: options.extension, largeRecords: options.largeRecords });
      }
      // Any position that would download a snapshot over a populated cache —
      // a reset, an interrupted snapshot or a not-yet-converged registration —
      // is replaced by adoption of the rows this device already holds.
      const adoptionNeeded = options.cacheAdoption === true && cachedRows > 0
        && (state.resetting === true || state.snapshotReconciliationPending === true
          || (!state.converged && state.device.revision === '0'));
      if (adoptionNeeded) {
        if (typeof options.adopt !== 'function') throw new Error('Tower advertised cache adoption without a client implementation');
        options.onProgress?.({ stage: 'verifying-cache', page: pages, applied, cursorPresent: Boolean(state.cursor),
          mode: 'adoption', fullSnapshot: false, protocolVersion: 2 });
        const adopted = await adoptCache();
        await update({ type: 'adopted', checkpoint: adopted.checkpoint, adoptionStateKey: adopted.stateKey });
        deferredSettled = false;
      }
      if (!deferredSettled) { deferredSettled = true; await settleDeferred(); }
      await retireObsolete();
      if (state.snapshotRetirement) {
        await materialize({ protocol_version: 2, resume_snapshot_retirement: true, local_apply_options: {
          expectedGeneration: Number(state.localGeneration || 0), terminalCursor: state.snapshotRetirement.nextCursor,
        } });
        state = await readState(cursorKey);
      }
      await acknowledge();
      options.onProgress?.({ stage: 'receiving', page: pages, applied, cursorPresent: Boolean(state.cursor), mode: 'unavailable', protocolVersion: 2 });
      const requested = { cursor: state.cursor, clientId: state.device.clientId, generation: state.localGeneration, accessLost: Boolean(state.accessLost) };
      const page = await readPage(context.workspaceId, { ...transport, protocolVersion: 2,
        extension: options.extension, largeRecords: options.largeRecords, clientId: requested.clientId, cursor: requested.cursor, limit: options.limit || 200 });
      assertCurrent();
      const current = await readState(cursorKey);
      if (current?.device?.scope !== scope || current.device.clientId !== requested.clientId
        || current.cursor !== requested.cursor || current.localGeneration !== requested.generation) throw new Error('Stale device page response');
      if (page.protocol_version !== 2 || page.client_id !== requested.clientId
        || !checkpointRevision(page.checkpoint_revision) || page.has_more && page.next_cursor === requested.cursor) throw new Error('Invalid negotiated device page');
      if (options.extension === 'bounded_snapshot_v1') validateBoundedHandover(page, state.device.authorityEpoch);
      if (page.large_records?.length && options.largeRecords !== 'chunked_v1') throw new Error('Unnegotiated large record manifest');
      options.onProgress?.({ stage: 'applying', page: pages, applied, cursorPresent: Boolean(state.cursor), mode: page.mode, fullSnapshot: page.mode === 'snapshot', hasMore: page.has_more === true, protocolVersion: 2 });
      await preparePage?.(page, state);
      const applyOptions = {
        expectedCursor: requested.cursor, expectedGeneration: Number(requested.generation || 0), expectedAccessLost: requested.accessLost,
        deviceScope: scope, authorityEpoch: state.device.authorityEpoch, incrementalSnapshot: true,
        boundedExtension: options.extension,
        largeRecords: options.largeRecords,
        viewBaselineInitialized: true,
      };
      let result;
      if (page.large_records?.length) {
        try {
          const assembly = await materialize({ protocol_version: 2, large_record_action: { type: 'begin', page }, local_apply_options: applyOptions });
          for (let index = 0; index < assembly.chunks; index++) {
            await assertHeld(); assertCurrent();
            const bytes = await readChunk(context.workspaceId, requested.clientId, page.next_cursor, page.large_records[0].manifest_id, index, transport);
            assertCurrent();
            await materialize({ protocol_version: 2, large_record_action: { type: 'chunk', index, bytes }, local_apply_options: applyOptions });
          }
          result = await materialize({ protocol_version: 2, large_record_action: { type: 'finish' }, local_apply_options: applyOptions });
        } catch (error) {
          await materialize({ protocol_version: 2, large_record_action: { type: 'discard' } }).catch(() => {});
          throw error;
        }
      } else result = await materialize({ ...page, local_apply_options: applyOptions });
      assertCurrent();
      applied += result.applied;
      state = await readState(cursorKey);
      await acknowledge();
      if (!result.hasMore && !state.device.pendingAck) {
        if (result.needsSummaryBackfill) await materialize({ protocol_version: 2, rebuild_summaries: true });
        options.onProgress?.({ stage: 'complete', page: pages, applied, cursorPresent: Boolean(state.cursor), mode: page.mode, fullSnapshot: page.mode === 'snapshot', hasMore: false, protocolVersion: 2 });
        return { ...result, applied, pages, protocolVersion: 2, clientId: state.device.clientId, checkpointRevision: state.device.revision };
      }
    } catch (error) {
      const { code, payload } = recordCheckpointError(error);
      const revoked = error.status === 403 && ['workspace_membership_required', 'record_access_required'].includes(code)
        && (!payload.identity?.workspace_id || payload.identity.workspace_id === context.workspaceId);
      const reset = error.status === 409 && ['reset_required', 'history_pruned', 'client_expired', 'client_not_registered', 'page_token_invalid', 'large_record_changed', 'large_record_ack_required'].includes(code);
      if (!revoked && !reset) throw error;
      if (revoked) {
        assertCurrent();
        await materialize({ protocol_version: 2, access_lost: true, local_apply_options: {
          expectedCursor: state.cursor, expectedGeneration: Number(state.localGeneration || 0),
        } });
        throw error;
      }
      options.onProgress?.({ stage: 'recovery', recoveryReason: code, page: pages, applied, cursorPresent: Boolean(state.cursor), mode: 'unavailable', protocolVersion: 2 });
      // Tower's authority-epoch change is an identity boundary: rows stay
      // visible until handover, but the device registers as a new cache. A
      // locally raised reset_required (large-record repair) is not.
      const identityBoundary = code === 'reset_required' && (payload?.error === 'reset_required' || payload?.code === 'reset_required');
      if (options.cacheAdoption === true && cachedRows > 0) {
        // Recover the populated cache through adoption under the same id.
        await recover(identityBoundary);
        if (++resets > 2) throw error;
        continue;
      }
      if (!repairAttempted && typeof options.repair === 'function') {
        repairAttempted = true;
        options.onProgress?.({ stage: 'repairing', recoveryReason: code, page: pages, applied,
          cursorPresent: Boolean(state.cursor), mode: 'unavailable', protocolVersion: 2 });
        await options.repair({ reason: code, cursor: state.cursor });
        // Repair never advances or substitutes the v2 checkpoint. Retry the
        // same durable position once before considering replacement snapshot.
        continue;
      }
      await recover(identityBoundary);
      if (revoked || ++resets > 2) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Tower device sync exceeded the maximum page count');
}

const DEVICE_LEASE_KEY = 'record-device-cache-lease';
const DEVICE_LEASE_MS = 120_000;
export async function commitDeviceLease(action) {
  const db = getWorkspaceDb();
  return db.transaction('rw', db.sync_state, async () => {
    const prior = (await db.sync_state.get(DEVICE_LEASE_KEY))?.value;
    const now = Date.now();
    if (action.type === 'acquire') {
      if (prior && prior.expiresAt > now && prior.token !== action.token) return false;
      await db.sync_state.put({ key: DEVICE_LEASE_KEY, value: { token: action.token, expiresAt: now + DEVICE_LEASE_MS } });
      return true;
    }
    if (!prior || prior.token !== action.token || prior.expiresAt <= now) throw new Error('Device cache lease lost');
    if (action.type === 'release') await db.sync_state.delete(DEVICE_LEASE_KEY);
    else if (action.type === 'renew') await db.sync_state.put({ key: DEVICE_LEASE_KEY, value: { ...prior, expiresAt: now + DEVICE_LEASE_MS } });
    else if (action.type !== 'check') throw new Error('Invalid device lease operation');
    return true;
  });
}
export async function assertDeviceLease(db, token) {
  if (!token) return;
  const lease = (await db.sync_state.get(DEVICE_LEASE_KEY))?.value;
  if (lease?.token !== token || lease.expiresAt <= Date.now()) throw new Error('Device cache lease lost before commit');
}

// FIPS HTTP/native browser contexts may not expose Web Locks. A worker-owned
// IndexedDB lease then serializes the same physical cache across tabs. Fencing
// at EVERY bounded commit rejects a paused owner's late network responses.
export async function withWorkerDeviceLease(materialize, assertCurrent, run) {
  const token = createDeviceCacheId();
  while (true) {
    assertCurrent();
    if (await materialize({ device_lock: { type: 'acquire', token } })) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  let lost = null;
  const heartbeat = setInterval(() => {
    void materialize({ device_lock: { type: 'renew', token } }).catch(error => { lost = error; });
  }, DEVICE_LEASE_MS / 4);
  const assertHeld = async () => {
    assertCurrent();
    if (lost) throw lost;
    await materialize({ device_lock: { type: 'check', token } });
  };
  try { return await run({ token, assertHeld }); }
  finally {
    clearInterval(heartbeat);
    await materialize({ device_lock: { type: 'release', token } }).catch(() => {});
  }
}
