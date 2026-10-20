import { getWorkspaceDb } from './db.js';
import {
  getTowerPgRecordContext,
  getTowerPgRecordPriority,
  getTowerPgRecordRepairManifest,
  postTowerPgRecordAdoption,
  postTowerPgRecordRepair,
} from './api.js';

export const PRIORITY_RECENT_LIMIT = 32;
export const AUXILIARY_MATERIALIZE_BATCH = 32;

export function auxiliarySyncKey(store, lane) {
  const owner = String(store?.workspaceDbKey || store?.workspaceOwnerNpub || store?.currentWorkspace?.workspaceId || '').trim();
  return `record-sync-aux:${owner}:${lane}`;
}

export async function commitAuxiliarySyncState(action) {
  const db = getWorkspaceDb();
  const key = String(action?.key || '').trim();
  if (!key.startsWith('record-sync-aux:')) throw new Error('Invalid auxiliary sync state key');
  if (action.type === 'read') return (await db.sync_state.get(key))?.value || null;
  if (action.type === 'delete') {
    await db.sync_state.delete(key);
    return null;
  }
  if (action.type !== 'put' || !action.value || typeof action.value !== 'object') throw new Error('Invalid auxiliary sync state action');
  await db.sync_state.put({ key, value: action.value });
  return action.value;
}

async function readState(store, lane, deps) {
  const key = auxiliarySyncKey(store, lane);
  if (deps.readState) return deps.readState(key);
  return (await getWorkspaceDb().sync_state.get(key))?.value || null;
}

async function writeState(store, lane, value, deps) {
  const action = { type: 'put', key: auxiliarySyncKey(store, lane), value };
  if (deps.materialize) return deps.materialize({ protocol_version: 1, auxiliary_sync_action: action });
  return commitAuxiliarySyncState(action);
}

async function pgFamilies() {
  return (await import('./pg-record-delta.js')).PG_RECORD_DELTA_FAMILIES;
}

export async function materializeAuxiliaryChanges(store, changes, deps = {}) {
  if (!Array.isArray(changes) || changes.length === 0) return { applied: 0 };
  const context = deps.context;
  const workspaceId = String(context?.workspaceId || store?.currentWorkspace?.workspaceId || '').trim();
  const bundle = {
    protocol_version: 1,
    mode: 'delta',
    families: await pgFamilies(),
    changes,
    actors: [],
    next_cursor: `auxiliary-${Date.now()}`,
    has_more: false,
    snapshot_id: null,
    materialization_priority: deps.materializationPriority || 'background',
    local_apply_options: { reconcileOnly: true, batchSize: AUXILIARY_MATERIALIZE_BATCH,
      ...(Array.isArray(deps.reconcileKeys) ? { reconcileKeys: deps.reconcileKeys } : {}) },
  };
  if (changes.some(change => change.workspace_id !== workspaceId)) throw new Error('Auxiliary sync response belongs to another workspace');
  if (deps.materialize) return deps.materialize(bundle);
  const { hydrateTowerPgSyncBundle } = await import('./pg-read-hydrator.js');
  return hydrateTowerPgSyncBundle(store, bundle);
}

function transport(context, options = {}) {
  return {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    timeoutMs: options.timeoutMs || 30_000,
    diagnosticOperation: options.diagnosticOperation,
  };
}

function pausedState(prior, lane, error) {
  return {
    ...prior,
    lane,
    status: 'paused',
    pausedAt: Date.now(),
    pauseReason: error?.code || error?.message || 'unavailable',
  };
}

