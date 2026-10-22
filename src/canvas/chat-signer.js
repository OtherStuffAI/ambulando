import { verifyEvent } from 'nostr-tools';
import { getStoredCredentials } from '../auth/secure-store.js';
import { getExtensionPublicKey, signEventWithExtension } from '../auth/nostr.js';

const REQUEST = 'ambulando-canvas-chat-sign';
const RESPONSE = 'ambulando-canvas-chat-signed';
const MAX_PENDING = 8;
const TIMEOUT_MS = 30_000;
const fail = message => Object.assign(new Error(message), { code: 'canvas_chat_signer' });
const fingerprint = value => JSON.stringify(value);

// Register only from the trusted Chat directive, never by discovering arbitrary
// frames or accepting a child's claim that it is a Chat frame.
export function attachCanvasChatSigner({ element, host = window, context, getPublicKey = getExtensionPublicKey, signEvent = signEventWithExtension, getSession = getStoredCredentials, timeoutMs = TIMEOUT_MS }) {
  const origin = host.location.origin;
  const pending = new Map();
  let binding, revoked = false, disposed = false, loaded = false;
  const current = () => {
    const url = new URL(element.src, origin), state = context();
    if (!element.isConnected || element.contentWindow.location.href !== url.href || url.origin !== origin || url.pathname !== '/flight-deck'
      || url.searchParams.get('canvaschat') !== '1' || !url.searchParams.get('canvaskey')
      || url.searchParams.get('canvaskey') !== element.dataset.canvasChatFrame
      || url.searchParams.get('workspacekey') !== state.workspaceKey
      || state.method !== 'extension' || !state.pubkey || !state.npub
      || (state.workspaceSessionNpub && state.workspaceSessionNpub !== state.npub)) throw fail('Chat signer identity unavailable. Reopen this chat.');
    return { ...state, src: url.href, provider: host.nostr, document: element.contentDocument };
  };
  const assertCurrent = () => {
    if (disposed || revoked) throw fail('Chat signer connection closed. Reopen this chat.');
    const state = current();
    if (binding && (state.provider !== binding.provider || state.document !== binding.document || fingerprint({ ...state, provider: null, document: null }) !== fingerprint({ ...binding, provider: null, document: null }))) {
      revoked = true;
      throw fail('Chat signer identity changed. Reopen this chat.');
    }
    return state;
  };
  const reply = (source, id, result, error) => {
    try { source?.postMessage({ type: RESPONSE, id, ...(error ? { error: { message: error.message || 'Browser signing rejected.', code: error.code || 'canvas_chat_signer' } } : { result }) }, origin); }
    catch { /* A removed browsing context cannot receive results. Still clean up. */ }
  };
  const listener = async event => {
    const data = event.data;
    if (event.origin !== origin || event.source !== element.contentWindow || data?.type !== REQUEST) return;
    if (typeof data.id !== 'string' || !/^[\w-]{1,80}$/.test(data.id) || pending.has(data.id)) return;
    const source = event.source;
    let timer, token;
    try {
      const state = assertCurrent();
      if (data.workspaceKey !== state.workspaceKey || data.pubkey !== state.pubkey || data.key !== element.dataset.canvasChatFrame) throw fail('Chat signer identity mismatch.');
      if (!['getPublicKey', 'signEvent'].includes(data.method)) throw fail('Unsupported chat signer operation.');
      if (pending.size >= MAX_PENDING || JSON.stringify(data).length > 1024 * 1024) throw fail('Too many or oversized chat signing requests.');
      binding ||= state;
      token = {};
      pending.set(data.id, token);
      const check = () => {
        assertCurrent();
        if (pending.get(data.id) !== token) throw fail('Chat signing request expired.');
      };
      timer = setTimeout(() => {
        if (pending.get(data.id) !== token) return;
        pending.delete(data.id);
        reply(source, data.id, null, fail('Chat signing timed out. Retry the action.'));
      }, timeoutMs);
      const checkSession = async () => {
        const session = await getSession();
        if (session?.method !== 'extension' || session.pubkey !== state.pubkey || await getPublicKey() !== state.pubkey) {
          revoked = true;
          throw fail('Browser signer identity changed.');
        }
        check();
      };
      token.timer = timer;
      await checkSession();
      check();
      let result = state.pubkey;
      if (data.method === 'signEvent') {
        const event = data.event;
        validateChatSigningEvent(event, state);
        const expected = structuredClone(event);
        result = await signEvent(event, { assertCurrent: () => { check(); return checkSession(); } });
        check();
        const { id, pubkey, kind, content, tags, created_at, sig } = result || {};
        result = { id, pubkey, kind, content, tags, created_at, sig };
        if (result?.pubkey !== state.pubkey || result.kind !== expected.kind || result.content !== expected.content || fingerprint(result.tags) !== fingerprint(expected.tags)
          || !Number.isSafeInteger(result.created_at) || result.created_at < expected.created_at || result.created_at > Math.floor(Date.now() / 1000) || !verifyEvent(result)) throw fail('Browser signer returned a different event.');
      }
      await checkSession();
      reply(source, data.id, result);
    } catch (error) {
      if (!token || pending.get(data.id) === token) reply(source, data.id, null, error);
    } finally {
      clearTimeout(timer);
      if (pending.get(data.id) === token) pending.delete(data.id);
    }
  };
  const invalidate = () => {
    revoked = true;
    for (const [id, token] of pending) { clearTimeout(token.timer); reply(element.contentWindow, id, null, fail('Chat signer connection closed. Reopen this chat.')); }
    pending.clear();
  };
  host.addEventListener('message', listener);
  // Navigation invalidates any capability and any native prompt already open.
  // The first load is expected; binding is established only by a valid request.
  const load = () => { if (loaded) invalidate(); loaded = true; };
  element.addEventListener('load', load);
  host.addEventListener('pagehide', invalidate);
  return () => { disposed = true; invalidate(); host.removeEventListener('message', listener); host.removeEventListener('pagehide', invalidate); element.removeEventListener('load', load); };
}

