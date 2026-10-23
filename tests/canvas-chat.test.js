import './setup.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canvasChatStore } from '../src/canvas/chat-page.js';

const catalog = vi.hoisted(() => ({ scopes: vi.fn(), channels: vi.fn() }));
vi.mock('../src/canvas/artifact-picker.js', () => ({ ArtifactCatalog: class { scopes(...args) { return catalog.scopes(...args); } channels(...args) { return catalog.channels(...args); } } }));
const context = { workspaceId: 'workspace', viewer: 'viewer', actorId: 'actor', dbKey: 'db' };
const thread = '20000000-0000-4000-8000-000000000002';
let listener;
beforeEach(() => {
  vi.stubGlobal('addEventListener', vi.fn((type, fn) => { listener = fn; }));
  vi.stubGlobal('removeEventListener', vi.fn());
  vi.stubGlobal('location', { origin: 'http://localhost' });
  catalog.scopes.mockResolvedValue({ scopes: [{ id: 'scope', title: 'Scope' }] });
  catalog.channels.mockResolvedValue({ channels: [{ id: 'channel', title: 'Channel' }] });
});
afterEach(() => vi.unstubAllGlobals());
function store(operations = {}) {
  const result = { ...canvasChatStore(), canvasId: 'canvas', canvas: { can_manage: true }, currentWorkspaceKey: 'db', naplets: [], highestZ: () => 1 };
  result.startChats(context, { persist: vi.fn(), refresh: vi.fn(), ...operations });
  return result;
}

it('places independent local drafts, then routes in exactly two selections without creating messages or naplets', async () => {
  const persist = vi.fn(), s = store({ persist });
  await s.placeChat({ x: 12, y: 34 });
  await s.placeChat({ x: 50, y: 80 });
  const [a, b] = s.chatDrafts;
  expect(a.id).not.toBe(b.id);
  expect(a.layout).toMatchObject({ x: 12, y: 34, width: 620, height: 640 });
  expect(a.chat.scopes).toHaveLength(1);
  await s.chooseChatScope(a, 'scope');
  s.chooseChatChannel(a, 'channel');
  const url = new URL(s.chatFrameUrl(a), 'http://localhost');
  expect(url.searchParams.get('canvaschannel')).toBe('channel');
  expect(url.searchParams.get('canvaskey')).toBe(a.id);
  expect(s.chatFrameUrl(b)).toBe('');
  expect(persist).not.toHaveBeenCalled();
});

it('accepts only its own iframe identity and serializes binding retries without resending', async () => {
  let finish;
  const persist = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const s = store({ persist });
  await s.placeChat({ x: 0, y: 0 });
  const draft = s.chatDrafts[0], source = {};
  vi.stubGlobal('document', { querySelectorAll: () => [{ dataset: { canvasChatFrame: draft.id }, contentWindow: source }] });
  const data = { type: 'ambulando-canvas-chat-bound', key: draft.id, threadId: thread };
  listener({ origin: 'https://other.invalid', source, data });
  listener({ origin: location.origin, source: {}, data });
  expect(draft.source.id).toBe('');
  listener({ origin: location.origin, source, data });
  listener({ origin: location.origin, source, data });
  await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
  expect(persist.mock.calls[0][0].source).toEqual({ type: 'chat_thread', id: thread });
  finish();
  await vi.waitFor(() => expect(draft.chat.busy).toBe(false));
  s.stopChats();
  expect(removeEventListener).toHaveBeenCalledWith('message', listener);
});

