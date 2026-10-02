import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeWorkspaceDb, deleteWorkspaceDb, getWorkspaceDb, hasWorkspaceDb, openWorkspaceDb } from '../src/db.js';
import { normalizeWorkspaceEntry } from '../src/workspaces.js';
import { applyPgRecordChanges, recordDeltaCursorKey } from '../src/pg-record-delta.js';
import { syncTowerPgWorkspace } from '../src/pg-read-hydrator.js';
import { getActiveSessionNpub, setActiveSessionNpub } from '../src/crypto/group-keys.js';
import { getActiveWorkspaceKey, setActiveWorkspaceKey } from '../src/crypto/workspace-keys.js';
import { getMemorySecret, setMemorySecret } from '../src/auth/nostr.js';
import { getStoredCredentials, storeCredentials } from '../src/auth/secure-store.js';
import { maybePerformHardReset } from '../src/hard-reset.js';
import fixture from './fixtures/flightdeck-record-delta-v1.json';

const { stores, updateTask } = vi.hoisted(() => ({ stores: new Map(), updateTask: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { start: vi.fn(), store: vi.fn((name, value) => {
  if (value) stores.set(name, value);
  return stores.get(name);
}) } }));
vi.mock('../src/auth/nostr.js', async original => ({ ...(await original()),
  signLoginEvent: vi.fn(async (_method, npub) => ({ pubkey: npub })),
  getPubkeyFromEvent: event => event.pubkey,
  pubkeyToNpub: async pubkey => pubkey,
}));
vi.mock('../src/pg-write-adapter.js', async original => ({ ...(await original()), updateTowerPgTaskFromLocal: updateTask }));

const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const workspace = actor => normalizeWorkspaceEntry({
  workspaceId, towerServiceNpub: 'npub1tower', workspaceServiceNpub: 'npub1workspace',
  workspaceOwnerNpub: 'npub1owner', appNpub: 'flightdeck_pg', pgSessionNpub: actor,
  pgBackendMode: true, directHttpsUrl: 'http://127.0.0.1:3100', name: 'Retention test',
});
const partitions = ['npub1alice', 'npub1bob'].map(actor => workspace(actor).workspaceKey);
const delta = (changes = [], cursor = 'next-cursor') => ({ ...fixture.one_message_delta, changes, next_cursor: cursor, has_more: false });
let store, db, read;

async function assemble() {
  const { initApp } = await import('../src/app.js');
  initApp();
  const value = stores.get('chat');
  for (const name of ['stopDrive', 'startSharedLiveQueries', 'stopWorkspaceLiveQueries',
    'stopExtensionSignerWatch', 'clearDocCommentConnector', 'revokeStorageImageObjectUrls',
    'revokeWorkspaceAvatarPreviewObjectUrl', 'resolveChatProfile', 'rememberPeople',
    'discoverPgOnboardingAnnouncements', 'discoverPgWorkspaceSelfIndex', 'loadRemoteWorkspaces',
    'updateWorkspaceBootstrapPrompt', 'persistWorkspaceSettings', 'ensureWorkspaceSessionKey',
    'refreshWorkspaceSettings', 'syncWorkspaceProfileDraft', 'validateSelectedBoardId',
    'normalizeSettingsTab', 'syncRoute', 'closeMentionPopover', 'refreshLegacyWorkspaceRecovery',
    'cancelEditSchedule', 'disconnectSSEStream', 'closeThread', 'closeTaskDetail',
    'refreshUnreadFlags', 'ensureBackgroundSync']) value[name] = vi.fn();
  value.readStoredTaskBoardId = () => null;
  value.prepareWorkspaceAccessGate = () => false;
  value.loadLocalWorkspaceCoreData = vi.fn(async () => {
    value.scopes = await getWorkspaceDb().scopes.toArray();
    value.channels = await getWorkspaceDb().channels.toArray();
    value.tasks = await getWorkspaceDb().tasks.toArray();
  });
  value.startWorkspaceLiveQueries = vi.fn();
  value.verifyPgWorkspaceForSelection = vi.fn(async candidate => {
    expect(value.session.npub).toBe(candidate.pgSessionNpub);
    return candidate;
  });
  value.bootstrapSelectedWorkspace = vi.fn(async () => {
    await syncTowerPgWorkspace(value, {}, { getTowerPgRecordSync: read,
      getTowerPgResourceViewStates: async () => ({ states: [] }) });
  });
  return value;
}

