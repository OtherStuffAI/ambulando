import {
  acquireTowerPgEditLease,
  getTowerPgEditLease,
  releaseTowerPgEditLease,
  renewTowerPgEditLease,
} from './api.js';
import { resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';

export const DOCUMENT_EDIT_PROTOCOL = 'document_edit_session_v1';

export const PG_SYNCED_OFFLINE_EDIT_MESSAGE = 'Reconnect to edit this synced Tower PG record.';
export const PG_EDIT_CONFLICT_MESSAGE = 'Another actor is editing this Tower PG record. View mode until the lease is available.';

function documentSessionContextKey(store) {
  const context = resolveTowerPgWorkspaceContext(store);
  return JSON.stringify([context.baseUrl, context.workspaceId, context.appNpub, store?.session?.npub]);
}

function trimText(value) {
  return String(value ?? '').trim();
}

export function isOnlineForPgEdit(env = globalThis) {
  return env?.navigator?.onLine !== false;
}

export function isPgBackedRecord(record = null) {
  return Boolean(record?.pg_backend);
}

export function isSyncedPgRecord(record = null) {
  return isPgBackedRecord(record) && trimText(record?.sync_status || 'synced') === 'synced';
}

export function isUnsyncedLocalPgRecord(record = null) {
  return isPgBackedRecord(record) && trimText(record?.sync_status || 'synced') !== 'synced';
}

export async function preparePgSyncedRecordMutation(store, record, entityType, options = {}) {
  if (!isSyncedPgRecord(record)) return null;
  const existing = getPgEditLeaseSession(store, entityType, record?.record_id);
  if (existing?.lease?.lease_token) return existing.lease;
  return acquirePgEditLeaseForRecord(store, record, entityType, options);
}

export function pgEditLeaseSessionKey(entityType, recordId) {
  const cleanType = trimText(entityType);
  const cleanId = trimText(recordId);
  return cleanType && cleanId ? `${cleanType}:${cleanId}` : '';
}

export function getPgEditLeaseSession(store, entityType, recordId) {
  const key = pgEditLeaseSessionKey(entityType, recordId);
  if (!key) return null;
  const session = store?.pgEditLeaseSessions?.[key] || null;
  if (entityType === 'document' && session?.contextKey && session.contextKey !== documentSessionContextKey(store)) return null;
  return session;
}

export function setPgEditLeaseSession(store, entityType, recordId, patch = {}) {
  const key = pgEditLeaseSessionKey(entityType, recordId);
  if (!key || !store) return null;
  const current = getPgEditLeaseSession(store, entityType, recordId) || {};
  const next = {
    ...current,
    ...patch,
    entityType: trimText(entityType),
    recordId: trimText(recordId),
    updatedAt: new Date().toISOString(),
  };
  store.pgEditLeaseSessions = {
    ...(store.pgEditLeaseSessions || {}),
    [key]: next,
  };
  return next;
}

export function clearPgEditLeaseSession(store, entityType, recordId) {
  const key = pgEditLeaseSessionKey(entityType, recordId);
  if (!key || !store?.pgEditLeaseSessions?.[key]) return;
  const next = { ...(store.pgEditLeaseSessions || {}) };
  delete next[key];
  store.pgEditLeaseSessions = next;
}

export async function inspectPgEditLeaseForRecord(store, record, entityType, options = {}) {
  if (!isSyncedPgRecord(record)) return null;
  const recordId = trimText(record?.record_id);
  if (!recordId || !store) return null;
  if (!isOnlineForPgEdit(options.env)) {
    return setPgEditLeaseSession(store, entityType, recordId, {
      inspectionState: 'offline',
      inspectedLease: null,
    });
  }
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.baseUrl) {
    return setPgEditLeaseSession(store, entityType, recordId, {
      inspectionState: 'unknown',
      inspectedLease: null,
    });
  }
  const inspectionContextKey = documentSessionContextKey(store);
  const key = entityType === 'document' ? `${pgEditLeaseSessionKey(entityType, recordId)}:${inspectionContextKey}:${getPgEditLeaseSession(store, entityType, recordId)?.editorSessionId}` : pgEditLeaseSessionKey(entityType, recordId);
  store.pgEditLeaseInspectionPromises = store.pgEditLeaseInspectionPromises || {};
  if (store.pgEditLeaseInspectionPromises[key]) return store.pgEditLeaseInspectionPromises[key];
  const inspectedSessionId = getPgEditLeaseSession(store, entityType, recordId)?.editorSessionId;
  const stillCurrent = () => documentSessionContextKey(store) === inspectionContextKey
    && getPgEditLeaseSession(store, entityType, recordId)?.editorSessionId === inspectedSessionId;
  setPgEditLeaseSession(store, entityType, recordId, { inspectionState: 'loading' });
  let promise;
  promise = Promise.resolve().then(async () => {
    try {
      const result = await getTowerPgEditLease(context.workspaceId, {
        entityType,
        entityId: recordId,
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
      });
      if (!stillCurrent()) return null;
      const inspectedLease = result?.lease || result?.edit_lease || result?.leases?.[0] || null;
      return setPgEditLeaseSession(store, entityType, recordId, {
        inspectionState: 'ready',
        inspectedLease,
        documentProtocolSupported: entityType === 'document' && result?.document_edit_protocol === DOCUMENT_EDIT_PROTOCOL,
      });
    } catch {
      if (!stillCurrent()) return null;
      return setPgEditLeaseSession(store, entityType, recordId, {
        inspectionState: 'unknown',
        inspectedLease: null,
      });
    } finally {
      if (store.pgEditLeaseInspectionPromises?.[key] === promise) {
        delete store.pgEditLeaseInspectionPromises[key];
      }
    }
  });
  store.pgEditLeaseInspectionPromises[key] = promise;
  return promise;
}