export async function hydratePriorityContext(store, resourceType, resourceId, options = {}, deps = {}) {
  const context = deps.context;
  const lane = `context:${resourceType}:${resourceId}`;
  const prior = await readState(store, lane, deps);
  if (prior?.status === 'complete' && options.force !== true
    && Date.now() - Number(prior.completedAt || 0) < Number(options.freshMs ?? 15_000)) return { fresh: true, ...prior };
  try {
    const page = await (deps.readContext || getTowerPgRecordContext)(context.workspaceId, resourceType, resourceId, transport(context, options));
    const result = await materializeAuxiliaryChanges(store, page.changes || [], {
      ...deps, context, materializationPriority: 'foreground',
    });
    const next = { lane, status: 'complete', resourceType, resourceId, capturedHead: page.captured_head,
      dependencies: page.dependencies || [], applied: result.applied || 0, completedAt: Date.now() };
    await writeState(store, lane, next, deps);
    return next;
  } catch (error) {
    await writeState(store, lane, pausedState(prior, lane, error), deps).catch(() => {});
    throw error;
  }
}

export async function runPriorityLane(store, options = {}, deps = {}) {
  const context = deps.context;
  const lane = 'priority';
  const prior = await readState(store, lane, deps);
  const resume = options.resume === true && ['pending', 'paused'].includes(prior?.status) && prior.cursor;
  const cursor = resume ? prior.cursor : null;
  const retainedCursor = !resume && ['pending', 'paused'].includes(prior?.status) ? prior.cursor : null;
  const limit = cursor ? Math.min(200, Math.max(PRIORITY_RECENT_LIMIT, Number(options.limit) || 200)) : PRIORITY_RECENT_LIMIT;
  try {
    const page = await (deps.readPriority || getTowerPgRecordPriority)(context.workspaceId, {
      ...transport(context, options), cursor, limit, filters: options.filters || {},
    });
    const result = await materializeAuxiliaryChanges(store, page.changes || [], { ...deps, context });
    // A fresh short band always wins the first network slot, but it must not
    // discard a continuation interrupted by reload/suspension. Resume that
    // older captured head next; completeness independently covers any overlap.
    const nextCursor = retainedCursor || (page.has_more ? page.next_cursor : null);
    const next = { lane, status: nextCursor ? 'pending' : 'complete', cursor: nextCursor,
      capturedHead: page.captured_head, coverage: page.coverage, retentionPolicy: page.retention_policy,
      returned: Number(prior?.returned || 0) + (page.changes?.length || 0), applied: Number(prior?.applied || 0) + Number(result.applied || 0),
      updatedAt: Date.now(), completedAt: nextCursor ? null : Date.now() };
    await writeState(store, lane, next, deps);
    await writeState(store, 'queue', { status: 'ready', updatedAt: Date.now(), items: [
      ...(nextCursor ? [{ lane: 'priority', cursor: nextCursor }] : []),
      { lane: 'completeness', durable: true },
    ] }, deps);
    return next;
  } catch (error) {
    await writeState(store, lane, pausedState(prior, lane, error), deps).catch(() => {});
    throw error;
  }
}

function manifestMismatch(local, entry) {
  if (!local) return true;
  if (String(local.version || '') !== String(entry.version || '')) return true;
  return (local.operation === 'delete') !== (entry.state === 'deleted');
}

function adoptionInventory(entries, rows) {
  return entries.map((entry, index) => {
    const local = rows[index];
    if (!local) return { family: entry.family, id: entry.id, state: 'missing' };
    return { family: entry.family, id: entry.id,
      state: local.operation === 'delete' ? 'deleted' : 'active', version: String(local.version) };
  });
}

