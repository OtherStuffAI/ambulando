import { beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceDb } from '../src/db.js';
import { observeContextScope } from '../src/context-cache.js';
import { applyPgRecordChanges, resetPgRecordAuthority } from '../src/pg-record-delta.js';
import { PG_RECORD_DELTA_FAMILIES } from '../src/pg-record-delta.js';
import fixture from './fixtures/context-record-delta-v1.json';
const workspaceId = fixture.components[0].workspace_id, scopeId = fixture.components[0].scope_id;
const store = { currentWorkspace: { workspaceId, workspaceOwnerNpub: 'owner', pgBackendMode: true }, session: { npub: 'viewer' } };
let db;
beforeEach(async () => { db = openWorkspaceDb('context-cache-tests'); await db.open(); await Promise.all(db.tables.map(t => t.clear())); });
const changes = [...fixture.components.map(row => ({ family: 'context_component', row })), ...fixture.references.map(row => ({ family: 'context_reference', row }))]
  .map((c, i) => ({ ...c, id: c.row.id, operation: 'upsert', version: String(i + 1), workspace_id: workspaceId, scope_id: scopeId, channel_id: null }));
const page = (rows, cursor, more = false) => ({ protocol_version: 1, families: PG_RECORD_DELTA_FAMILIES, mode: 'delta', changes: rows,
  next_cursor: cursor, has_more: more, snapshot_id: null, snapshot_complete: false, partitions_complete: [] });
it('stages multipage recovery, commits both collections together and keeps replay/tombstones authoritative', async () => {
  await applyPgRecordChanges(store, page(changes.slice(0, 1), 'a', true));
  expect(await db.context_components.count()).toBe(0);
  await applyPgRecordChanges(store, page(changes.slice(1), 'b'));
  expect(await db.context_components.count()).toBe(2); expect(await db.context_references.count()).toBe(1);
  const deleted = changes.map((c, i) => ({ ...c, operation: 'delete', row: null, version: String(i + 10) }));
  await applyPgRecordChanges(store, page(deleted.slice(0, 1), 'c', true));
  expect(await db.context_components.count()).toBe(2);
  await applyPgRecordChanges(store, page(deleted.slice(1), 'd'));
  expect(await db.context_components.count()).toBe(0); expect(await db.context_references.count()).toBe(0);
  await applyPgRecordChanges(store, page(changes, 'e'));
  expect(await db.context_components.count()).toBe(0);
});
it('never publishes orphan/cyclic/cross-scope rows, even in malformed parent recovery', async () => {
  await applyPgRecordChanges(store, page(changes.slice(1), 'a'));
  expect(await db.context_components.count()).toBe(0); expect(await db.context_references.count()).toBe(0);
  await applyPgRecordChanges(store, page([changes[0]], 'b'));
  expect(await db.context_components.count()).toBe(2);
});
it('atomically rolls back terminal projection and cursor on failure', async () => {
  await expect(applyPgRecordChanges(store, page(changes, 'a'), { beforeCommit() { throw Error('crash'); } })).rejects.toThrow('crash');
  expect(await db.context_components.count()).toBe(0); expect(await db.pg_record_rows.count()).toBe(0);
});
it('fails closed on reset and removes omitted scope after multipage replacement', async () => {
  await applyPgRecordChanges(store, page(changes, 'a'));
  await resetPgRecordAuthority(store, { preserveViews: true });
  expect(await db.context_components.count()).toBe(0);
  const snapshot = { ...page([], 'b', true), mode: 'snapshot', snapshot_id: 'snapshot', snapshot_complete: true, partitions_complete: PG_RECORD_DELTA_FAMILIES };
  await applyPgRecordChanges(store, snapshot);
  await applyPgRecordChanges(store, page([], 'c'));
  expect(await db.context_components.count()).toBe(0); expect(await db.context_references.count()).toBe(0);
});
it('liveQuery distinguishes unloaded/loading/complete empty and isolates workspace ids', async () => {
  const values = []; const subscription = observeContextScope(db, workspaceId, scopeId).subscribe(value => values.push(value));
  await vi.waitFor(() => expect(values.at(-1)?.status).toBe('unloaded'));
  await db.context_coverage.put({ scope_id: scopeId, workspace_id: workspaceId, status: 'loading' });
  await vi.waitFor(() => expect(values.at(-1)?.status).toBe('loading'));
  await db.context_coverage.put({ scope_id: scopeId, workspace_id: workspaceId, status: 'complete' });
  await vi.waitFor(() => expect(values.at(-1)?.empty).toBe(true)); subscription.unsubscribe();
  const other=[];const sub=observeContextScope(db,'other',scopeId).subscribe(value=>other.push(value));
  await vi.waitFor(()=>expect(other.at(-1)?.status).toBe('unloaded'));expect(other.at(-1).components).toEqual([]);sub.unsubscribe();
});
it('scope archival clears context despite retained canonical component rows', async () => {
  const scope={family:'scope',id:scopeId,workspace_id:workspaceId,scope_id:scopeId,channel_id:null,operation:'delete',row:null,version:'20'};
  await applyPgRecordChanges(store,page(changes,'a'));
  await applyPgRecordChanges(store,page([scope],'b'));
  expect(await db.context_components.count()).toBe(0);expect(await db.context_references.count()).toBe(0);
});
