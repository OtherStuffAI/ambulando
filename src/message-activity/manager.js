import { liveQuery } from 'dexie';
import { getWorkspaceDb } from '../db.js';
import { messageActivityContext, messageActivityLifecycle, messageActivityRowKey, projectMessageActivity } from './projection.js';
import { validMessageActivityRequest, messageActivityError } from './bridge.js';

const RUNTIMES = new WeakMap();
export const messageActivityMixin = {
  messageActivityOpen: false,
  messageActivitySrc: '',
  messageActivityOpenedContext: '',
  get messageActivityContextKey() { return messageActivityLifecycle(messageActivityContext(this)); },

  async openMessageActivity() {
    this.closeMessageActivity();
    const session = crypto.randomUUID();
    const runtime = { session, context: this.messageActivityContextKey,
      range: '7d', request: null, subscription: null, ready: false, state: { status: 'loading', range: '7d' },
      opener: document.activeElement, frame: null };
    const current = () => RUNTIMES.get(this) === runtime && this.messageActivityOpen && this.messageActivityContextKey === runtime.context;
    runtime.send = state => {
      if (!current()) return;
      runtime.state = state;
      if (runtime.ready) runtime.frame?.contentWindow?.postMessage({ version: 1, session, type: 'state', ...state }, '*');
    };
    runtime.listener = event => {
      if (!current() || !validMessageActivityRequest(event, runtime.frame?.contentWindow, session)) return;
      const data = event.data;
      if (data.type === 'close') return this.closeMessageActivity();
      if (data.type === 'ready') { runtime.ready = true; runtime.send(runtime.state); return; }
      if (data.type === 'range') runtime.range = data.range;
      // Repeated refresh clicks while a read is active do not amplify traffic.
      if (data.type === 'refresh' && runtime.state.status === 'loading') return;
      void this.refreshMessageActivity();
    };
    runtime.onPageHide = () => this.closeMessageActivity();
    RUNTIMES.set(this, runtime);
    runtime.frame = document.getElementById('message-activity-modal')?.querySelector('iframe');
    window.addEventListener('message', runtime.listener);
    window.addEventListener('pagehide', runtime.onPageHide);
    this.messageActivityOpenedContext = runtime.context;
    this.messageActivityOpen = true;
    // A query change forces a fresh document even when an immediate reopen
    // supersedes the pending about:blank navigation. A fragment alone would
    // retain the old script's session in a same-document navigation.
    this.messageActivitySrc = `/napplets/message-activity/index.html?session=${session}#${session}`;
    await new Promise(resolve => queueMicrotask(resolve));
    if (!current()) return;
    const dialog = document.getElementById('message-activity-modal');
    runtime.frame = dialog?.querySelector('iframe');
    dialog?.showModal();
    dialog?.querySelector('button')?.focus();
    void this.refreshMessageActivity();
  },

  async refreshMessageActivity() {
    const runtime = RUNTIMES.get(this);
    if (!runtime) return;
    runtime.request?.abort(); runtime.subscription?.unsubscribe();
    const controller = new AbortController(), requestId = crypto.randomUUID(), range = runtime.range;
    runtime.request = controller;
    const current = () => RUNTIMES.get(this) === runtime && !controller.signal.aborted
      && this.messageActivityOpen && this.messageActivityContextKey === runtime.context;
    runtime.send({ status: 'loading', range });
    try {
      const c = messageActivityContext(this), db = getWorkspaceDb();
      const service = this.getTowerSyncService();
      if (!service || !c.sessionNpub || !c.workspaceId) throw new Error('Workspace unavailable');
      runtime.subscription = liveQuery(async () => {
        const row = await db.message_activity.get(messageActivityRowKey(c, range));
        if (!row || row.request_id !== requestId) return null;
        const [channels, scopes] = await Promise.all([
          db.channels.where('owner_npub').equals(c.workspaceOwnerNpub).toArray(),
          db.scopes.where('owner_npub').equals(c.workspaceOwnerNpub).toArray(),
        ]);
        return projectMessageActivity(row, channels, scopes);
      }).subscribe({ next: projection => {
        if (current() && projection) runtime.send({ status: 'ready', range, projection });
      }, error: error => { if (current()) runtime.send({ status: 'error', range, error: messageActivityError(error) }); } });
      await service.ensureLoaded('message-activity', `${range}:${requestId}`, { force: true, range, requestId, signal: controller.signal });
    } catch (error) {
      if (current()) { runtime.subscription?.unsubscribe(); runtime.send({ status: 'error', range, error: messageActivityError(error) }); }
    }
  },

  closeMessageActivity() {
    const runtime = RUNTIMES.get(this);
    if (runtime) {
      runtime.request?.abort(); runtime.subscription?.unsubscribe();
      window.removeEventListener('message', runtime.listener);
      window.removeEventListener('pagehide', runtime.onPageHide);
      RUNTIMES.delete(this);
      // Destroy the frame document, including its last aggregate content.
      if (runtime.frame) runtime.frame.src = 'about:blank';
    }
    this.messageActivityOpen = false; this.messageActivitySrc = ''; this.messageActivityOpenedContext = '';
    const dialog = document.getElementById('message-activity-modal');
    if (dialog?.open) dialog.close();
    if (runtime?.opener?.isConnected) runtime.opener.focus();
  },
};
