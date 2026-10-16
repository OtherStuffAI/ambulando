import { beforeEach, expect, it } from 'vitest';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import { openWorkspaceDb } from '../src/db.js';
import { applyPgRecordChanges, recordDeltaCursorKey, resetPgRecordAuthority } from '../src/pg-record-delta.js';
import { pgDownloadedAccess, projectPgDownloadedAccess } from '../src/pg-access-state.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const store = { backendUrl: 'http://localhost:3100', session: { npub: 'viewer' }, currentWorkspace: { workspaceId, workspaceOwnerNpub: 'owner', pgBackendMode: true } };
let db;
const delta = (changes, cursor, access_changes = [], access_revision = '1') => ({ ...fixture.one_message_delta, changes, next_cursor: cursor, access_revision, access_changes, retention_policy: 'retain_downloaded' });
const authority = async () => (await db.sync_state.get(recordDeltaCursorKey(store))).value;
beforeEach(async () => { db = openWorkspaceDb('additive-access'); await db.open(); await Promise.all(db.tables.map(t => t.clear())); await applyPgRecordChanges(store, delta(fixture.canonical_upserts.changes, 'seed')); });
it('commits family-specific loss with cursor, preserving content, canonical rows and intent', async () => {
  const doc = fixture.canonical_upserts.changes.find(c => c.family === 'doc');
  const before = await db.pg_record_rows.count();
  await db.pending_writes.add({ record_id: doc.id, envelope: { title: 'unsent edit' } });
  const loss = { family: 'doc', resource_type: 'channel', resource_id: doc.channel_id, status: 'lost' };
  await applyPgRecordChanges(store, delta([], 'lost', [loss], '2'), { expectedCursor: 'seed' });
  expect(await db.pg_record_rows.count()).toBe(before);
  expect(await db.pending_writes.count()).toBe(1);
  expect(pgDownloadedAccess(await db.documents.get(doc.id), await authority())).toBe('access-lost');
  expect(pgDownloadedAccess({ pg_record_type: 'message', channel_id: doc.channel_id }, await authority())).toBe('current');
  expect((await authority()).cursor).toBe('lost');
  await applyPgRecordChanges(store, delta([], 'granted', [{ ...loss, status: 'granted' }], '3'));
  expect(pgDownloadedAccess(await db.documents.get(doc.id), await authority())).toBe('current');
});
it('rolls access metadata back with a failed final page and rejects regressed observations', async () => {
  const loss = { family: 'message', resource_type: 'workspace', resource_id: workspaceId, status: 'lost' };
  await expect(applyPgRecordChanges(store, delta([], 'lost', [loss], '2'), { beforeCommit: () => { throw Error('interrupted'); } })).rejects.toThrow('interrupted');
  expect((await authority()).cursor).toBe('seed'); expect((await authority()).accessRevision).toBe('1');
  await expect(applyPgRecordChanges(store, delta([], 'bad', [loss], '0'))).rejects.toThrow('regressed');
});
it('merges newly authorized old history as delta without replacing unrelated content', async () => {
  const c = fixture.one_message_delta.changes[0], old = { ...c, id: 'older-history', version: '1', row: { ...c.row, id: 'older-history', created_at: '2020-01-01T00:00:00Z', body: 'older history' } };
  const before = await db.documents.toArray();
  await applyPgRecordChanges(store, { ...delta([old], 'catchup'), catchup: { family: 'message', resource_type: 'channel', resource_id: c.channel_id } });
  expect((await db.chat_messages.get(old.id)).body).toBe('older history');
  expect(await db.documents.toArray()).toEqual(before); expect((await authority()).localGeneration || 0).toBe(0);
});
it('preserves same-reader repair but keeps an explicit identity replacement isolated', async () => {
  const before = await db.pg_record_rows.count();
  await resetPgRecordAuthority(store, { preserveViews: true, accessLost: true });
  expect(await db.pg_record_rows.count()).toBe(before);
  expect(projectPgDownloadedAccess(await db.documents.toArray(), await authority()).every(row => row.pg_access_status === 'access-lost')).toBe(true);
  await resetPgRecordAuthority(store, { preserveViews: false });
  expect(await db.pg_record_rows.count()).toBe(0);
});
it('retains a forbidden optimistic task edit as a durable failed intent', async () => {
  const c = fixture.canonical_upserts.changes.find(c => c.family === 'task');
  const previous = await db.tasks.get(c.id), task = { ...previous, title: 'Local intended title', sync_status: 'pending' };
  const command = prepareTowerWorkspaceCommand(store, 'task.update', { task, previousTask: previous });
  await command.optimistic(); await command.fail(Object.assign(Error('forbidden'), { status: 403 }));
  expect(await db.tasks.get(c.id)).toMatchObject({ title: 'Local intended title', sync_status: 'failed', pg_blocked_command: { name: 'task.update' } });
});
it('clears membership-loss status only after every bounded recovery chunk commits', async () => {
  const { markPgRecordAccessLost } = await import('../src/pg-record-delta.js');
  await markPgRecordAccessLost(store, { expectedCursor: 'seed', expectedGeneration: 0 });
  const c = fixture.one_message_delta.changes[0];
  const rows = Array.from({ length: 70 }, (_, index) => ({ ...c, id: `regained-${index}`, row: { ...c.row, id: `regained-${index}` } }));
  await applyPgRecordChanges(store, delta(rows, 'regained', [], '2'), { expectedCursor: 'seed', expectedAccessLost: true });
  expect((await authority()).accessLost).toBe(false); expect((await authority()).cursor).toBe('regained');
  expect(await db.chat_messages.count()).toBeGreaterThanOrEqual(70);
});
it('fences a page issued before membership loss without changing its checkpoint generation', async () => {
  const { markPgRecordAccessLost } = await import('../src/pg-record-delta.js');
  await markPgRecordAccessLost(store, { expectedCursor: 'seed', expectedGeneration: 0 });
  await expect(applyPgRecordChanges(store, delta([], 'late'), { expectedCursor: 'seed', expectedAccessLost: false })).rejects.toThrow('access changed');
  expect((await authority()).cursor).toBe('seed'); expect((await authority()).localGeneration || 0).toBe(0);
});
it('keeps document and task read-state access selectors separate', async () => {
  const channel = fixture.one_message_delta.changes[0].channel_id;
  await applyPgRecordChanges(store, delta([], 'view-loss', [{ family: 'resource_view_state', resource_kind: 'document', resource_type: 'channel', resource_id: channel, status: 'lost' }], '2'));
  expect(pgDownloadedAccess({ pg_delta_family: 'resource_view_state', resource_type: 'document', channel_id: channel }, await authority())).toBe('access-lost');
  expect(pgDownloadedAccess({ pg_delta_family: 'resource_view_state', resource_type: 'task', channel_id: channel }, await authority())).toBe('current');
});
it('leaves access projection untouched on an unrelated ordinary delta', async () => {
  const { liveQuery } = await import('dexie');
  const key = `${recordDeltaCursorKey(store)}:record-access`, emissions = [];
  const subscription = liveQuery(() => db.sync_state.get(key)).subscribe(row => emissions.push(row));
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const before = emissions.length;
    await applyPgRecordChanges(store, delta([], 'unrelated'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(emissions).toHaveLength(before);
  } finally { subscription.unsubscribe(); }
});
