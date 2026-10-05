import { getWorkspaceDb } from './db.js';

export const canonicalClientId = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
export const checkpointRevision = value => typeof value === 'string' && /^\d+$/.test(value);
export const DEVICE_CACHE_OWNER_KEY = 'record-device-cache-owner';
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
      return { state, owner, cacheMatches: Boolean(owner && state.device && owner.cursorKey === cursorKey
        && owner.clientId === state.device.clientId && owner.scope === state.device.scope
        && owner.canonicalCount === await db.pg_record_rows.count()) };
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
    if (action.type === 'retired') {
      const next = { ...state, obsoleteDevices: (state.obsoleteDevices || []).filter(d => d.clientId !== action.obsoleteClientId) };
      await db.sync_state.put({ key: cursorKey, value: next });
      return next;
    }
    throw new Error('Invalid device metadata operation');
  });
}

const discoveries = new Map();
export async function discoverRecordProtocol(context, readService) {
  const key = deviceCheckpointScope(context);
  if (!discoveries.has(key)) {
    const pending = Promise.resolve().then(() => readService({ baseUrl: context.baseUrl, appNpub: context.appNpub }))
      .then(service => service?.record_sync?.device_checkpoints === true
        && service.record_sync.protocol_versions?.includes(2) ? 2 : 1)
      .catch(error => {
        // Only absent service routes represent older servers. Authentication,
        // transport and authority failures must never silently negotiate down.
        if ([404, 406, 501].includes(error.status)) return 1;
        discoveries.delete(key);
        throw error;
      });
    discoveries.set(key, pending);
  }
  return discoveries.get(key);
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

// Network orchestration is invoked by the service's cursor recovery port;
// every mutation is dispatched to its existing worker materialisation port.
export async function syncDeviceRecords({ context, options, readState, materialize, readPage, client, assertCurrent, cursorKey, preparePage, assertHeld = async () => {} }) {
  const scope = deviceCheckpointScope(context);
  const transport = { baseUrl: context.baseUrl, appNpub: context.appNpub, timeoutMs: options.timeoutMs || 30000 };
  let state = await readState(cursorKey);
  const inspection = await materialize({ protocol_version: 2, device_action: { type: 'inspect' } });
  state = inspection.state;
  let applied = 0, resets = 0;
  const update = async action => {
    assertCurrent();
    state = await materialize({ protocol_version: 2, device_action: { ...action, scope,
      clientId: state.device.clientId, localGeneration: Number(state.localGeneration || 0) } });
    assertCurrent();
  };
  const replace = async preserveViews => {
    assertCurrent();
    await materialize({ protocol_version: 2, reset_authority: true, local_apply_options: {
      preserveViews, expectedCursor: state?.cursor || null, expectedGeneration: Number(state?.localGeneration || 0), deviceScope: scope,
    } });
    state = await readState(cursorKey);
  };
  if (!inspection.cacheMatches || !state?.device || state.device.scope !== scope || !canonicalClientId(state.device.clientId)) {
    // Adoption replaces the authoritative snapshot, never upgrades a v1 cursor.
    // An unrelated authority must be hidden, whereas the same cache's v1 views
    // remain available until the replacement's snapshot handover completes.
    await replace(!state?.device && (!inspection.owner || inspection.owner.scope === scope));
  }
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
        operation: 'ack', cursor: intent.cursor, expectedRevision: intent.expectedRevision });
      await update({ type: 'acknowledged', cursor: intent.cursor, checkpoint });
    } catch (error) {
      const { code } = recordCheckpointError(error);
      if (!['checkpoint_conflict', 'checkpoint_regression'].includes(code)) throw error;
      // Read is diagnostic/revision evidence only. The next page MUST still
      // start at the locally committed cursor. It replaces durable ack intent.
      validateCheckpoint(await client(context.workspaceId, state.device.clientId, { ...transport, operation: 'read' }), state.device);
      assertCurrent();
    }
  };
  for (let pages = 1; pages <= (options.maxPages || 1000); pages++) {
    try {
      await retireObsolete();
      if (!state.device.registered) {
        const checkpoint = validateCheckpoint(await client(context.workspaceId, state.device.clientId,
          { ...transport, operation: 'register' }), state.device);
        await update({ type: 'registered', checkpoint });
      }
      if (state.snapshotRetirement) {
        await materialize({ protocol_version: 2, resume_snapshot_retirement: true, local_apply_options: {
          expectedGeneration: Number(state.localGeneration || 0), terminalCursor: state.snapshotRetirement.nextCursor,
        } });
        state = await readState(cursorKey);
      }
      await acknowledge();
      options.onProgress?.({ stage: 'receiving', page: pages, applied, cursorPresent: true });
      const requested = { cursor: state.cursor, clientId: state.device.clientId, generation: state.localGeneration };
      const page = await readPage(context.workspaceId, { ...transport, protocolVersion: 2,
        clientId: requested.clientId, cursor: requested.cursor, limit: options.limit || 200 });
      assertCurrent();
      const current = await readState(cursorKey);
      if (current?.device?.scope !== scope || current.device.clientId !== requested.clientId
        || current.cursor !== requested.cursor || current.localGeneration !== requested.generation) throw new Error('Stale device page response');
      if (page.protocol_version !== 2 || page.client_id !== requested.clientId
        || !checkpointRevision(page.checkpoint_revision) || page.has_more && page.next_cursor === requested.cursor) throw new Error('Invalid negotiated device page');
      options.onProgress?.({ stage: 'applying', page: pages, applied });
      await preparePage?.(page, state);
      const result = await materialize({ ...page, local_apply_options: {
        expectedCursor: requested.cursor, expectedGeneration: Number(requested.generation || 0),
        deviceScope: scope, authorityEpoch: state.device.authorityEpoch, incrementalSnapshot: true,
        viewBaselineInitialized: true,
      } });
      assertCurrent();
      applied += result.applied;
      state = await readState(cursorKey);
      await acknowledge();
      if (!result.hasMore && !state.device.pendingAck) {
        if (result.needsSummaryBackfill) await materialize({ protocol_version: 2, rebuild_summaries: true });
        options.onProgress?.({ stage: 'complete', page: pages, applied });
        return { ...result, applied, pages, protocolVersion: 2, clientId: state.device.clientId, checkpointRevision: state.device.revision };
      }
    } catch (error) {
      const { code, payload } = recordCheckpointError(error);
      const revoked = error.status === 403 && code === 'workspace_membership_required'
        && (!payload.identity?.workspace_id || payload.identity.workspace_id === context.workspaceId);
      const reset = error.status === 409 && ['reset_required', 'history_pruned', 'client_expired', 'client_not_registered', 'page_token_invalid'].includes(code);
      if (!revoked && !reset) throw error;
      await replace(false);
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
  const token = crypto.randomUUID();
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
