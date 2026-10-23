import { describe, expect, it } from 'vitest';
import { openWorkspaceDb, deleteWorkspaceDb, getMessagePresentationWindowByChannel, getMessagePresentationWindowByChannels } from '../src/db.js';
import { buildThreadAwarePresentationWindow } from '../src/chat-presentation-cache.js';
import { instrumentIndexedDb } from './helpers/indexeddb-metrics.js';
import { scopeChatFixture } from './helpers/scope-chat-fixture.js';

describe('two-phase scope presentation', () => {
  for (const channelCount of [1, 10, 30]) it(`matches per-channel merge with ${channelCount} persisted channels and reads only surviving reply tails`, async () => {
    const key = `scope-two-phase-${channelCount}`;
    const db = openWorkspaceDb(key);
    await db.open();
    const { channels, rows } = scopeChatFixture(channelCount, { replies: 12 });
    await db.chat_messages.bulkPut(rows);
    const metrics = instrumentIndexedDb();
    try {
      const options = { rootLimit: 21 };
      const expected = buildThreadAwarePresentationWindow((await Promise.all(channels.map(id => getMessagePresentationWindowByChannel(id, options)))).flat(), options);
      const before = metrics.snapshot();
      metrics.reset();
      const actual = await getMessagePresentationWindowByChannels([...channels, channels[0]], options);
      const after = metrics.snapshot();
      expect(actual).toEqual(expected);
      expect(actual.some(row => row.record_id === 'failed-0')).toBe(true);
      expect(actual.some(row => row.record_id === 'pending-reply-0')).toBe(true);
      expect(after.valueRowsRead).toBeLessThanOrEqual(before.valueRowsRead);
      expect(after.readRequests).toBeLessThanOrEqual(before.readRequests);
      if (channelCount > 1) expect(after.valueRowsRead).toBeLessThan(before.valueRowsRead / 2);
      console.info(JSON.stringify({ channelCount, before, after }));
      // Focused old replies and active inherited membership must survive trimming.
      const active = rows.find(row => row.record_id === 'thread-0-0');
      active.pg_effective_message_ids = ['reply-0-0-0', 'reply-0-1-0'];
      active.pg_parent_thread_id = 'thread-0-1';
      active.pg_branch_point_message_id = 'reply-0-1-0';
      await db.chat_messages.put(active);
      for (const focusedOptions of [
        { ...options, activeThreadId: active.record_id, focusMessageId: 'reply-0-0-0' },
        { ...options, activeThreadId: 'root-0-0', focusMessageId: 'reply-0-1-0', replyLimit: 6 },
        { ...options, before: { timestamp: '2026-10-01T00:30:00.000Z', recordId: 'root-0-18' } },
      ]) {
        const reference = buildThreadAwarePresentationWindow((await Promise.all(channels.map(id => getMessagePresentationWindowByChannel(id, focusedOptions)))).flat(), focusedOptions);
        expect(await getMessagePresentationWindowByChannels(channels, focusedOptions)).toEqual(reference);
      }
    } finally {
      metrics.restore();
      await deleteWorkspaceDb(key);
    }
  }, 30000);
  it('returns an empty scope without reading message rows', async () => {
    expect(await getMessagePresentationWindowByChannels([])).toEqual([]);
  });
});

it('observes a new root beyond the current indexed boundary in a multi-channel liveQuery', async () => {
  const { liveQuery } = await import('dexie');
  const key = 'scope-chat-live-boundary';
  const db = openWorkspaceDb(key); await db.open();
  const { channels, rows } = scopeChatFixture(10, { replies: 2 });
  await db.chat_messages.bulkPut(rows);
  let subscription;
  try {
    await new Promise((resolve, reject) => {
      let inserted = false;
      const timer = setTimeout(() => reject(new Error('new indexed root was not observed')), 3000);
      subscription = liveQuery(() => getMessagePresentationWindowByChannels(channels, { rootLimit: 21 })).subscribe({
        async next(values) {
          if (values.some(row => row.record_id === 'newest')) { clearTimeout(timer); resolve(); return; }
          if (!inserted) {
            inserted = true;
            await db.chat_messages.put({ record_id:'newest',channel_id:channels[0],updated_at:'2026-10-23T00:00:00.000Z' });
          }
        }, error: reject,
      });
    });
  } finally { subscription?.unsubscribe(); await deleteWorkspaceDb(key); }
});
