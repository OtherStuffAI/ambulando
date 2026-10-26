import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceViewStates, openWorkspaceDb, upsertResourceViewState } from '../src/db.js';
import { unreadStoreMixin } from '../src/unread-store.js';
import { getTowerPgResourceViewStates } from '../src/api.js';
vi.mock('../src/api.js', () => ({ getTowerPgResourceViewStates: vi.fn(),
  markTowerPgResourcesViewed: vi.fn(), getTowerPgReadPosition: vi.fn() }));
vi.mock('../src/pg-record-delta.js', () => ({ getPgAttentionProjection: vi.fn(async () => null) }));

beforeEach(async () => {
  vi.clearAllMocks();
  const db = openWorkspaceDb('connection-recovery');
  await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
});
const makeStore = () => ({ ...unreadStoreMixin, session: { npub: 'viewer' },
  currentWorkspace: { workspaceId: 'workspace', directHttpsUrl: 'https://tower.example' },
  markTowerReachabilityDegraded: vi.fn(), markTowerReachabilityRecovered: vi.fn() });
const row = { record_id: 'thread:cached', resource_type: 'thread', resource_id: 'cached',
  activity_version: 2, viewed_activity_version: 1, sync_status: 'synced' };

describe('cached Inbox recovery', () => {
  it('keeps cached unread data on failure then clears the connection warning after a successful refresh', async () => {
    await upsertResourceViewState(row);
    const store = makeStore();
    getTowerPgResourceViewStates.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }));
    await store.refreshTowerPgResourceViewStates({ readOnly: true });
    expect((await getResourceViewStates())[0].resource_id).toBe('cached');
    expect(store._unreadThreadItems.cached).toBe(true);
    expect(store.markTowerReachabilityDegraded).toHaveBeenCalledWith('view-state-unreachable');
    expect(store.towerViewStateConnectionFailed).toBe(true);
    getTowerPgResourceViewStates.mockResolvedValueOnce({ states: [{ ...row, viewed_activity_version: 2 }], has_more: false });
    await store.refreshTowerPgResourceViewStates({ readOnly: true });
    expect(store._unreadThreadItems.cached).toBeUndefined();
    expect(store.markTowerReachabilityRecovered).toHaveBeenCalledWith('view-state-refresh');
    expect(store.towerViewStateConnectionFailed).toBe(false);
  });

  it('ignores a successful late response after scope teardown and preserves pending read positions', async () => {
    await upsertResourceViewState({ ...row, sync_status: 'pending' });
    const store = makeStore();
    let resolve;
    getTowerPgResourceViewStates.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = store.refreshTowerPgResourceViewStates({ readOnly: true });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    store.teardownUnreadTracking();
    resolve({ states: [], has_more: false });
    await pending;
    expect(await getResourceViewStates()).toEqual([expect.objectContaining({ resource_id: 'cached', sync_status: 'pending' })]);
    expect(store.markTowerReachabilityRecovered).not.toHaveBeenCalled();
  });

  it('does not label access rejection as connection loss', async () => {
    const store = makeStore();
    getTowerPgResourceViewStates.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
    await store.refreshTowerPgResourceViewStates({ readOnly: true });
    expect(store.markTowerReachabilityDegraded).not.toHaveBeenCalled();
  });
});
