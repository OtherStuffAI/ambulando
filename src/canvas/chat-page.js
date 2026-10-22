import { ArtifactCatalog } from './artifact-picker.js';
import { canvasPartition } from './projection.js';

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));

export function canvasChatStore() {
  let catalog, persist, refresh, recoveryKey, listener;
  const keys = new Map(), bindings = new Map();
  return {
    chatDrafts: [], chatFrameUrls: {},
    startChats(context, operations) {
      catalog = new ArtifactCatalog(context);
      ({ persist, refresh } = operations);
      recoveryKey = `ambulando:canvas-chat:${canvasPartition(context)}:${this.canvasId}`;
      try {
        const saved = JSON.parse(localStorage.getItem(recoveryKey) || '[]');
        this.chatDrafts = saved.filter(row => uuid(row.id) && uuid(row.source?.id)).map(row => ({ ...row, _chatDraft: true, access: 'ready', chat: { scopes: [], channels: [], scopeId: '', busy: false, error: 'Conversation sent. Retry saving its Canvas binding.' } }));
      } catch { /* Storage may be disabled; ordinary chat still retains the thread. */ }
      listener = event => {
        if (event.origin !== location.origin || event.data?.type !== 'ambulando-canvas-chat-bound' || !uuid(event.data.threadId)) return;
        const draft = this.chatDrafts.find(row => row.id === event.data.key);
        const frame = [...document.querySelectorAll('[data-canvas-chat-frame]')].find(node => node.dataset.canvasChatFrame === draft?.id);
        if (!draft || frame?.contentWindow !== event.source || (draft.source.id && draft.source.id !== event.data.threadId)) return;
        draft.source.id = event.data.threadId;
        this.saveChatRecovery();
        void this.persistChatDraft(draft);
      };
      addEventListener('message', listener);
    },
    stopChats() { removeEventListener('message', listener); },
    resumeChats() { addEventListener('message', listener); },
    saveChatRecovery() {
      try { localStorage.setItem(recoveryKey, JSON.stringify(this.chatDrafts.filter(row => row.source.id).map(row => ({ id: row.id, title: row.title, source: row.source, layout: row.layout })))); } catch { /* Recovery is best effort; never resend chat. */ }
    },
    mergeChatNaplets(rows) {
      for (const row of rows) {
        const draft = this.chatDrafts.find(draft => draft.source.id && draft.source.id === row.source?.id && row.source.type === 'chat_thread');
        if (draft) { keys.set(row.id, draft.id); this.chatDrafts = this.chatDrafts.filter(item => item.id !== draft.id); }
        if (row.source?.type === 'chat_thread' && keys.has(row.id)) row._chatKey = keys.get(row.id);
      }
      this.saveChatRecovery();
      return [...rows, ...(this.canvas?.can_manage ? this.chatDrafts : [])];
    },
    async placeChat(point) {
      if (!this.canvas?.can_manage) return;
      let draft = { id: crypto.randomUUID(), title: 'Chat', _chatDraft: true, access: 'ready', source: { type: 'chat_thread', id: '' }, content: {}, layout: { x: Math.round(point.x), y: Math.round(point.y), width: 620, height: 640, z: this.highestZ() + 1 }, chat: { scopes: [], channels: [], scopeId: '', busy: true, error: '' } };
      this.chatDrafts.push(draft); draft = this.chatDrafts.at(-1); this.naplets = [...this.naplets, draft]; this.tool = 'select'; this.selectedKeys = [`naplet:${draft.id}`];
      try { const result = await catalog.scopes(); draft.chat.scopes = result.scopes; draft.chat.truncated = result.truncated; }
      catch (error) { draft.chat.error = error.message || 'Could not load scopes.'; }
      finally { draft.chat.busy = false; }
    },
    async chooseChatScope(naplet, scopeId) {
      const state = naplet.chat;
      state.scopeId = scopeId; state.channels = []; state.error = ''; state.busy = true;
      try { const result = await catalog.channels(scopeId); if (state.scopeId === scopeId) { state.channels = result.channels; state.truncated = result.truncated; } }
      catch (error) { if (state.scopeId === scopeId) state.error = error.message || 'Could not load channels.'; }
      finally { if (state.scopeId === scopeId) state.busy = false; }
    },
    chooseChatChannel(naplet, channelId) {
      if (naplet.chat.busy || !naplet.chat.channels.some(row => row.id === channelId) || this.chatFrameUrls[naplet.id]) return;
      this.chatFrameUrls[naplet.id] = this.makeChatUrl(naplet.id, { canvaschannel: channelId });
    },
    makeChatUrl(key, params) {
      return `/flight-deck?${new URLSearchParams({ workspacekey: this.currentWorkspaceKey, canvaschat: '1', canvaskey: key, ...params })}`;
    },
    chatFrameUrl(naplet) {
      const key = naplet._chatKey || naplet.id;
      return this.chatFrameUrls[key] || (naplet.source.id ? this.makeChatUrl(key, { canvasthread: naplet.source.id }) : '');
    },
    async persistChatDraft(draft) {
      if (!this.canvas?.can_manage || !draft.source.id || bindings.has(draft.id) || !this.chatDrafts.some(row => row.id === draft.id)) return;
      const operation = (async () => {
        draft.chat.busy = true; draft.chat.error = '';
        try {
          // An uncertain naplet POST may already have succeeded. Re-read before
          // retrying and reconcile by this newly created conversation identity.
          await refresh();
          if (!this.chatDrafts.some(row => row.id === draft.id)) return;
          await persist({ source: { type: 'chat_thread', id: draft.source.id }, title: 'Chat', layout: { ...draft.layout } });
        } catch (error) {
          draft.chat.error = `Conversation sent; Canvas binding was not saved. ${error.message || ''}`;
        } finally { draft.chat.busy = false; this.saveChatRecovery(); }
      })();
      bindings.set(draft.id, operation);
      try { await operation; } finally { bindings.delete(draft.id); }
    },
    removeChatDraft(draft) {
      if (bindings.has(draft.id)) { draft.chat.error = 'Wait for the Canvas binding to finish saving before removing this naplet.'; return; }
      this.chatDrafts = this.chatDrafts.filter(row => row.id !== draft.id);
      this.naplets = this.naplets.filter(row => row.id !== draft.id);
      delete this.chatFrameUrls[draft.id]; this.saveChatRecovery();
    },
  };
}