function validateAdoptionResponse(response, clientId) {
  if (response?.protocol_version !== 2 || !['inventory_required', 'repair_required', 'adopted'].includes(response.status)
    || !response.adoption_id || !response.captured_head || !response.authority_epoch
    || !String(response.checkpoint_revision || '').match(/^\d+$/)) throw new Error('Invalid Tower cache adoption response');
  const rows = response.status === 'inventory_required' ? response.challenge
    : response.status === 'repair_required' ? response.records : [];
  if (!Array.isArray(rows) || rows.length > 200 || rows.some(entry => !entry?.family || !entry?.id
    || !['active', 'deleted'].includes(entry.state) || !String(entry.version || '').match(/^\d+$/))) {
    throw new Error('Invalid Tower cache adoption challenge');
  }
  if (response.status !== 'adopted' && !response.cursor) throw new Error('Invalid Tower cache adoption cursor');
  if (response.status === 'adopted' && (response.checkpoint?.protocol_version !== 2
    || response.checkpoint.client_id !== clientId || !response.checkpoint.initial_cursor
    || !response.checkpoint.checkpoint_cursor || !response.checkpoint.authority_epoch
    || !String(response.checkpoint.checkpoint_revision || '').match(/^\d+$/))) {
    throw new Error('Invalid Tower cache adoption checkpoint');
  }
  return response;
}

