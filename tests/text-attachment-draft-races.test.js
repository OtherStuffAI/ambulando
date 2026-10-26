import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ current: {}, rows: new Map(), put: vi.fn(), remove: vi.fn() }));
vi.mock('../src/db.js', () => ({
  getWorkspaceDb: () => mocks.current,
  putTextAttachmentDraft: (...args) => mocks.put(...args),
  deleteTextAttachmentDrafts: (...args) => mocks.remove(...args),
  listTextAttachmentDrafts: async () => [],
}));
import { persistTextDraft, discardPersistedTextDrafts } from '../src/text-attachment-drafts.js';
const bytes = text => new TextEncoder().encode(text);
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const draft = (id, file) => ({ draft_id: id, composer_draft_key: 'destination', filename: 'a.txt', text_attachment: { v: 1 }, file });
beforeEach(() => {
  mocks.current = {}; mocks.rows.clear();
  mocks.put.mockImplementation(async (row, db) => { mocks.rows.set(row.draft_id, { ...row, db }); });
  mocks.remove.mockImplementation(async ids => { for (const id of ids) mocks.rows.delete(id); });
});
it('tombstones a removed draft while its exact bytes are still being read', async () => {
  const wait = gate();
  const value = draft(crypto.randomUUID(), { arrayBuffer: () => wait.promise });
  const writing = persistTextDraft({ currentWorkspaceKey: 'old' }, 'message', value);
  await Promise.resolve();
  const removing = discardPersistedTextDrafts([value]);
  wait.release(bytes('late').buffer);
  await Promise.all([writing, removing]);
  expect(mocks.rows.size).toBe(0);
  expect(await persistTextDraft({}, 'message', value)).toBe(false);
});
it('preserves newer bytes and the captured database after a workspace switch', async () => {
  const wait = gate(); const id = crypto.randomUUID(); const originalDb = mocks.current;
  const first = draft(id, { arrayBuffer: () => wait.promise });
  const store = { currentWorkspaceKey: 'original' };
  const writing = persistTextDraft(store, 'message', first);
  await Promise.resolve();
  mocks.current = {}; store.currentWorkspaceKey = 'different';
  const edited = persistTextDraft(store, 'message', { ...first, file: { arrayBuffer: async () => bytes('new').buffer } });
  wait.release(bytes('old').buffer);
  await Promise.all([writing, edited]);
  expect(new TextDecoder().decode(mocks.rows.get(id).bytes)).toBe('new');
  expect(mocks.rows.get(id).db).toBe(originalDb);
  expect(mocks.rows.get(id).workspace_id).toBe('original');
});
it('keeps prior durable bytes and reports a recoverable quota failure', async () => {
  const store = { currentWorkspaceKey: 'original' }; const id = crypto.randomUUID();
  const first = draft(id, { arrayBuffer: async () => bytes('before').buffer });
  await persistTextDraft(store, 'message', first);
  mocks.put.mockRejectedValueOnce(new Error('quota'));
  const changed = { ...first, file: { arrayBuffer: async () => bytes('after').buffer } };
  expect(await persistTextDraft(store, 'message', changed)).toBe(false);
  expect(store.error).toContain('quota');
  expect(new TextDecoder().decode(mocks.rows.get(id).bytes)).toBe('before');
});
