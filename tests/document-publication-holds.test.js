import { beforeEach, describe, expect, it } from 'vitest';
import { openWorkspaceDb, createWorkspaceDb, upsertDocumentDraft, getDocumentDraft, deleteDocumentDraft, replacePgMessagesForChannel } from '../src/db.js';
import { consumeThreadDocDetaches, readPublicationHold, releasePublicationHold } from '../src/docs/publication-holds.js';
import { applyPgRecordChanges } from '../src/pg-record-delta.js';
import fixture from './fixtures/flightdeck-record-delta-v1.json';

const thread = fixture.canonical_upserts.changes.find(change => change.family === 'thread');
const workspace = thread.workspace_id, doc = '00000000-0000-4000-8000-000000000001';
const store = { workspaceId: workspace, workspaceOwnerNpub: 'owner', backendUrl: 'http://localhost:3000', session: { npub: 'viewer' },
  currentWorkspace: { workspaceId: workspace, workspaceOwnerNpub: 'owner', pgBackendMode: true } };
const metadata = items => ({ unrelated: { keep: true }, ambulando_thread_artefacts: { version: 1, items } });
const row = (version, value = metadata([])) => ({ ...thread.row, id: thread.id, workspace_id: workspace, row_version: version, metadata: value });
const page = (version, value) => ({ ...fixture.one_message_delta, next_cursor: `hold-${version}`, has_more: false,
  changes: [{ ...thread, version: String(version), row: row(version, value) }] });
let db;
beforeEach(async () => {
  db = openWorkspaceDb('publication-holds-tests'); await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
});

describe('canonical thread removal publication holds', () => {
  it('consumes native membership removal atomically and survives an independent connection/reopen', async () => {
    await upsertDocumentDraft({ workspace_id: workspace, document_id: doc, content: 'unsent', draft_status: 'dirty' });
    await applyPgRecordChanges(store, page(10, metadata([{ kind: 'doc', id: doc }, { kind: 'file', id: 'file' }])));
    expect(await readPublicationHold(db, workspace, doc)).toBeNull();
    await applyPgRecordChanges(store, page(11, metadata([{ kind: 'file', id: 'file' }])));
    const hold = await readPublicationHold(db, workspace, doc);
    expect(hold?.generation).toBeTruthy();
    expect(await deleteDocumentDraft(workspace, doc)).toBe(false);
    const independent = createWorkspaceDb('publication-holds-tests'); await independent.open();
    try {
      expect(await readPublicationHold(independent, workspace, doc)).toEqual(hold);
      expect((await independent.document_drafts.get(`${workspace}:${doc}`)).content).toBe('unsent');
      expect(await independent.documents.count()).toBe(0); // no source deletion/write
    } finally { independent.close(); }
    db.close(); await db.open();
    expect(await readPublicationHold(db, workspace, doc)).toEqual(hold);
    await applyPgRecordChanges(store, page(10, metadata([{ kind: 'doc', id: doc }])));
    expect(await readPublicationHold(db, workspace, doc)).toEqual(hold);
  });

  it('does not infer detach from unknown/absent metadata, initial empty, or permission deletion', async () => {
    await applyPgRecordChanges(store, page(10, metadata([{ kind: 'doc', id: doc }])));
    await applyPgRecordChanges(store, page(11, {}));
    await applyPgRecordChanges(store, page(12, { ambulando_thread_artefacts: { version: 2, items: [] } }));
    await applyPgRecordChanges(store, page(13, metadata([])));
    expect(await readPublicationHold(db, workspace, doc)).toBeNull();
    await db.transaction('rw', db.sync_state, () => consumeThreadDocDetaches(db, row(10), { ...row(11), workspace_id: 'other' }));
    expect(await readPublicationHold(db, 'other', doc)).toBeNull();
  });

  it('protects newer hold generations and newer drafts from reviewed release', async () => {
    let version = 10;
    const renew = () => { version += 2; return db.transaction('rw', db.sync_state, () => consumeThreadDocDetaches(db, row(version - 1, metadata([{ kind: 'doc', id: doc }])), row(version))); };
    await renew();
    const old = await readPublicationHold(db, workspace, doc);
    const reviewed = await upsertDocumentDraft({ workspace_id: workspace, document_id: doc, content: 'reviewed', draft_status: 'dirty' });
    await renew();
    const current = await readPublicationHold(db, workspace, doc);
    expect(await releasePublicationHold(db, workspace, doc, old.generation, reviewed.draft_revision)).toBe(false);
    const newer = await upsertDocumentDraft({ ...reviewed, content: 'newer edits' });
    expect(await releasePublicationHold(db, workspace, doc, current.generation, reviewed.draft_revision)).toBe(false);
    expect((await getDocumentDraft(workspace, doc)).content).toBe('newer edits');
    expect(await releasePublicationHold(db, workspace, doc, current.generation, newer.draft_revision)).toBe(true);
    expect(await getDocumentDraft(workspace, doc)).toBeFalsy();
    expect(await readPublicationHold(db, workspace, doc)).toBeNull();
  });

  it('also consumes the typed-read fallback without changing unrelated membership metadata', async () => {
    const local = (version, value) => ({ record_id: thread.id, channel_id: thread.channel_id, pg_backend: true, pg_record_type: 'thread',
      pg_workspace_id: workspace, pg_metadata: value, version, sync_status: 'synced' });
    await replacePgMessagesForChannel(thread.channel_id, [local(10, metadata([{ kind: 'doc', id: doc }]))]);
    await replacePgMessagesForChannel(thread.channel_id, [local(11, metadata([]))]);
    expect((await readPublicationHold(db, workspace, doc))?.generation).toBeTruthy();
    expect((await db.chat_messages.get(thread.id)).pg_metadata).toEqual(metadata([]));
    const hold = await readPublicationHold(db, workspace, doc);
    await applyPgRecordChanges(store, page(10, metadata([{ kind: 'doc', id: doc }])));
    await applyPgRecordChanges(store, page(11, metadata([])));
    expect(await readPublicationHold(db, workspace, doc)).toEqual(hold);
    expect(await releasePublicationHold(db, workspace, doc, hold.generation)).toBe(true);
    await db.transaction('rw', db.sync_state, () => consumeThreadDocDetaches(db, row(10, metadata([{ kind: 'doc', id: doc }])), row(11)));
    expect(await readPublicationHold(db, workspace, doc)).toBeNull();
  });
});