export function stopPgEditLeaseRenewal(store, record, entityType, options = {}) {
  const key = pgEditLeaseSessionKey(entityType, record?.record_id);
  if (!key || !store?.pgEditLeaseRenewalTimers?.[key]) return false;
  const timer = store.pgEditLeaseRenewalTimers[key];
  const clearIntervalFn = options.clearInterval || globalThis.clearInterval;
  if (typeof clearIntervalFn === 'function') clearIntervalFn(timer);
  const next = { ...(store.pgEditLeaseRenewalTimers || {}) };
  delete next[key];
  store.pgEditLeaseRenewalTimers = next;
  return true;
}

function normalizeAcquireError(error) {
  if (Number(error?.status) === 409 && error?.code !== 'document_edit_session_superseded') {
    error.userMessage = PG_EDIT_CONFLICT_MESSAGE;
    return error;
  }
  error.userMessage = error?.message || 'Unable to acquire Tower PG edit lease.';
  return error;
}

export async function acquirePgEditLeaseForRecord(store, record, entityType, options = {}) {
  if (!isSyncedPgRecord(record)) return null;
  if (!isOnlineForPgEdit(options.env)) {
    const error = new Error(PG_SYNCED_OFFLINE_EDIT_MESSAGE);
    error.userMessage = PG_SYNCED_OFFLINE_EDIT_MESSAGE;
    error.code = 'pg_synced_offline';
    throw error;
  }

  const recordId = trimText(record?.record_id);
  const context = resolveTowerPgWorkspaceContext(store);
  const contextKey = documentSessionContextKey(store);
  const previous = getPgEditLeaseSession(store, entityType, recordId);
  const existing = previous?.contextKey && previous.contextKey !== contextKey ? null : previous;
  const isDocument = entityType === 'document';
  if (isDocument && existing?.superseded && !options.takeover) {
    throw Object.assign(new Error('Editing continued on another device. Reopen the document or explicitly take over; this draft is preserved.'), { code: 'document_edit_session_superseded' });
  }
  if (existing?.lease?.lease_token && !options.takeover) return existing.lease;
  if (options.takeover && (!isDocument || !existing?.documentProtocolSupported || !options.expectedLeaseId)) {
    throw new Error('This Tower has not confirmed safe device takeover support. Ordinary Save and local drafts remain available.');
  }
  const editorSessionId = isDocument ? (options.takeover && !existing?.takeoverPending ? crypto.randomUUID() : existing?.editorSessionId || crypto.randomUUID()) : null;
  if (isDocument) setPgEditLeaseSession(store, entityType, recordId, { editorSessionId, contextKey, takeoverPending: options.takeover === true });

  const key = isDocument ? `${pgEditLeaseSessionKey(entityType, recordId)}:${contextKey}:${editorSessionId}` : pgEditLeaseSessionKey(entityType, recordId);
  store.pgEditLeaseAcquirePromises = store.pgEditLeaseAcquirePromises || {};
  if (store.pgEditLeaseAcquirePromises[key]) return store.pgEditLeaseAcquirePromises[key];

  if (!context.workspaceId || !context.baseUrl) throw new Error('Tower PG workspace is not ready');
  let promise;
  promise = Promise.resolve().then(async () => {
    try {
      setPgEditLeaseSession(store, entityType, recordId, { acquireState: 'acquiring', message: '', ...(isDocument ? { editorSessionId, contextKey, superseded: false } : {}) });
      const result = await acquireTowerPgEditLease(context.workspaceId, {
        entity_type: entityType,
        entity_id: recordId,
        ttl_seconds: options.ttlSeconds || 120,
        ...(isDocument ? { document_edit_protocol: DOCUMENT_EDIT_PROTOCOL, editor_session_id: editorSessionId } : {}),
        ...(options.takeover ? { takeover: true, expected_lease_id: options.expectedLeaseId } : {}),
      }, {
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
      });
      if (isDocument && getPgEditLeaseSession(store, entityType, recordId)?.editorSessionId !== editorSessionId) {
        if (result?.lease?.id && result?.lease?.lease_token) await releaseTowerPgEditLease(context.workspaceId, result.lease.id, { lease_token: result.lease.lease_token }, { baseUrl: context.baseUrl, appNpub: context.appNpub }).catch(() => {});
        throw Object.assign(new Error('The editor visit changed while acquiring access.'), { code: 'editor_visit_changed' });
      }
      const supported = result?.document_edit_protocol === DOCUMENT_EDIT_PROTOCOL
        && result?.lease?.editor_session_id === editorSessionId;
      if (options.takeover && !supported) {
        if (result?.lease?.id && result?.lease?.lease_token) {
          await releaseTowerPgEditLease(context.workspaceId, result.lease.id, { lease_token: result.lease.lease_token }, { baseUrl: context.baseUrl, appNpub: context.appNpub }).catch(() => {});
        }
        throw new Error('Tower did not confirm safe takeover. Your local draft is preserved.');
      }
      setPgEditLeaseSession(store, entityType, recordId, {
        ...(isDocument ? { documentProtocolSupported: supported, takeoverHead: options.takeover ? result.canonical_version : null, superseded: false, takeoverPending: false } : {}),
        acquireState: 'held',
        lease: result.lease || null,
        message: '',
      });
      return result.lease || null;
    } catch (error) {
      const normalized = normalizeAcquireError(error);
      if (isDocument && getPgEditLeaseSession(store, entityType, recordId)?.editorSessionId !== editorSessionId) throw normalized;
      setPgEditLeaseSession(store, entityType, recordId, {
        acquireState: 'blocked',
        lease: null,
        ...(isDocument ? { superseded: normalized?.code === 'document_edit_session_superseded' || existing?.superseded === true, takeoverPending: false } : {}),
        blockedLease: normalized?.lease || normalized?.payload?.details?.lease || {
          id: normalized?.lease_id || normalized?.payload?.details?.lease_id || null,
          holder_actor_npub: normalized?.holder_actor_npub || normalized?.holder_npub || null,
          holder_display_name: normalized?.holder_display_name || normalized?.holder_name || null,
          expires_at: normalized?.expires_at || null,
        },
        message: normalized.userMessage,
      });
      throw normalized;
    } finally {
      if (store.pgEditLeaseAcquirePromises?.[key] === promise) {
        delete store.pgEditLeaseAcquirePromises[key];
      }
    }
  });
  store.pgEditLeaseAcquirePromises[key] = promise;
  return promise;
}

