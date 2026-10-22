// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { canvasDocumentComments } from '../src/canvas/document-comments.js';

const context = { workspaceId: 'workspace', workspaceOwnerNpub: 'owner', appNpub: 'app', tower: 'tower', service: 'service', baseUrl: 'http://localhost:3100' };
const identity = { workspace_id: 'workspace', app_npub: 'app', tower_service_npub: 'tower', workspace_service_npub: 'service' };
const row = (id, extra = {}) => ({ id, doc_id: 'doc', workspace_id: 'workspace', body: id, row_version: 1, created_at: '2026-10-22T01:00:00Z', ...extra });
const payload = comments => ({ identity, comments });
const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
async function setup(read, create = vi.fn()) {
  const db = new Dexie(`document-comments-${crypto.randomUUID()}`);
  db.version(1).stores({ comments: 'record_id,target_record_id' }); await db.open();
  const put = value => db.comments.put(value);
  const state = canvasDocumentComments({ read, create, database: () => db, put, reconcile: (_id, rows) => db.comments.bulkPut(rows) });
  Object.assign(state, { naplet: { access: 'ready', source: { id: 'doc' } }, $store: { canvas: { context: () => context } }, $el: document.createElement('div') });
  state.init(); cleanups.push(async () => { state.destroy(); await db.delete(); });
  return { state, db, create };
}

it('requires fresh authorization before showing cached data, shares accepted rows and excludes stale cache', async () => {
  let done;
  const { state, db } = await setup(() => new Promise(resolve => { done = resolve; }));
  await db.comments.put({ record_id: 'stale', target_record_id: 'doc', pg_workspace_id: 'workspace', sync_status: 'synced', record_state: 'active' });
  const opening = state.openDocumentComments();
  expect(state.documentComments).toEqual([]);
  await vi.waitFor(() => expect(done).toBeTypeOf('function'));
  done(payload([row('existing'), row('reply', { parent_comment_id: 'existing' })])); await opening;
  await vi.waitFor(() => expect(state.documentRoots.map(r => r.record_id)).toEqual(['existing']));
  expect(state.documentReplies('existing')).toHaveLength(1);
  await db.comments.put({ record_id: 'new', target_record_id: 'doc', pg_workspace_id: 'workspace', sync_status: 'synced', record_state: 'active', body: 'Other napplet' });
  await vi.waitFor(() => expect(state.documentRoots).toHaveLength(2));
});

it('uses document route, preserves reply anchor and drafts on denied writes, reconciles uncertain acceptance', async () => {
  const comments = [row('root', { metadata: { anchor_quote: 'Quote', anchor_start_offset: 1, anchor_end_offset: 6 } })];
  let accepted;
  const create = vi.fn(async (_workspace, _doc, body) => {
    accepted = row('accepted', { ...body }); comments.push(accepted); throw new Error('Network response lost');
  });
  const { state } = await setup(vi.fn(async () => payload(comments)), create);
  await state.openDocumentComments();
  await vi.waitFor(() => expect(state.documentRoots).toHaveLength(1));
  state.$nextTick = () => {};
  state.startDocumentReply(state.documentRoots[0]); state.commentBody = 'A reply';
  await state.sendDocumentComment();
  expect(state.commentBody).toBe('A reply'); expect(state.commentError).toContain('draft is kept');
  expect(create.mock.calls[0].slice(0, 2)).toEqual(['workspace', 'doc']);
  expect(create.mock.calls[0][2]).toMatchObject({ parent_comment_id: 'root', metadata: { anchor_quote: 'Quote' } });
  await state.sendDocumentComment();
  expect(create).toHaveBeenCalledOnce(); expect(state.commentBody).toBe('');
  await vi.waitFor(() => expect(state.documentReplies('root')).toHaveLength(1));
});

it('rejects foreign authority and targets without exposing cached comments', async () => {
  const { state } = await setup(async () => ({ identity: { ...identity, app_npub: 'other' }, comments: [row('secret')] }));
  await state.openDocumentComments(); expect(state.commentsReady).toBe(false); expect(state.documentComments).toEqual([]);
  expect(state.commentError).toContain('authority');
});

it('discards late reads and writes after napplet removal', async () => {
  let done;
  const { state, db } = await setup(() => new Promise(resolve => { done = resolve; }));
  const opening = state.openDocumentComments(); await vi.waitFor(() => expect(done).toBeTypeOf('function')); state.destroy(); done(payload([row('late')])); await opening;
  expect(await db.comments.count()).toBe(0); expect(state.documentComments).toEqual([]);
});

it('leaves drafts intact on permission errors and sends whole-document metadata without a selection', async () => {
  const create = vi.fn(async () => { throw new Error('403 document comment permission denied'); });
  const { state } = await setup(async () => payload([]), create);
  await state.openDocumentComments(); state.commentBody = 'Keep this draft'; await state.sendDocumentComment();
  expect(state.commentBody).toBe('Keep this draft'); expect(state.commentError).toContain('403');
  expect(create.mock.calls[0][2]).not.toHaveProperty('parent_comment_id');
  expect(create.mock.calls[0][2].metadata).not.toHaveProperty('anchor_quote');
});

it('keeps an accepted row inserted before the first liveQuery emission', async () => {
  let done;
  const { state, db } = await setup(() => new Promise(resolve => { done = resolve; }));
  const opening = state.openDocumentComments();
  await vi.waitFor(() => expect(done).toBeTypeOf('function'));
  await db.comments.put({ record_id: 'accepted-during-load', target_record_id: 'doc', pg_workspace_id: 'workspace', sync_status: 'synced', record_state: 'active', body: 'Accepted concurrently' });
  done(payload([])); await opening;
  await vi.waitFor(() => expect(state.documentRoots.map(row => row.record_id)).toEqual(['accepted-during-load']));
});

it('clears drafts and ignores a late read when the source or access changes', async () => {
  let done;
  const { state, db } = await setup(() => new Promise(resolve => { done = resolve; }));
  const opening = state.openDocumentComments();
  await vi.waitFor(() => expect(done).toBeTypeOf('function'));
  state.commentBody = 'Old source draft'; state.naplet.source.id = 'other'; state.bindDocumentSource('other');
  done(payload([row('old-source')])); await opening;
  expect(state.commentBody).toBe(''); expect(state.commentsOpen).toBe(false); expect(await db.comments.count()).toBe(0);
  state.commentBody = 'Revoked draft'; state.bindDocumentSource(''); expect(state.commentBody).toBe('');
});
