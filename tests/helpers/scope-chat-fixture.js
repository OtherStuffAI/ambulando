// Shared persisted fixture for unit parity and real-browser IndexedDB measurements.
export function scopeChatFixture(channelCount, { roots = 24, replies = 90 } = {}) {
  const channels = Array.from({ length: channelCount }, (_, i) => `scope-channel-${i}`);
  const rows = [];
  const row = (id, channel, time, patch = {}) => ({
    record_id: id, channel_id: channel, parent_message_id: null,
    body: `Persisted conversation ${id}`, pg_backend: true, pg_record_type: 'message',
    record_state: 'active', sync_status: 'synced', version: 1,
    updated_at: new Date(Date.UTC(2026, 9, 1) + time * 1000).toISOString(), ...patch,
  });
  for (const [c, channel] of channels.entries()) {
    for (let r = 0; r < roots; r++) {
      const id = `root-${c}-${r}`;
      const threadId = `thread-${c}-${r}`;
      // Ties across channels exercise the deterministic identity tie-breaker.
      rows.push(row(id, channel, r * 100, { pg_thread_id: threadId }));
      rows.push(row(threadId, channel, r * 100, { pg_record_type: 'thread',
        pg_thread_id: threadId, pg_source_message_id: id, pg_reply_count: replies }));
      for (let p = 0; p < replies; p++) rows.push(row(`reply-${c}-${r}-${p}`, channel, r * 100 + p + 1,
        { parent_message_id: id, pg_thread_id: threadId }));
    }
    rows.push(row(`failed-${c}`, channel, -100, { sync_status: 'failed' }));
    rows.push(row(`pending-reply-${c}`, channel, -99,
      { parent_message_id: `root-${c}-0`, pg_thread_id: `thread-${c}-0`, sync_status: 'pending' }));
    rows.push(row(`deleted-${c}`, channel, 100000, { record_state: 'deleted' }));
    rows.push(row(`archived-${c}`, channel, 500, { record_state: 'archived' }));
  }
  return { channels, rows };
}
