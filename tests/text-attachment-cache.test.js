import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openWorkspaceDb, putTextAttachmentCache, getTextAttachmentCache, putTextAttachmentDraft, listTextAttachmentDrafts } from '../src/db.js';

it('stores proxied edit metadata as plain records while preserving exact binary bytes', async () => {
  const db = openWorkspaceDb(`text-proxy-${crypto.randomUUID()}`);
  const bytes = new TextEncoder().encode('é😀\r\nexact');
  const lineage = new Proxy({ id: 'file', current_version_id: 'v1', row_version: 3 }, {});
  const command = new Proxy({ bytes, lineage, filename: 'a.txt', mutationId: 'stable', message: new Proxy({ record_id: 'msg' }, {}) }, {});
  await putTextAttachmentCache({ key: 'edit', command }, db);
  const row = await getTextAttachmentCache('edit', db);
  expect(row.command.lineage).toEqual({ id: 'file', current_version_id: 'v1', row_version: 3 });
  expect(row.command.bytes).toBeInstanceOf(Uint8Array);
  expect(Array.from(row.command.bytes)).toEqual(Array.from(bytes));
  await putTextAttachmentDraft({ draft_id: 'd', composer_draft_key: 'composer', bytes, text_attachment: new Proxy({ v: 1 }, {}), created_at: 'now' }, db);
  const [draft] = await listTextAttachmentDrafts('composer', db);
  expect(Array.from(draft.bytes)).toEqual(Array.from(bytes));
  await db.delete();
});