beforeEach(async () => {
  read = vi.fn(async () => delta());
  store = await assemble();
  const entry = workspace('npub1alice');
  Object.assign(store, { session: { npub: 'npub1alice', method: 'extension' },
    selectedWorkspaceKey: entry.workspaceKey, currentWorkspaceOwnerNpub: entry.workspaceOwnerNpub,
    ownerNpub: entry.workspaceOwnerNpub, knownWorkspaces: [entry], backendUrl: entry.directHttpsUrl });
  db = openWorkspaceDb(entry.workspaceKey); await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
  await applyPgRecordChanges(store, delta(fixture.canonical_upserts.changes, 'opaque:900719925474099312345:exact'));
  await db.pending_writes.add({ record_id: 'local-intent', envelope: { signature_npub: 'npub1alice' } });
  await db.document_drafts.put({ draft_key: 'draft', workspace_id: workspaceId, document_id: 'doc', content: 'unsaved intent' });
  await db.sync_state.put({ key: 'pg_task_write_queue:v1', value: [{ queueId: 'saved', recordId: 'task' }] });
  await store.loadLocalWorkspaceCoreData();
});
afterEach(async () => { closeWorkspaceDb(); for (const key of partitions) await deleteWorkspaceDb(key); });

it('same-user real logout/login retains rows, draft, pending intent and exact cursor; incremental pull sends it', async () => {
  const cursorKey = recordDeltaCursorKey(store);
  const state = await db.sync_state.get(cursorKey);
  const counts = await Promise.all([db.scopes.count(), db.channels.count(), db.tasks.count()]);
  await store.logout();
  expect(hasWorkspaceDb()).toBe(false);
  expect(store.session).toBeNull();
  expect(store.channels).toEqual([]); expect(store.tasks).toEqual([]);
  await store.login('extension', 'npub1alice');
  expect(store.loginError).toBeNull();
  expect(store.verifyPgWorkspaceForSelection).toHaveBeenCalled();
  expect(store.verifyPgWorkspaceForSelection.mock.invocationCallOrder[0]).toBeLessThan(store.startWorkspaceLiveQueries.mock.invocationCallOrder[0]);
  expect(read.mock.calls[0][1].cursor).toBe(state.value.cursor);
  expect(await getWorkspaceDb().sync_state.get(cursorKey)).toMatchObject({ value: { cursor: 'next-cursor' } });
  expect(await Promise.all([getWorkspaceDb().scopes.count(), getWorkspaceDb().channels.count(), getWorkspaceDb().tasks.count()])).toEqual(counts);
  expect(await getWorkspaceDb().pending_writes.count()).toBe(1);
  expect(await getWorkspaceDb().document_drafts.get('draft')).toMatchObject({ content: 'unsaved intent' });
  expect(await getWorkspaceDb().sync_state.get('pg_task_write_queue:v1')).toBeDefined();
});

it('logout closes subscriptions and clears personal and delegated authentication without changing durable state', async () => {
  const before = await db.sync_state.toArray();
  setActiveSessionNpub('npub1alice');
  setMemorySecret(new Uint8Array(32).fill(1));
  setActiveWorkspaceKey({ secret: new Uint8Array(32).fill(1), nsec: 'unused', userNpub: 'npub1alice', workspaceOwnerNpub: 'npub1owner', npub: 'delegated' });
  await storeCredentials({ method: 'extension', pubkey: 'a'.repeat(64), authEvent: { id: 'login' } });
  const disposed = vi.fn();
  store._towerSyncService = { dispose: disposed };
  const stopQueries = vi.spyOn(store, 'stopAllLiveQueries');
  const timer = setTimeout(() => { throw new Error('logout left queue active'); }, 10000);
  store.pgTaskWriteProcessTimer = timer;
  await store.logout();
  expect(disposed).toHaveBeenCalled(); expect(stopQueries).toHaveBeenCalled();
  expect(store.stopDrive).toHaveBeenCalled();
  expect(store.pgTaskWriteProcessTimer).toBeNull();
  expect(getActiveWorkspaceKey()).toBeNull(); expect(getActiveSessionNpub()).toBeNull();
  expect(getMemorySecret()).toBeNull(); expect(await getStoredCredentials()).toBeNull();
  expect(await openWorkspaceDb(partitions[0]).sync_state.toArray()).toEqual(before);
});

