import { createCanvasChatSignerClient } from './chat-signer.js';
import { getTowerPgThread, setBaseUrl } from '../api.js';
import { canvasContext } from './projection.js';
import { openWorkspaceDb } from '../db.js';
import { tryAutoLoginFromStorage, pubkeyToNpub, setExtensionSignerBridge, clearExtensionSignerBridge } from '../auth/nostr.js';
import { setActiveSessionNpub } from '../crypto/group-keys.js';
import { hydrateTowerPgChannel } from '../pg-read-hydrator.js';

// This is the ordinary app and thread composer in its own browsing context.
// Each naplet has independent input/mentions/attachments. Canvas bridges the
// browser signer but never composes or sends messages; binding uses only the
// accepted thread identity.
const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
export const canvasChatEmbedded = params.get('canvaschat') === '1' && typeof window !== 'undefined' && window.parent !== window;

export async function hydrateCanvasChatChannel(store, channelId, hydrate = hydrateTowerPgChannel) {
  // A concurrent ordinary message command can invalidate an authorized read.
  // Re-read under the new fence; never commit the cancelled snapshot or retry
  // permission/network failures. Bound retries so an active reset stays visible.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await hydrate(store, channelId); }
    catch (error) { if (error.code !== 'pg_read_authority_changed' || attempt === 2) throw error; }
  }
}

export const canvasChatEmbedMixin = {
  canvasChatEmbedded,
  canvasChatVisible: false,
  canvasChatBootstrapped: false,
  canvasChatEmbedReady: false,
  canvasChatEmbedError: '',
  async initCanvasChatApp() {
    // Same saved workspace/auth boundary as the Canvas page. Do not run shell
    // discovery, address-book/profile hydration or persist a global navigation
    // selection from an embedded conversation.
    try {
      const workspace = this.knownWorkspaces.find(row => row.workspaceKey === params.get('workspacekey'));
      const auth = await tryAutoLoginFromStorage();
      if (!workspace?.pgBackendMode || !auth?.pubkey) throw new Error('Open Ambulando and sign in to this workspace, then reopen the chat.');
      if (auth.method === 'extension' && !window.nostr?.signEvent) {
        const client = createCanvasChatSignerClient({ workspaceKey: workspace.workspaceKey, pubkey: auth.pubkey, key: params.get('canvaskey') });
        setExtensionSignerBridge(client.bridge);
        window.addEventListener('pagehide', event => { if (!event.persisted) { client.dispose(); clearExtensionSignerBridge(); } });
      }
      const npub = await pubkeyToNpub(auth.pubkey);
      if (workspace.pgSessionNpub && workspace.pgSessionNpub !== npub) throw new Error('This workspace belongs to another signed-in identity.');
      this.session = { pubkey: auth.pubkey, npub, method: auth.method };
      setActiveSessionNpub(npub);
      this.selectedWorkspaceKey = workspace.workspaceKey;
      this.currentWorkspaceOwnerNpub = workspace.workspaceOwnerNpub;
      this.backendUrl = workspace.directHttpsUrl || workspace.pgDescriptor?.tower_base_url;
      setBaseUrl(this.backendUrl);
      this.navSection = 'status';
      openWorkspaceDb(workspace.workspaceKey);
      await this.ensureWorkspaceSessionKey();
      // Establish the normal command-revision fence before the targeted read;
      // transport starts only after that read and the thread are initialized.
      this.getTowerSyncService();
      await this.loadLocalScopes();
      await this.initCanvasChatEmbed();
      if (this.canvasChatEmbedError) return;
      this.startWorkspaceLiveQueries();
      this.canvasChatBootstrapped = true;
      this.ensureBackgroundSync();
      void this.refreshTowerPgWorkspaceMembers({ force: true, limit: 200 }).catch(() => {});
    } catch (error) { this.canvasChatEmbedReady = true; this.canvasChatEmbedError = error.message || 'Conversation unavailable.'; }
  },
  installCanvasChatLifecycle() {
    if (!this.canvasChatEmbedded) return;
    const change = event => {
      if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'ambulando-canvas-chat-visibility') return;
      const visible = event.data.visible === true;
      if (visible === this.canvasChatVisible) return;
      this.canvasChatVisible = visible;
      if (visible) { this.ensureBackgroundSync(true); this.startThreadLiveActivity?.(); this.updateResponseActivityTimer?.(); }
      else {
        this.stopBackgroundSync(); this.stopThreadLiveActivity?.();
        clearInterval(this.responseActivityTimer); this.responseActivityTimer = null;
      }
    };
    window.addEventListener('message', change);
    window.addEventListener('pagehide', event => {
      if (!event.persisted) window.removeEventListener('message', change);
      this.canvasChatVisible = false;
      this.stopBackgroundSync(); this.stopThreadLiveActivity?.();
      clearInterval(this.responseActivityTimer);
      this.responseActivityTimer = null;
    });
    window.addEventListener('pageshow', event => { if (event.persisted) window.parent.postMessage({ type: 'ambulando-canvas-chat-ready' }, location.origin); });
    window.parent.postMessage({ type: 'ambulando-canvas-chat-ready' }, location.origin);
  },
  async initCanvasChatEmbed() {
    if (!this.canvasChatEmbedded || this.canvasChatEmbedReady) return;
    this.canvasChatEmbedReady = true; this.canvasChatEmbedError = '';
    try {
      if (this.currentWorkspaceKey !== params.get('workspacekey') || !this.session?.npub) throw new Error('Open Ambulando and sign in to this workspace, then reopen the chat.');
      this.navSection = 'status';
      const threadId = params.get('canvasthread');
      if (threadId) {
        const context = canvasContext(this);
        const result = await getTowerPgThread(context.workspaceId, threadId, { baseUrl: context.baseUrl, appNpub: context.appNpub });
        const thread = result.thread || result;
        if (thread.id !== threadId || !thread.channel_id) throw new Error('Conversation unavailable.');
        await hydrateCanvasChatChannel(this, thread.channel_id);
        await this.loadLocalChannels({ syncRoute: false });
        await this.openDeckThread(thread.channel_id, thread.source_message_id || thread.id, { towerThreadId: thread.id, syncRoute: false });
      } else {
        const channelId = params.get('canvaschannel');
        await hydrateCanvasChatChannel(this, channelId);
        await this.loadLocalChannels({ syncRoute: false });
        if (!await this.beginDeckThreadCreate(channelId)) throw new Error(this.error || 'Channel unavailable.');
        // Stable per naplet: retrying the first send uses the normal idempotent
        // request, even if the UI retries after an uncertain network response.
        this.deckThreadCreateRequestId = params.get('canvaskey');
      }
    } catch (error) { this.canvasChatEmbedError = error.message || 'Conversation unavailable.'; }
  },
  notifyCanvasChatBound(message) {
    if (!this.canvasChatEmbedded || !message?.pg_thread_id) return;
    window.parent.postMessage({ type: 'ambulando-canvas-chat-bound', key: params.get('canvaskey'), threadId: message.pg_thread_id }, location.origin);
  },
};
