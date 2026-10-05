import { describe, expect, it, vi } from 'vitest';
import {
  deriveUnreadAggregates,
  deriveUnreadResources,
  mapTowerResourceViewState,
  readCompleteResourceViewStateSnapshot,
} from '../src/resource-view-state.js';
import { unreadStoreMixin } from '../src/unread-store.js';

describe('Tower resource view state', () => {
  it('styles only unread root thread messages using the actual Tower thread ID', () => {
    const store = { _unreadThreadItems: { 'tower-thread-1': true } };
    store.isThreadUnread = unreadStoreMixin.isThreadUnread;
    expect(unreadStoreMixin.isRootThreadUnread.call(store, {
      record_id: 'source-message-1',
      pg_thread_id: 'tower-thread-1',
      parent_message_id: null,
    })).toBe(true);
    expect(unreadStoreMixin.isRootThreadUnread.call(store, {
      record_id: 'reply-1',
      pg_thread_id: 'tower-thread-1',
      parent_message_id: 'source-message-1',
    })).toBe(false);
    expect(unreadStoreMixin.isRootThreadUnread.call(store, {
      record_id: 'source-message-2',
      pg_thread_id: 'tower-thread-read',
      parent_message_id: null,
    })).toBe(false);
    unreadStoreMixin.applyTowerPgResourceViewStates.call(store, [
      { resource_type: 'thread', resource_id: 'tower-thread-1', activity_version: 4, viewed_activity_version: 4 },
    ]);
    expect(unreadStoreMixin.isRootThreadUnread.call(store, {
      record_id: 'source-message-1',
      pg_thread_id: 'tower-thread-1',
      parent_message_id: null,
    })).toBe(false);
  });

  it('uses activity_version > viewed_activity_version per actual resource', () => {
    const resources = [
      { resource_type: 'thread', record_id: 'thread-a', channel_id: 'channel-a', activity_version: 3 },
      { resource_type: 'thread', record_id: 'thread-b', channel_id: 'channel-a', activity_version: 2 },
    ];
    const unread = deriveUnreadResources(resources, [
      { resource_type: 'thread', resource_id: 'thread-a', viewed_activity_version: 3 },
      { resource_type: 'thread', resource_id: 'thread-b', viewed_activity_version: 1 },
    ]);
    expect(unread).toEqual({ 'thread:thread-b': true });
  });

  it('excludes deleted and archived resources from descendants and aggregates', () => {
    const resources = [
      { resource_type: 'task', record_id: 'task-a', channel_id: 'channel-a', activity_version: 2 },
      { resource_type: 'document', record_id: 'doc-a', channel_id: 'channel-b', activity_version: 2, deleted_at: 'now' },
    ];
    const unread = deriveUnreadResources(resources, []);
    expect(deriveUnreadAggregates(resources, unread)).toEqual({
      channels: { 'channel-a': true },
      sections: { chat: false, tasks: true, docs: false },
      deck: true,
    });
  });

  it('maps the confirmed Tower shape into a deterministic Dexie row', () => {
    expect(mapTowerResourceViewState({
      resource_type: 'document', resource_id: 'doc-a', viewed_activity_version: 7,
      scope_id: 'scope-a', channel_id: 'channel-a', row_version: 2, updated_at: '2026-01-01T00:00:00Z',
    })).toMatchObject({
      record_id: 'document:doc-a', resource_type: 'document', resource_id: 'doc-a',
      viewed_activity_version: 7, sync_status: 'synced',
    });
  });

  it('derives resource, channel, section, and Deck dots from unread descendants', () => {
    const store = {
      _unreadThreadItems: {}, _unreadTaskItems: {}, _unreadDocItems: {}, _unreadChannels: {},
      _unreadChat: false, _unreadTasks: false, _unreadDocs: false,
    };
    unreadStoreMixin.applyTowerPgResourceViewStates.call(store, [
      { resource_type: 'thread', resource_id: 'thread-a', channel_id: 'channel-a', activity_version: 2, viewed_activity_version: 1 },
      { resource_type: 'thread', resource_id: 'thread-b', channel_id: 'channel-a', activity_version: 1, viewed_activity_version: 1 },
      { resource_type: 'document', resource_id: 'doc-a', channel_id: 'channel-b', activity_version: 4, viewed_activity_version: 3 },
    ]);
    expect(store._unreadThreadItems).toEqual({ 'thread-a': true });
    expect(store._unreadDocItems).toEqual({});
    expect(store._unreadChannels).toEqual({ 'channel-a': true });
    expect(Object.getOwnPropertyDescriptor(unreadStoreMixin, 'unreadDeck').get.call(store)).toBe(true);
  });

  it('exhausts opaque Tower cursors before returning a complete snapshot', async () => {
    const readPage = vi.fn(async (cursor) => cursor == null
      ? { states: [{ resource_id: 'task-1' }], baseline_created: true, next_cursor: 'page-2' }
      : { states: [{ resource_id: 'task-2' }], baseline_created: false, next_cursor: null });
    await expect(readCompleteResourceViewStateSnapshot(readPage)).resolves.toEqual({
      states: [{ resource_id: 'task-1' }, { resource_id: 'task-2' }],
      baseline_created: true,
      next_cursor: null,
    });
    expect(readPage).toHaveBeenNthCalledWith(1, null);
    expect(readPage).toHaveBeenNthCalledWith(2, 'page-2');
  });

  it('rejects repeated Tower cursors instead of replacing Dexie with a partial snapshot', async () => {
    const readPage = vi.fn(async () => ({ states: [], next_cursor: 'same-cursor' }));
    await expect(readCompleteResourceViewStateSnapshot(readPage)).rejects.toThrow('repeated cursor');
  });
});