it('clears transient composer intent and editor state while saving a dirty document before detach', async () => {
  store.chatComposerDrafts = { 'same-workspace:channel': { value: 'Alice transient text' } };
  store.messageFileDrafts = [{ storage_object_id: 'Alice attachment' }];
  store.newTaskTitle = 'Alice unsent task';
  store.chatTaskModalOpen = true; store.chatTaskModalTitle = 'Alice task';
  store.chatDocModalOpen = true; store.chatDocModalTitle = 'Alice document';
  store.workrooms = [{ record_id: 'Alice-room' }];
  store.workspaceAgents = [{ id: 'Alice-agent' }];
  store.docEditDraftDirty = true;
  store.docLocalDraft = { content: 'Alice editor state' };
  store.persistSelectedDocDraft = vi.fn(async () => {
    expect(store.session.npub).toBe('npub1alice');
    expect(hasWorkspaceDb()).toBe(true);
    await db.document_drafts.put({ draft_key: 'draft', workspace_id: workspaceId, document_id: 'doc', content: 'saved before logout' });
  });
  await store.logout();
  expect(store.chatComposerDrafts).toEqual({}); expect(store.messageFileDrafts).toEqual([]);
  expect(store.newTaskTitle).toBe(''); expect(store.docLocalDraft).toBeNull();
  expect(store.docEditDraftDirty).toBe(false);
  expect(store.chatTaskModalOpen).toBe(false); expect(store.chatTaskModalTitle).toBe('');
  expect(store.chatDocModalOpen).toBe(false); expect(store.chatDocModalTitle).toBe('');
  expect(store.workrooms).toEqual([]); expect(store.workspaceAgents).toEqual([]);
  expect(await openWorkspaceDb(partitions[0]).document_drafts.get('draft')).toMatchObject({ content: 'saved before logout' });
});

it('draft persistence failure still ends auth and detaches cached authority', async () => {
  store.docEditDraftDirty = true;
  store.persistSelectedDocDraft = vi.fn().mockRejectedValue(new Error('storage failed'));
  await expect(store.logout()).rejects.toThrow('storage failed');
  expect(store.session).toBeNull(); expect(hasWorkspaceDb()).toBe(false);
  expect(store.channels).toEqual([]); expect(store.tasks).toEqual([]);
  expect(await getStoredCredentials()).toBeNull();
});

it('canonical login bootstrap resumes durable task intent only after access and control-plane checks', async () => {
  const { createShellState } = await import('../src/shell-state.js');
  const order = [];
  store.ensureTowerPgControlPlaneHydrated = vi.fn(async () => order.push('verified-control-plane'));
  store.resumePgTaskWriteQueue = vi.fn(async () => {
    order.push('resume-intent');
    expect(await getWorkspaceDb().sync_state.get('pg_task_write_queue:v1')).toBeDefined();
  });
  for (const name of ['refreshAddressBook', 'applyRouteFromLocation', 'refreshSyncStatus']) store[name] = vi.fn();
  store.readStoredCollapsedSections = () => ({});
  store.navSection = 'chat'; store.selectedChannelId = null;
  await createShellState().bootstrapSelectedWorkspace.call(store);
  expect(order).toEqual(['verified-control-plane', 'resume-intent']);
  store.verifyPgWorkspaceForSelection.mockRejectedValueOnce(new Error('workspace_membership_required'));
  await expect(createShellState().bootstrapSelectedWorkspace.call(store)).rejects.toThrow('workspace_membership_required');
  expect(store.resumePgTaskWriteQueue).toHaveBeenCalledTimes(1);
});