export async function runCacheAdoption(store, options = {}, deps = {}) {
  const context = deps.context;
  const lane = 'adoption';
  const clientId = String(options.clientId || '').trim();
  const expectedRevision = String(options.expectedCheckpointRevision || '');
  if (!clientId || !/^\d+$/.test(expectedRevision)) throw new Error('Cache adoption requires a registered device checkpoint');
  let prior = await readState(store, lane, deps);
  if (prior?.clientId !== clientId || prior?.expectedRevision !== expectedRevision) prior = null;
  const readRows = async entries => {
    const keys = entries.map(entry => `${entry.family}:${entry.id}`);
    return deps.readCanonicalRows ? deps.readCanonicalRows(keys) : getWorkspaceDb().pg_record_rows.bulkGet(keys);
  };
  const adopt = body => (deps.adopt || postTowerPgRecordAdoption)(context.workspaceId, clientId, body, transport(context, options));
  let response = prior?.response || null;
  const requestId = prior?.requestId || options.requestId || globalThis.crypto.randomUUID();
  try {
    if (!response) {
      let manifestCursor = prior?.manifestCursor || null;
      if (!manifestCursor) {
        const manifest = await (deps.readManifest || getTowerPgRecordRepairManifest)(context.workspaceId, {
          ...transport(context, options), limit: 200, filters: {},
        });
        if (!manifest?.next_cursor || manifest.coverage !== 'authorized_manifest') throw new Error('Tower did not provide an adoptable cache manifest');
        manifestCursor = manifest.next_cursor;
      }
      // Persist the idempotency key and captured manifest cursor before the
      // first POST. A lost response or reload must resume the same server
      // adoption session rather than consume another bounded session slot.
      prior = { lane, status: 'pending', clientId, expectedRevision, requestId,
        manifestCursor, response: null, updatedAt: Date.now() };
      await writeState(store, lane, prior, deps);
      options.onProgress?.({ stage: 'verifying-cache', mode: 'adoption', fullSnapshot: false });
      response = validateAdoptionResponse(await adopt({ request_id: requestId, manifest_cursor: manifestCursor,
        expected_checkpoint_revision: expectedRevision }), clientId);
      prior = { ...prior, response, updatedAt: Date.now() };
      await writeState(store, lane, prior, deps);
    }
    for (let steps = 0; steps < (options.maxSteps || 10_000); steps++) {
      if (response.status === 'adopted') {
        const complete = { ...prior, status: 'complete', response, capturedHead: response.captured_head,
          checkpointRevision: response.checkpoint.checkpoint_revision, completedAt: Date.now(), updatedAt: Date.now(),
          stateKey: auxiliarySyncKey(store, lane) };
        // The caller commits this checkpoint and deletes stateKey in the same
        // Dexie transaction. Until then the terminal response remains durable
        // here and is safe to replay after a crash.
        return { ...complete, checkpoint: response.checkpoint };
      }
      if (response.status === 'inventory_required') {
        options.onProgress?.({ stage: 'verifying-cache', mode: 'adoption', fullSnapshot: false,
          checked: Number(prior?.checked || 0), challenge: response.challenge.length });
        const inventory = adoptionInventory(response.challenge, await readRows(response.challenge));
        response = validateAdoptionResponse(await adopt({ cursor: response.cursor, inventory }), clientId);
        prior = { ...prior, checked: Number(prior?.checked || 0) + inventory.length };
      } else {
        const records = response.records;
        options.onProgress?.({ stage: 'repairing-cache', mode: 'adoption', fullSnapshot: false,
          repairing: records.length });
        const repair = await (deps.repair || postTowerPgRecordRepair)(context.workspaceId,
          records.map(({ family, id, version }) => ({ family, id, version })), transport(context, options));
        await materializeAuxiliaryChanges(store, repair.changes || [], { ...deps, context,
          reconcileKeys: records.map(({ family, id }) => `${family}:${id}`) });
        const repaired = adoptionInventory(records, await readRows(records));
        if (repaired.some(entry => entry.state === 'missing')) throw new Error('Tower cache adoption repair did not materialize every mismatch');
        response = validateAdoptionResponse(await adopt({ cursor: response.cursor, repaired }), clientId);
      }
      prior = { ...prior, lane, status: 'pending', clientId, expectedRevision, requestId,
        response, capturedHead: response.captured_head, updatedAt: Date.now() };
      await writeState(store, lane, prior, deps);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Tower cache adoption exceeded the maximum step count');
  } catch (error) {
    await writeState(store, lane, { ...prior, lane, status: 'paused', clientId, expectedRevision,
      requestId, response, pausedAt: Date.now(), pauseReason: error?.code || error?.message || 'unavailable' }, deps).catch(() => {});
    throw error;
  }
}

export async function runManifestRepair(store, options = {}, deps = {}) {
  const context = deps.context;
  const lane = 'manifest';
  let prior = await readState(store, lane, deps);
  let cursor = options.resume === false ? null : ['pending', 'paused'].includes(prior?.status) ? prior.cursor : null;
  const initialChecked = Number(prior?.checked || 0);
  const initialRepaired = Number(prior?.repaired || 0);
  let checked = 0, repaired = 0, pages = 0;
  try {
    do {
      const page = await (deps.readManifest || getTowerPgRecordRepairManifest)(context.workspaceId, {
        ...transport(context, options), cursor, limit: 200, filters: options.filters || {},
      });
      const keys = (page.entries || []).map(entry => `${entry.family}:${entry.id}`);
      const localRows = deps.readCanonicalRows
        ? await deps.readCanonicalRows(keys)
        : await getWorkspaceDb().pg_record_rows.bulkGet(keys);
      const mismatches = (page.entries || []).filter((entry, index) => manifestMismatch(localRows[index], entry));
      if (mismatches.length) {
        const repair = await (deps.repair || postTowerPgRecordRepair)(context.workspaceId,
          mismatches.map(entry => ({ family: entry.family, id: entry.id, version: entry.version })), transport(context, options));
        const result = await materializeAuxiliaryChanges(store, repair.changes || [], { ...deps, context,
          reconcileKeys: mismatches.map(({ family, id }) => `${family}:${id}`) });
        repaired += Number(result.applied || 0);
      }
      checked += page.entries?.length || 0;
      pages += 1;
      cursor = page.has_more ? page.next_cursor : null;
      prior = { lane, status: page.has_more ? 'pending' : 'complete', cursor, capturedHead: page.captured_head,
        checked: initialChecked + checked, repaired: initialRepaired + repaired,
        updatedAt: Date.now(), completedAt: page.has_more ? null : Date.now() };
      await writeState(store, lane, prior, deps);
      if (page.has_more) await new Promise(resolve => setTimeout(resolve, 0));
    } while (cursor && pages < (options.maxPages || 1000));
    if (cursor) throw new Error('Repair manifest exceeded the maximum page count');
    return { ...prior, checked, repaired, pages };
  } catch (error) {
    await writeState(store, lane, pausedState(prior, lane, error), deps).catch(() => {});
    throw error;
  }
}