export function validateChatSigningEvent(event, state) {
  if (!event || !Number.isSafeInteger(event.created_at) || Math.abs(event.created_at - Math.floor(Date.now() / 1000)) > 60 || event.pubkey !== state.pubkey || typeof event.content !== 'string' || !Array.isArray(event.tags)
    || !event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string'))) throw fail('Invalid chat signing event.');
  const tag = name => event.tags.filter(row => row[0] === name);
  if (event.kind === 27235) {
    if (event.content !== '' || tag('u').length !== 1 || tag('method').length !== 1) throw fail('Invalid Tower request signature.');
    const url = new URL(tag('u')[0][1]), backend = new URL(state.baseUrl);
    const prefix = `${backend.pathname.replace(/\/$/, '')}/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(state.workspaceId)}`;
    const method = tag('method')[0][1];
    const suffix = url.pathname === prefix ? '' : url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : null;
    const read = ['GET', 'HEAD'].includes(method) && suffix !== null;
    // Preserve normal chat, attachment and sync/view-state writes; exclude
    // workspace administration, grants, keys and unrelated application APIs.
    const write = suffix !== null && (
      (method === 'POST' && /^\/channels\/[^/]+\/(messages|files|threads\/[^/]+\/branches)$/.test(suffix))
      || (['PATCH', 'DELETE'].includes(method) && /^\/(messages|threads)\/[^/]+$/.test(suffix))
      || (method === 'POST' && /^\/threads\/[^/]+\/archive$/.test(suffix))
      || (method === 'PUT' && /^\/resource-view-states\/[^/]+\/[^/]+$/.test(suffix))
      || (method === 'POST' && ['/resource-view-states/mark-viewed', '/storage/prepare', '/record-sync/repair'].includes(suffix))
      || (['POST', 'DELETE'].includes(method) && /^\/record-sync\/clients\/[^/]+(\/(ack|adoption))?$/.test(suffix))
    );
    // Storage completion/download is shared by ordinary attachment code.
    const storage = url.pathname.slice(backend.pathname.replace(/\/$/, '').length);
    const attachment = (method === 'POST' && /^\/api\/v4\/storage\/[^/]+\/complete$/.test(storage))
      || (['GET', 'HEAD'].includes(method) && /^\/api\/v4\/storage\/[^/]+(\/(content|download-url))?$/.test(storage));
    if (url.origin !== backend.origin || url.username || url.password || url.hash || !(read || write || attachment)) throw fail('Unsupported Tower signing target.');
  } else if (event.kind === 33358) {
    if (tag('protocol').length !== 1 || tag('protocol')[0][1] !== 'flightdeck_pg_message_instruction'
      || tag('workspace_id').length !== 1 || tag('workspace_id')[0][1] !== state.workspaceId) throw fail('Unsupported chat instruction signature.');
  } else throw fail('Unsupported chat event kind.');
}

// Uses the existing auth abstraction (also used by the sync worker). It never
// installs window.nostr or exposes encryption, secrets or a generic provider.
export function createCanvasChatSignerClient({ host = window, workspaceKey, pubkey, key, timeoutMs = TIMEOUT_MS + 2_000 }) {
  const origin = host.location.origin, parent = host.parent;
  const pending = new Map();
  let closed = false;
  const listener = event => {
    if (event.origin !== origin || event.source !== parent || event.data?.type !== RESPONSE) return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id); clearTimeout(request.timer);
    if (event.data.error) request.reject(Object.assign(new Error(event.data.error.message || 'Browser signing rejected.'), { code: event.data.error.code }));
    else request.resolve(event.data.result);
  };
  host.addEventListener('message', listener);
  const request = (method, event) => new Promise((resolve, reject) => {
    if (closed || pending.size >= MAX_PENDING) { reject(fail('Chat signer connection closed or busy.')); return; }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(fail('Chat signing timed out. Retry the action.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { parent.postMessage({ type: REQUEST, id, method, workspaceKey, pubkey, key, ...(event ? { event } : {}) }, origin); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const dispose = () => {
    closed = true;
    host.removeEventListener('message', listener);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fail('Chat signer connection closed.')); }
    pending.clear();
  };
  return { bridge: { timeoutMs: timeoutMs + 1_000, getPublicKey: () => request('getPublicKey'), signEvent: event => request('signEvent', event) }, dispose };
}