it('another identity cannot activate Alice cache or replay her queue; returning Alice still has it', async () => {
  await store.logout();
  await store.login('extension', 'npub1bob');
  expect(store.channels).toEqual([]); expect(store.pgTaskWriteQueue).toEqual([]);
  expect(hasWorkspaceDb()).toBe(false); expect(read).not.toHaveBeenCalled();
  const bob = workspace('npub1bob'); store.knownWorkspaces = [bob];
  await store.selectWorkspace(bob.workspaceKey, { refresh: false });
  expect(await getWorkspaceDb().pending_writes.count()).toBe(0);
  expect(await getWorkspaceDb().sync_state.count()).toBe(0);
  expect(await getWorkspaceDb().document_drafts.count()).toBe(0);
  await store.logout(); store.knownWorkspaces = [workspace('npub1alice')];
  await store.login('extension', 'npub1alice');
  expect(read.mock.calls[0][1].cursor).toBe('opaque:900719925474099312345:exact');
  expect(await getWorkspaceDb().pending_writes.count()).toBe(1);
});

it('access denied on login leaves retained authority unmounted and pending intent unreplayed', async () => {
  await store.logout();
  store.verifyPgWorkspaceForSelection.mockRejectedValue(Object.assign(new Error('workspace_membership_required'), { status: 403 }));
  await store.login('extension', 'npub1alice');
  expect(hasWorkspaceDb()).toBe(false); expect(store.channels).toEqual([]);
  expect(store.tasks).toEqual([]); expect(read).not.toHaveBeenCalled();
  expect(store.ensureBackgroundSync).not.toHaveBeenCalled();
  expect(await openWorkspaceDb(partitions[0]).pending_writes.count()).toBe(1);
});

it('explicit browser Clear cache reset deletes retained data, pending intent and all sync state', async () => {
  await store.logout();
  const originalWindow = globalThis.window;
  const originalSessionStorage = globalThis.sessionStorage;
  const replace = vi.fn();
  globalThis.window = { location: { href: 'http://localhost/?reset=1', replace } };
  globalThis.sessionStorage = { clear: vi.fn() };
  try {
    expect(await maybePerformHardReset()).toBe(true);
    expect(replace).toHaveBeenCalledWith('/');
    const fresh = openWorkspaceDb(partitions[0]);
    expect(await fresh.sync_state.count()).toBe(0); expect(await fresh.channels.count()).toBe(0);
    expect(await fresh.pending_writes.count()).toBe(0); expect(await fresh.document_drafts.count()).toBe(0);
  } finally { globalThis.window = originalWindow; globalThis.sessionStorage = originalSessionStorage; }
});

it.each(['resolve', 'reject'])('in-flight task %s after logout cannot write into another identity or consume retained intent', async outcome => {
  const task = (await db.tasks.toArray())[0];
  expect(task).toBeDefined();
  task.sync_status = 'pending'; await db.tasks.put(task);
  let complete, fail;
  updateTask.mockImplementationOnce(() => new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
  const item = { queueId: 'inflight', recordId: task.record_id, updatedTask: task, previousTask: task, patch: { title: 'Alice edit' } };
  store.pgTaskWriteQueue = [item]; await store.persistPgTaskWriteQueue();
  const retained = (await db.sync_state.get('pg_task_write_queue:v1')).value;
  const running = store.processPgTaskWriteQueue();
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  await store.logout();
  const bob = workspace('npub1bob'); store.knownWorkspaces = [bob]; store.session = { npub: 'npub1bob' };
  await store.selectWorkspace(bob.workspaceKey, { refresh: false });
  if (outcome === 'resolve') complete({ ...task, title: 'Alice edit', sync_status: 'synced' });
  else fail(new Error('old request failed'));
  await running;
  expect(await getWorkspaceDb().tasks.count()).toBe(0);
  expect(store.tasks).toEqual([]); expect(store.pgTaskWriteQueue).toEqual([]);
  expect(await getWorkspaceDb().sync_state.count()).toBe(0);
  closeWorkspaceDb();
  expect((await openWorkspaceDb(partitions[0]).sync_state.get('pg_task_write_queue:v1')).value).toEqual(retained);
});