export async function renewPgEditLeaseForRecord(store, record, entityType, options = {}) {
  const recordId = trimText(record?.record_id);
  const session = getPgEditLeaseSession(store, entityType, recordId);
  if (!session?.lease?.id || !session?.lease?.lease_token) return null;
  const context = resolveTowerPgWorkspaceContext(store);
  const result = await renewTowerPgEditLease(context.workspaceId, session.lease.id, {
    lease_token: session.lease.lease_token,
    ttl_seconds: options.ttlSeconds || 120,
  }, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const current = getPgEditLeaseSession(store, entityType, recordId);
  if (current?.lease?.lease_token !== session.lease.lease_token || current?.editorSessionId !== session.editorSessionId) return null;
  setPgEditLeaseSession(store, entityType, recordId, { acquireState: 'held', lease: result.lease || session.lease });
  return result.lease || session.lease;
}

export function startPgEditLeaseRenewal(store, record, entityType, options = {}) {
  if (!isSyncedPgRecord(record)) return null;
  const key = pgEditLeaseSessionKey(entityType, record?.record_id);
  if (!key || !store) return null;
  const session = getPgEditLeaseSession(store, entityType, record.record_id);
  if (!session?.lease?.id || !session?.lease?.lease_token) return null;

  stopPgEditLeaseRenewal(store, record, entityType, options);

  const setIntervalFn = options.setInterval || globalThis.setInterval;
  if (typeof setIntervalFn !== 'function') return null;
  const intervalMs = Math.max(1_000, Number(options.intervalMs) || 60_000);
  let renewing = false;
  const timer = setIntervalFn(async () => {
    if (renewing) return;
    const current = getPgEditLeaseSession(store, entityType, record.record_id);
    if (!current?.lease?.id || !current?.lease?.lease_token) {
      stopPgEditLeaseRenewal(store, record, entityType, options);
      return;
    }
    renewing = true;
    try {
      await renewPgEditLeaseForRecord(store, record, entityType, options);
    } catch (error) {
      const latest = getPgEditLeaseSession(store, entityType, record.record_id);
      if (latest?.lease?.lease_token !== current.lease.lease_token || latest?.editorSessionId !== current.editorSessionId) return;
      // A transport failure does not prove that Tower revoked this lease.
      // Keep its identity and retry; canonical saves still validate the token.
      const status = Number(error?.status || 0);
      const transportError = error?.cause || error;
      const temporaryTransport = !status && (transportError instanceof TypeError
        || ['NetworkError', 'TimeoutError', 'AbortError'].includes(transportError?.name));
      if (entityType === 'document' && (temporaryTransport || status >= 500 || status === 408 || status === 429)) {
        if (store?.selectedDocId === record.record_id) {
          try { await store.persistSelectedDocDraft?.({ immediate: true }); }
          catch (draftError) {
            if (store.selectedDocId === record.record_id
              && getPgEditLeaseSession(store, entityType, record.record_id)?.lease?.lease_token === current.lease.lease_token) {
              store.docEditAccessMessage = `Local draft could not be saved: ${draftError?.message || draftError}`;
            }
          }
        }
        return;
      }
      const message = error?.userMessage || error?.message || 'Unable to renew Tower PG edit lease.';
      setPgEditLeaseSession(store, entityType, record.record_id, {
        acquireState: 'blocked',
        lease: null,
        ...(entityType === 'document' ? { superseded: error?.code === 'document_edit_session_superseded' } : {}),
        message,
      });
      stopPgEditLeaseRenewal(store, record, entityType, options);
      if (entityType === 'document' && store?.selectedDocId === record.record_id) {
        store.docNeedsHeadCheck = true;
        void store.persistSelectedDocDraft?.({ immediate: true });
        store.docEditAccessState = 'blocked';
        store.docEditAccessMessage = store.docEditDraftDirty
          ? 'Draft preserved — the edit lease expired. Retry edit access before saving.'
          : message;
        store.docRichEditorAdapter?.setEditable?.(false);
        store.cancelDocAutosave?.();
      }
      if (options.reportError && store) store.error = error?.message || 'Unable to renew Tower PG edit lease.';
    } finally {
      renewing = false;
    }
  }, intervalMs);
  store.pgEditLeaseRenewalTimers = {
    ...(store.pgEditLeaseRenewalTimers || {}),
    [key]: timer,
  };
  return timer;
}

export async function releasePgEditLeaseForRecord(store, record, entityType, options = {}) {
  const recordId = trimText(record?.record_id);
  stopPgEditLeaseRenewal(store, record, entityType, options);
  const session = getPgEditLeaseSession(store, entityType, recordId);
  if (!session?.lease?.id || !session?.lease?.lease_token) return false;
  const key = `${pgEditLeaseSessionKey(entityType, recordId)}:${session.lease.id}`;
  const clearReleased = () => {
    const current = getPgEditLeaseSession(store, entityType, recordId);
    if (current?.lease?.lease_token !== session.lease.lease_token || current?.editorSessionId !== session.editorSessionId) return;
    if (entityType === 'document' && session.editorSessionId) {
      setPgEditLeaseSession(store, entityType, recordId, { lease: null, acquireState: 'ready' });
    } else clearPgEditLeaseSession(store, entityType, recordId);
  };
  store.pgEditLeaseReleasePromises = store.pgEditLeaseReleasePromises || {};
  if (store.pgEditLeaseReleasePromises[key]) return store.pgEditLeaseReleasePromises[key];

  let promise;
  promise = (async () => {
    if (options.clearLocalBeforeRelease) {
      clearReleased();
    }
    try {
      const context = resolveTowerPgWorkspaceContext(store);
      await releaseTowerPgEditLease(context.workspaceId, session.lease.id, {
        lease_token: session.lease.lease_token,
      }, {
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
      });
      if (!options.clearLocalBeforeRelease) {
        clearReleased();
      }
      return true;
    } catch (error) {
      if (options.reportError && store) store.error = error?.message || 'Unable to release Tower PG edit lease.';
      if (!options.clearLocalBeforeRelease) {
        clearReleased();
      }
      return false;
    } finally {
      if (store.pgEditLeaseReleasePromises?.[key] === promise) {
        delete store.pgEditLeaseReleasePromises[key];
      }
    }
  })();
  store.pgEditLeaseReleasePromises[key] = promise;
  return promise;
}

export function addPgEditLeaseToSaveBody(store, record, entityType, body = {}) {
  if (!isSyncedPgRecord(record)) return body;
  const session = getPgEditLeaseSession(store, entityType, record?.record_id);
  const leaseToken = trimText(session?.lease?.lease_token || store?.getPgEditLeaseToken?.(entityType, record?.record_id));
  return leaseToken ? { ...body, lease_token: leaseToken } : body;
}

// Short scope access commands use the same canonical edit leases as long edits.
export async function acquirePgScopeAccessLease(context, scopeId) {
  const result = await acquireTowerPgEditLease(context.workspaceId, {entity_type:'scope',entity_id:scopeId,ttl_seconds:120}, context);
  return result.lease;
}
export async function releasePgScopeAccessLease(context, lease) {
  if (lease?.id) await releaseTowerPgEditLease(context.workspaceId,lease.id,{lease_token:lease.lease_token},context);
}

export const resolvePgEditWorkspaceContext = (...args) => resolveTowerPgWorkspaceContext(...args);
