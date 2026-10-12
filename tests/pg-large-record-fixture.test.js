import { beforeEach, expect, it } from 'vitest';
import fixture from './fixtures/tower-bounded-record-snapshots-v1.json';
import { openWorkspaceDb } from '../src/db.js';
import { hydrateTowerPgSyncBundle, resolveTowerPgWorkspaceContext } from '../src/pg-read-hydrator.js';
import { recordDeltaCursorKey } from '../src/pg-record-delta.js';
import { DEVICE_CACHE_OWNER_KEY, deviceCheckpointScope } from '../src/pg-device-checkpoints.js';

let db;
beforeEach(async () => {
  db = openWorkspaceDb('tower-large-fixture'); await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
});

it('consumes Tower’s pinned shared UTF-8 chunk fixture and produces its exact receipt after local commit', async () => {
  const store = { backendUrl: 'http://localhost:3100', session: { npub: 'viewer' },
    currentWorkspace: { workspaceId: fixture.envelope.change.workspace_id, workspaceOwnerNpub: 'owner', pgBackendMode: true } };
  const context = resolveTowerPgWorkspaceContext(store), key = recordDeltaCursorKey(store), scope = deviceCheckpointScope(context);
  const options = { deviceScope: scope, expectedCursor: 'prior-local-cursor', expectedGeneration: 0,
    authorityEpoch: fixture.page.handover.authority_epoch, largeRecords: 'chunked_v1' };
  await db.sync_state.put({ key, value: { cursor: options.expectedCursor, localGeneration: 0, snapshotComplete: true,
    device: { clientId: fixture.page.client_id, scope, authorityEpoch: options.authorityEpoch, revision: '0', registered: true } } });
  await db.sync_state.put({ key: DEVICE_CACHE_OWNER_KEY, value: { cursorKey: key, clientId: fixture.page.client_id, scope, canonicalCount: 0 } });
  const envelope = structuredClone(fixture.envelope);
  envelope.change.row.body = fixture.body_fixture.text.repeat(fixture.body_fixture.repeat);
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)), manifest = fixture.page.large_records[0];
  expect(bytes.byteLength).toBe(manifest.total_bytes);
  const materialize = action => hydrateTowerPgSyncBundle(store, { protocol_version: 2, large_record_action: action, local_apply_options: options });
  await materialize({ type: 'begin', page: fixture.page });
  for (let index = 0; index < manifest.chunk_count; index++) {
    await materialize({ type: 'chunk', index, bytes: bytes.slice(index * manifest.chunk_bytes, (index + 1) * manifest.chunk_bytes) });
    expect((await db.sync_state.get(key)).value.cursor).toBe(options.expectedCursor);
    expect(await db.pg_record_rows.count()).toBe(0);
  }
  await materialize({ type: 'finish' });
  expect((await db.chat_messages.get(envelope.change.id)).body).toBe(envelope.change.row.body);
  const committed = (await db.sync_state.get(key)).value;
  expect({ cursor: committed.device.pendingAck.cursor, expected_revision: committed.device.pendingAck.expectedRevision,
    large_record_receipts: committed.device.pendingAck.largeRecordReceipts }).toEqual(fixture.acknowledgement);
  expect(committed.handover).toEqual(fixture.page.handover);
  expect(await db.sync_state.where('key').startsWith('record-large-assembly').count()).toBe(0);
});
