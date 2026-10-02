import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { channelsManagerMixin } from '../src/channels-manager.js';
import {
  chunkResourceViewStateWrites,
  collectChannelThreadViewResources,
  TOWER_RESOURCE_VIEW_STATE_BULK_LIMIT,
  unreadStoreMixin,
} from '../src/unread-store.js';

function state(id, channelId, activityVersion = 2, viewedActivityVersion = 0, type = 'thread') {
  return {
    record_id: `${type}:${id}`,
    resource_type: type,
    resource_id: id,
    channel_id: channelId,
    activity_version: activityVersion,
    viewed_activity_version: viewedActivityVersion,
    sync_status: 'synced',
  };
}

describe('channel thread bulk read', () => {
  it('scopes actual thread IDs and versions to the channel and excludes tasks/documents', () => {
    expect(collectChannelThreadViewResources([
      state('tower-thread-a', 'channel-a', 7),
      state('tower-thread-b', 'channel-a', 9),
      state('tower-thread-c', 'channel-b', 11),
      state('task-a', 'channel-a', 4, 0, 'task'),
      state('doc-a', 'channel-a', 4, 0, 'document'),
    ], 'channel-a')).toEqual([
      { resource_type: 'thread', resource_id: 'tower-thread-a', activity_version: 7 },
      { resource_type: 'thread', resource_id: 'tower-thread-b', activity_version: 9 },
    ]);
  });

  it('chunks above Tower\'s 500-resource cap', () => {
    const chunks = chunkResourceViewStateWrites(Array.from({ length: 1001 }, (_, index) => ({ resource_id: `t-${index}` })));
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 1]);
    expect(TOWER_RESOURCE_VIEW_STATE_BULK_LIMIT).toBe(500);
  });

  it('clears only confirmed reads from the channel aggregate and persists after refresh', async () => {
    let rows = [state('thread-a', 'channel-a', 3), state('thread-b', 'channel-a', 5), state('thread-c', 'channel-b', 6)];
    const calls = [];
    const store = {
      isTowerPgMode: true,
      currentWorkspace: { pgBackendMode: true, workspaceId: 'workspace-1', directHttpsUrl: 'http://tower.test', appNpub: 'npub1app' },
      _unreadThreadItems: {}, _unreadTaskItems: {}, _unreadDocItems: {}, _unreadChannels: {},
      getResourceViewStates: vi.fn(async () => rows),
      upsertResourceViewState: vi.fn(async (row) => {
        rows = [...rows.filter((item) => item.record_id !== row.record_id), row];
      }),
      markTowerPgResourcesViewed: vi.fn(async (_workspaceId, resources) => {
        calls.push(resources);
        return { states: resources.map((resource) => state(resource.resource_id, 'channel-a', resource.viewed_activity_version, resource.viewed_activity_version)) };
      }),
      refreshTowerPgResourceViewStates: vi.fn(async () => unreadStoreMixin.applyTowerPgResourceViewStates.call(store, rows)),
      applyTowerPgResourceViewStates: unreadStoreMixin.applyTowerPgResourceViewStates,
    };

    unreadStoreMixin.applyTowerPgResourceViewStates.call(store, rows);
    const result = await unreadStoreMixin.markAllChannelThreadsRead.call(store, 'channel-a');
    expect(result).toEqual({ ok: true, count: 2 });
    expect(calls[0].map((resource) => resource.resource_id)).toEqual(['thread-a', 'thread-b']);
    expect(store._unreadChannels).toEqual({ 'channel-b': true });
    expect(store._unreadChat).toBe(true);
    expect(store.refreshTowerPgResourceViewStates).not.toHaveBeenCalled();
  });

  it('handles an empty channel without a Tower write', async () => {
    const store = {
      currentWorkspace: { pgBackendMode: true, workspaceId: 'workspace-1', directHttpsUrl: 'http://tower.test' },
      getResourceViewStates: vi.fn(async () => [state('thread-a', 'channel-a')]),
      markTowerPgResourcesViewed: vi.fn(),
      applyTowerPgResourceViewStates: vi.fn(),
      refreshTowerPgResourceViewStates: vi.fn(),
    };
    expect(await unreadStoreMixin.markAllChannelThreadsRead.call(store, 'channel-empty')).toEqual({ ok: true, count: 0, empty: true });
    expect(store.markTowerPgResourcesViewed).not.toHaveBeenCalled();
    expect(store.applyTowerPgResourceViewStates).toHaveBeenCalledOnce();
    expect(store.refreshTowerPgResourceViewStates).not.toHaveBeenCalled();
  });

  it('reports Tower failures without claiming success', async () => {
    const store = {
      currentWorkspace: { pgBackendMode: true, workspaceId: 'workspace-1', directHttpsUrl: 'http://tower.test' },
      getResourceViewStates: vi.fn(async () => [state('thread-a', 'channel-a')]),
      upsertResourceViewState: vi.fn(),
      applyTowerPgResourceViewStates: vi.fn(),
      markTowerPgResourcesViewed: vi.fn(async () => { throw new Error('Tower unavailable'); }),
      refreshTowerPgResourceViewStates: vi.fn(),
    };
    const result = await unreadStoreMixin.markAllChannelThreadsRead.call(store, 'channel-a');
    expect(result).toEqual({ ok: false, count: 0, error: 'Tower unavailable' });
    expect(store.refreshTowerPgResourceViewStates).not.toHaveBeenCalled();
  });

  it('anchors the action to the channel whose ellipsis was opened', async () => {
    const store = {
      selectedChannelId: 'stale-channel',
      selectedChannel: { record_id: 'opened-channel', metadata: {} },
      channels: [{ record_id: 'opened-channel', metadata: {} }],
      closeScopePicker: vi.fn(), closeChannelScopePicker: vi.fn(), preparePgChannelAccessPanel: vi.fn(),
      markAllChannelThreadsRead: vi.fn(async () => ({ ok: true, count: 2 })),
    };
    channelsManagerMixin.openChannelSettings.call(store, 'opened-channel');
    store.selectedChannelId = 'later-selection';
    await channelsManagerMixin.markChannelSettingsThreadsRead.call(store);
    expect(store.markAllChannelThreadsRead).toHaveBeenCalledWith('opened-channel');
    expect(store.channelSettingsNotice).toBe('Marked 2 threads as read.');
  });

  it('exposes the shared action and passes each rendered channel ID into the ellipsis handler', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toContain('data-testid="mark-channel-threads-read"');
    expect(html).toContain('Mark all threads as read');
    const settingsCalls = [...html.matchAll(/openChannelSettings\(([^)]*)\)/g)].map((match) => match[1]);
    expect(settingsCalls).toHaveLength(8);
    expect(settingsCalls.every((argument) => argument === 'channel.record_id' || argument === 'ch.record_id')).toBe(true);
  });
});