it('recovers a sent conversation after failed binding and reconciles an uncertain successful POST', async () => {
  const persist = vi.fn().mockRejectedValue(new Error('connection lost'));
  const s = store({ persist });
  await s.placeChat({ x: 0, y: 0 });
  const draft = s.chatDrafts[0];
  draft.source.id = thread;
  await s.persistChatDraft(draft);
  expect(draft.chat.error).toContain('Conversation sent');
  const recovered = store({ persist, refresh: async () => {
    recovered.naplets = recovered.mergeChatNaplets([{ id: 'server-naplet', source: { type: 'chat_thread', id: thread } }]);
  } });
  expect(recovered.chatDrafts[0].source.id).toBe(thread);
  await recovered.persistChatDraft(recovered.chatDrafts[0]);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(recovered.chatDrafts).toHaveLength(0);
  expect(recovered.naplets[0]._chatKey).toBe(draft.id);
});

it('removing a draft preserves its conversation and duplicated thread naplets retain unique render keys', async () => {
  const persist = vi.fn(), s = store({ persist });
  await s.placeChat({ x: 0, y: 0 });
  const draft = s.chatDrafts[0]; draft.source.id = thread;
  const rows = s.mergeChatNaplets(['a', 'b'].map(id => ({ id, source: { type: 'chat_thread', id: thread } })));
  expect(new Set(rows.map(row => row._chatKey || row.id)).size).toBe(2);
  await s.placeChat({ x: 0, y: 0 });
  s.removeChatDraft(s.chatDrafts[0]);
  expect(s.chatDrafts).toHaveLength(0);
  expect(persist).not.toHaveBeenCalled();
});

it('pauses embedded transport for hidden naplets and resumes without recreating editor state', async () => {
  const { canvasChatEmbedMixin } = await import('../src/canvas/chat-embed.js');
  const handlers = new Map(), parent = { postMessage: vi.fn() };
  vi.stubGlobal('window', { parent, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: vi.fn() });
  const s = { ...canvasChatEmbedMixin, canvasChatEmbedded: true, canvasChatVisible: false,
    ensureBackgroundSync: vi.fn(), stopBackgroundSync: vi.fn(), startThreadLiveActivity: vi.fn(), stopThreadLiveActivity: vi.fn(), updateResponseActivityTimer: vi.fn() };
  s.installCanvasChatLifecycle();
  const visibility = visible => ({ origin: location.origin, source: parent, data: { type: 'ambulando-canvas-chat-visibility', visible } });
  handlers.get('message')({ ...visibility(true), origin: 'https://other.invalid' });
  expect(s.ensureBackgroundSync).not.toHaveBeenCalled();
  handlers.get('message')(visibility(true));
  handlers.get('message')(visibility(true));
  expect(s.ensureBackgroundSync).toHaveBeenCalledTimes(1);
  handlers.get('message')(visibility(false));
  expect(s.stopBackgroundSync).toHaveBeenCalledTimes(1);
  handlers.get('message')(visibility(true));
  expect(s.ensureBackgroundSync).toHaveBeenCalledTimes(2);
  handlers.get('pagehide')({ persisted: true });
  expect(s.canvasChatVisible).toBe(false);
  handlers.get('pageshow')({ persisted: true });
  expect(parent.postMessage).toHaveBeenCalledTimes(2);
});

it('re-reads channel authority after a concurrent command cancellation, without retrying denied reads', async () => {
  const { hydrateCanvasChatChannel } = await import('../src/canvas/chat-embed.js');
  const hydrate = vi.fn().mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'pg_read_authority_changed' })).mockResolvedValue({ record_id: 'channel' });
  await expect(hydrateCanvasChatChannel({}, 'channel', hydrate)).resolves.toEqual({ record_id: 'channel' });
  expect(hydrate).toHaveBeenCalledTimes(2);
  const denied = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { status: 403 }));
  await expect(hydrateCanvasChatChannel({}, 'channel', denied)).rejects.toThrow('denied');
  expect(denied).toHaveBeenCalledTimes(1);
  const changing = vi.fn().mockRejectedValue(Object.assign(new Error('changed'), { code: 'pg_read_authority_changed' }));
  await expect(hydrateCanvasChatChannel({}, 'channel', changing)).rejects.toThrow('changed');
  expect(changing).toHaveBeenCalledTimes(3);
});
