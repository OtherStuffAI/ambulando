import { describe, expect, it, vi } from 'vitest';
import {
  acquirePgEditLeaseForRecord,
  DOCUMENT_EDIT_PROTOCOL,
  renewPgEditLeaseForRecord,
  setPgEditLeaseSession,
  inspectPgEditLeaseForRecord,
  releasePgEditLeaseForRecord,
  PG_EDIT_CONFLICT_MESSAGE,
  PG_SYNCED_OFFLINE_EDIT_MESSAGE,
  preparePgSyncedRecordMutation,
  startPgEditLeaseRenewal,
  stopPgEditLeaseRenewal,
} from '../src/pg-edit-session.js';

vi.mock('../src/api.js', () => ({
  acquireTowerPgEditLease: vi.fn(),
  getTowerPgEditLease: vi.fn(),
  releaseTowerPgEditLease: vi.fn(),
  renewTowerPgEditLease: vi.fn(),
}));

function store(seed = {}) {
  return {
    backendUrl: 'https://tower.example',
    workspaceOwnerNpub: 'npub1owner',
    currentWorkspace: {
      workspaceId: 'workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      pgBackendMode: true,
    },
    pgEditLeaseSessions: {},
    ...seed,
  };
}

describe('PG edit sessions', () => {
  it('blocks synced PG edit entry while offline', async () => {
    await expect(acquirePgEditLeaseForRecord(store(), {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
    }, 'task', { env: { navigator: { onLine: false } } })).rejects.toMatchObject({
      userMessage: PG_SYNCED_OFFLINE_EDIT_MESSAGE,
    });
  });

  it('allows unsynced local PG records to edit offline without acquiring a lease', async () => {
    const api = await import('../src/api.js');
    const result = await acquirePgEditLeaseForRecord(store(), {
      record_id: 'task-local',
      pg_backend: true,
      sync_status: 'pending',
    }, 'task', { env: { navigator: { onLine: false } } });

    expect(result).toBeNull();
    expect(api.acquireTowerPgEditLease).not.toHaveBeenCalled();
  });

  it('acquires and stores a lease before online synced edits', async () => {
    const api = await import('../src/api.js');
    api.acquireTowerPgEditLease.mockResolvedValueOnce({
      lease: { id: 'lease-1', lease_token: 'token-1' },
    });
    const target = store();

    const lease = await acquirePgEditLeaseForRecord(target, {
      record_id: 'doc-1',
      pg_backend: true,
      sync_status: 'synced',
    }, 'document', { env: { navigator: { onLine: true } } });

    expect(api.acquireTowerPgEditLease).toHaveBeenCalledWith('workspace-1', {
      entity_type: 'document',
      document_edit_protocol: 'document_edit_session_v1',
      editor_session_id: expect.any(String),
      entity_id: 'doc-1',
      ttl_seconds: 120,
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(lease).toEqual({ id: 'lease-1', lease_token: 'token-1' });
    expect(target.pgEditLeaseSessions['document:doc-1'].lease.lease_token).toBe('token-1');
  });

  it('deduplicates simultaneous acquire requests for one record', async () => {
    const api = await import('../src/api.js');
    let resolveAcquire;
    api.acquireTowerPgEditLease.mockReturnValueOnce(new Promise((resolve) => { resolveAcquire = resolve; }));
    const target = store();
    const record = { record_id: 'doc-race', pg_backend: true, sync_status: 'synced' };

    const first = acquirePgEditLeaseForRecord(target, record, 'document');
    const second = acquirePgEditLeaseForRecord(target, record, 'document');
    await Promise.resolve();

    expect(api.acquireTowerPgEditLease).toHaveBeenCalledTimes(1);
    resolveAcquire({ lease: { id: 'lease-race', lease_token: 'token-race' } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: 'lease-race', lease_token: 'token-race' },
      { id: 'lease-race', lease_token: 'token-race' },
    ]);
  });

  it('inspects an active lease without acquiring it', async () => {
    const api = await import('../src/api.js');
    api.getTowerPgEditLease.mockResolvedValueOnce({
      lease: { id: 'lease-other', holder_actor_npub: 'npub1other' },
    });
    const target = store();

    const session = await inspectPgEditLeaseForRecord(target, {
      record_id: 'doc-inspect',
      pg_backend: true,
      sync_status: 'synced',
    }, 'document');

    expect(api.getTowerPgEditLease).toHaveBeenCalledWith('workspace-1', {
      entityType: 'document',
      entityId: 'doc-inspect',
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(api.acquireTowerPgEditLease).not.toHaveBeenCalled();
    expect(session).toMatchObject({ inspectionState: 'ready', inspectedLease: { id: 'lease-other' } });
  });

  it('maps lease conflicts to a view-mode message', async () => {
    const api = await import('../src/api.js');
    const conflict = new Error('Tower PG API 409');
    conflict.status = 409;
    api.acquireTowerPgEditLease.mockRejectedValueOnce(conflict);
    const target = store();

    await expect(acquirePgEditLeaseForRecord(target, {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
    }, 'task', { env: { navigator: { onLine: true } } })).rejects.toMatchObject({
      userMessage: PG_EDIT_CONFLICT_MESSAGE,
    });
    expect(target.pgEditLeaseSessions['task:task-1'].message).toBe(PG_EDIT_CONFLICT_MESSAGE);
  });

  it('prepares online synced task mutations by acquiring a PG lease', async () => {
    const api = await import('../src/api.js');
    api.acquireTowerPgEditLease.mockResolvedValueOnce({
      lease: { id: 'lease-task-1', lease_token: 'task-token-1' },
    });
    const target = store();

    const lease = await preparePgSyncedRecordMutation(target, {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
    }, 'task', { env: { navigator: { onLine: true } } });

    expect(api.acquireTowerPgEditLease).toHaveBeenCalledWith('workspace-1', {
      entity_type: 'task',
      entity_id: 'task-1',
      ttl_seconds: 120,
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(lease).toEqual({ id: 'lease-task-1', lease_token: 'task-token-1' });
    expect(target.pgEditLeaseSessions['task:task-1'].lease.lease_token).toBe('task-token-1');
  });

  it('blocks offline synced task mutations before local writes can be staged', async () => {
    const api = await import('../src/api.js');
    api.acquireTowerPgEditLease.mockClear();
    await expect(preparePgSyncedRecordMutation(store(), {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
    }, 'task', { env: { navigator: { onLine: false } } })).rejects.toMatchObject({
      userMessage: PG_SYNCED_OFFLINE_EDIT_MESSAGE,
    });
    expect(api.acquireTowerPgEditLease).not.toHaveBeenCalled();
  });

  it('renews held leases on a scoped timer and stops cleanly', async () => {
    const api = await import('../src/api.js');
    api.renewTowerPgEditLease.mockResolvedValueOnce({
      lease: { id: 'lease-1', lease_token: 'token-2' },
    });
    const callbacks = [];
    const setInterval = vi.fn((callback) => {
      callbacks.push(callback);
      return 'timer-1';
    });
    const clearInterval = vi.fn();
    const target = store({
      pgEditLeaseSessions: {
        'task:task-1': { lease: { id: 'lease-1', lease_token: 'token-1' } },
      },
    });
    const record = { record_id: 'task-1', pg_backend: true, sync_status: 'synced' };

    const timer = startPgEditLeaseRenewal(target, record, 'task', { intervalMs: 2_000, setInterval, clearInterval });

    expect(timer).toBe('timer-1');
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 2_000);
    await callbacks[0]();
    expect(api.renewTowerPgEditLease).toHaveBeenCalledWith('workspace-1', 'lease-1', {
      lease_token: 'token-1',
      ttl_seconds: 120,
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(target.pgEditLeaseSessions['task:task-1'].lease.lease_token).toBe('token-2');

    expect(stopPgEditLeaseRenewal(target, record, 'task', { clearInterval })).toBe(true);
    expect(clearInterval).toHaveBeenCalledWith('timer-1');
    expect(target.pgEditLeaseRenewalTimers['task:task-1']).toBeUndefined();
  });

  it('stops renewal and clears the local session when releasing a PG edit lease', async () => {
    const api = await import('../src/api.js');
    api.releaseTowerPgEditLease.mockResolvedValueOnce({ released: true });
    const clearInterval = vi.fn();
    const target = store({
      pgEditLeaseSessions: {
        'document:doc-1': { lease: { id: 'lease-doc-1', lease_token: 'doc-token-1' } },
      },
      pgEditLeaseRenewalTimers: {
        'document:doc-1': 'timer-doc-1',
      },
    });
    const record = { record_id: 'doc-1', pg_backend: true, sync_status: 'synced' };

    const released = await releasePgEditLeaseForRecord(target, record, 'document', { clearInterval });

    expect(released).toBe(true);
    expect(clearInterval).toHaveBeenCalledWith('timer-doc-1');
    expect(api.releaseTowerPgEditLease).toHaveBeenCalledWith('workspace-1', 'lease-doc-1', {
      lease_token: 'doc-token-1',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(target.pgEditLeaseSessions['document:doc-1']).toBeUndefined();
    expect(target.pgEditLeaseRenewalTimers['document:doc-1']).toBeUndefined();
  });

  it('deduplicates concurrent release attempts for the same PG lease', async () => {
    const api = await import('../src/api.js');
    let finishRelease;
    api.releaseTowerPgEditLease.mockReturnValueOnce(new Promise((resolve) => { finishRelease = resolve; }));
    const target = store({
      pgEditLeaseSessions: {
        'document:doc-1': { lease: { id: 'lease-doc-1', lease_token: 'doc-token-1' } },
      },
    });
    const record = { record_id: 'doc-1', pg_backend: true, sync_status: 'synced' };

    const first = releasePgEditLeaseForRecord(target, record, 'document');
    const second = releasePgEditLeaseForRecord(target, record, 'document');
    finishRelease({ released: true });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(api.releaseTowerPgEditLease).toHaveBeenCalledTimes(1);
  });
});


describe('document device authority', () => {
  const record = { record_id: 'doc-devices', pg_backend: true, sync_status: 'synced' };

  it('keeps ordinary Save compatible with older Tower but does not offer unsafe takeover', async () => {
    const api = await import('../src/api.js');
    api.acquireTowerPgEditLease.mockResolvedValueOnce({ lease: { id: 'legacy', lease_token: 'ordinary' } });
    const target = store();
    await acquirePgEditLeaseForRecord(target, record, 'document');
    expect(target.pgEditLeaseSessions['document:doc-devices'].documentProtocolSupported).toBe(false);
    await expect(acquirePgEditLeaseForRecord(target, record, 'document', { takeover: true, expectedLeaseId: 'legacy' })).rejects.toThrow('not confirmed');
    expect(api.acquireTowerPgEditLease).toHaveBeenCalledTimes(1);
  });

  it('takes over only the observed lease with a fresh session id and matching protocol echo', async () => {
    const api = await import('../src/api.js');
    const target = store({ pgEditLeaseSessions: { 'document:doc-devices': {
      editorSessionId: 'previous-session', documentProtocolSupported: true,
    } } });
    api.acquireTowerPgEditLease.mockImplementationOnce(async (_workspace, body) => ({
      document_edit_protocol: DOCUMENT_EDIT_PROTOCOL,
      lease: { id: 'next', lease_token: 'next-token', editor_session_id: body.editor_session_id },
      canonical_version: { row_version: 5, body_sha256_hex: 'a'.repeat(64) },
    }));
    await acquirePgEditLeaseForRecord(target, record, 'document', { takeover: true, expectedLeaseId: 'observed' });
    const body = api.acquireTowerPgEditLease.mock.calls[0][1];
    expect(body).toMatchObject({ takeover: true, expected_lease_id: 'observed', document_edit_protocol: DOCUMENT_EDIT_PROTOCOL });
    expect(body.editor_session_id).not.toBe('previous-session');
    expect(target.pgEditLeaseSessions['document:doc-devices'].takeoverHead.row_version).toBe(5);
  });

  it('refuses a takeover response without echo even when support was previously advertised', async () => {
    const api = await import('../src/api.js');
    const target = store({ pgEditLeaseSessions: { 'document:doc-devices': { documentProtocolSupported: true } } });
    api.acquireTowerPgEditLease.mockResolvedValueOnce({ lease: { id: 'old-server', lease_token: 'ignored-takeover' } });
    api.releaseTowerPgEditLease.mockResolvedValueOnce({});
    await expect(acquirePgEditLeaseForRecord(target, record, 'document', { takeover: true, expectedLeaseId: 'observed' })).rejects.toThrow('did not confirm');
    expect(target.pgEditLeaseSessions['document:doc-devices'].lease).toBeNull();
    expect(api.releaseTowerPgEditLease).toHaveBeenCalledTimes(1);
  });

  it('retains a superseded session on retry and never silently requests fresh authority', async () => {
    const api = await import('../src/api.js');
    const target = store({ pgEditLeaseSessions: { 'document:doc-devices': { editorSessionId: 'old-session' } } });
    api.acquireTowerPgEditLease.mockRejectedValueOnce(Object.assign(new Error('superseded'), { status: 409, code: 'document_edit_session_superseded' }));
    await expect(acquirePgEditLeaseForRecord(target, record, 'document')).rejects.toThrow('superseded');
    await expect(acquirePgEditLeaseForRecord(target, record, 'document')).rejects.toThrow('another device');
    expect(target.pgEditLeaseSessions['document:doc-devices'].editorSessionId).toBe('old-session');
    expect(api.acquireTowerPgEditLease).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 503, 408, 429])('retries a temporary renewal failure (%s) without disabling document autosave', async (status) => {
    const api = await import('../src/api.js');
    api.renewTowerPgEditLease.mockReset()
      .mockRejectedValueOnce(status ? Object.assign(new Error('temporary outage'), { status })
        : new Error('request failed', { cause: new TypeError('Failed to fetch') }))
      .mockResolvedValueOnce({ lease: { id: 'held', lease_token: 'token', expires_at: 'later' } });
    const target = store({ selectedDocId: record.record_id, docEditAccessState: 'editing', docEditDraftDirty: true,
      persistSelectedDocDraft: vi.fn().mockResolvedValue(true), cancelDocAutosave: vi.fn(),
      docRichEditorAdapter: { setEditable: vi.fn() },
      pgEditLeaseSessions: { 'document:doc-devices': { editorSessionId: 'this-editor', lease: { id: 'held', lease_token: 'token' } } } });
    let tick;
    const clearInterval = vi.fn();
    startPgEditLeaseRenewal(target, record, 'document', { setInterval: (callback) => { tick = callback; return 'timer'; }, clearInterval });
    await tick();
    expect(target.docEditAccessState).toBe('editing');
    expect(target.pgEditLeaseSessions['document:doc-devices'].lease.lease_token).toBe('token');
    expect(target.persistSelectedDocDraft).toHaveBeenCalledWith({ immediate: true });
    expect(target.cancelDocAutosave).not.toHaveBeenCalled();
    expect(target.docRichEditorAdapter.setEditable).not.toHaveBeenCalled();
    expect(clearInterval).not.toHaveBeenCalled();
    await tick();
    expect(api.renewTowerPgEditLease).toHaveBeenCalledTimes(2);
    expect(target.pgEditLeaseSessions['document:doc-devices'].lease.expires_at).toBe('later');
  });

  it('reports local checkpoint failure during a temporary outage without an unhandled rejection', async () => {
    const api = await import('../src/api.js');
    api.renewTowerPgEditLease.mockReset().mockRejectedValueOnce(Object.assign(new Error('temporary outage'), { status: 503 }));
    const target = store({ selectedDocId: record.record_id, docEditAccessState: 'editing',
      persistSelectedDocDraft: vi.fn().mockRejectedValue(new Error('storage full')),
      pgEditLeaseSessions: { 'document:doc-devices': { editorSessionId: 'this-editor', lease: { id: 'held', lease_token: 'token' } } } });
    let tick;
    startPgEditLeaseRenewal(target, record, 'document', { setInterval: (callback) => { tick = callback; return 'timer'; } });
    await expect(tick()).resolves.toBeUndefined();
    expect(target.docEditAccessState).toBe('editing');
    expect(target.docEditAccessMessage).toBe('Local draft could not be saved: storage full');
  });

  it.each([403, 409, undefined])('stops editing on authority rejection or an unclassified failure (%s)', async (status) => {
    const api = await import('../src/api.js');
    api.renewTowerPgEditLease.mockReset().mockRejectedValueOnce(Object.assign(new Error('authority lost'), { status }));
    const target = store({ selectedDocId: record.record_id, docEditAccessState: 'editing', docEditDraftDirty: true,
      persistSelectedDocDraft: vi.fn().mockResolvedValue(true), cancelDocAutosave: vi.fn(),
      docRichEditorAdapter: { setEditable: vi.fn() },
      pgEditLeaseSessions: { 'document:doc-devices': { editorSessionId: 'this-editor', lease: { id: 'held', lease_token: 'token' } } } });
    let tick;
    const clearInterval = vi.fn();
    startPgEditLeaseRenewal(target, record, 'document', { setInterval: (callback) => { tick = callback; return 'timer'; }, clearInterval });
    await tick();
    expect(target.docEditAccessState).toBe('blocked');
    expect(target.pgEditLeaseSessions['document:doc-devices'].lease).toBeNull();
    expect(target.persistSelectedDocDraft).toHaveBeenCalledWith({ immediate: true });
    expect(target.cancelDocAutosave).toHaveBeenCalled();
    expect(clearInterval).toHaveBeenCalledWith('timer');
  });

  it('does not let an old renewal resurrect authority after replacement', async () => {
    const api = await import('../src/api.js');
    let finish;
    api.renewTowerPgEditLease.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const target = store({ pgEditLeaseSessions: { 'document:doc-devices': {
      editorSessionId: 'old', lease: { id: 'old', lease_token: 'old-token' },
    } } });
    const pending = renewPgEditLeaseForRecord(target, record, 'document');
    setPgEditLeaseSession(target, 'document', record.record_id, { editorSessionId: 'new', lease: { id: 'new', lease_token: 'new-token' } });
    finish({ lease: { id: 'old', lease_token: 'old-token' } });
    expect(await pending).toBeNull();
    expect(target.pgEditLeaseSessions['document:doc-devices'].lease.lease_token).toBe('new-token');
  });

  it('keeps the open editor identity after hidden release and ignores a late prior release', async () => {
    const api = await import('../src/api.js');
    const target = store({ pgEditLeaseSessions: { 'document:doc-devices': {
      editorSessionId: 'open-editor', lease: { id: 'first', lease_token: 'first-token' },
    } } });
    api.releaseTowerPgEditLease.mockResolvedValueOnce({});
    await releasePgEditLeaseForRecord(target, record, 'document');
    expect(target.pgEditLeaseSessions['document:doc-devices']).toMatchObject({ editorSessionId: 'open-editor', lease: null });
    let finish;
    api.releaseTowerPgEditLease.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    setPgEditLeaseSession(target, 'document', record.record_id, { lease: { id: 'second', lease_token: 'second-token' } });
    const pending = releasePgEditLeaseForRecord(target, record, 'document');
    setPgEditLeaseSession(target, 'document', record.record_id, { editorSessionId: 'new-editor', lease: { id: 'third', lease_token: 'third-token' } });
    finish({});
    await pending;
    expect(target.pgEditLeaseSessions['document:doc-devices'].lease.lease_token).toBe('third-token');
  });
});

describe('document lease connection identity', () => {
  const record = { record_id: 'same-uuid', pg_backend: true, sync_status: 'synced' };
  it('does not reuse an existing token after an origin/actor change with the same workspace and document UUIDs', async () => {
    const api = await import('../src/api.js');
    api.acquireTowerPgEditLease.mockResolvedValueOnce({ lease: { id: 'first', lease_token: 'first-token' } });
    const target = store({ session: { npub: 'actor-one' } });
    await acquirePgEditLeaseForRecord(target, record, 'document');
    target.currentWorkspace = { ...target.currentWorkspace, directHttpsUrl: 'https://second-tower.example' };
    target.session = { npub: 'actor-two' };
    api.acquireTowerPgEditLease.mockResolvedValueOnce({ lease: { id: 'second', lease_token: 'second-token' } });
    const next = await preparePgSyncedRecordMutation(target, record, 'document');
    expect(next.lease_token).toBe('second-token');
    expect(api.acquireTowerPgEditLease).toHaveBeenCalledTimes(2);
    expect(api.acquireTowerPgEditLease.mock.calls[1][2].baseUrl).toBe('https://second-tower.example');
  });

  it('does not install late inspection from another origin with matching UUIDs', async () => {
    const api = await import('../src/api.js');
    let finish;
    api.getTowerPgEditLease.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const target = store({ session: { npub: 'actor-one' } });
    const pending = inspectPgEditLeaseForRecord(target, record, 'document');
    await Promise.resolve();
    target.currentWorkspace = { ...target.currentWorkspace, directHttpsUrl: 'https://second-tower.example' };
    api.getTowerPgEditLease.mockResolvedValueOnce({ document_edit_protocol: DOCUMENT_EDIT_PROTOCOL, lease: { id: 'second' } });
    await inspectPgEditLeaseForRecord(target, record, 'document');
    finish({ lease: { id: 'first' } });
    expect(await pending).toBeNull();
    expect(target.pgEditLeaseSessions['document:same-uuid'].inspectedLease.id).toBe('second');
  });
});
