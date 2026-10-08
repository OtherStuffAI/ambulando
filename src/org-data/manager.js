import { liveQuery } from 'dexie';
import { getWorkspaceDb } from '../db.js';
import { orgDataContext, orgDataLifecycle, orgDataPartition, projectOrgData, sandboxBundle } from '../org-data/projection.js';
import { validOrgDataRequest } from './bridge.js';

import { orgDataPermissionsMixin } from './permissions.js';

const RUNTIMES = new WeakMap();
export const orgDataMixin = {
  ...orgDataPermissionsMixin,
  get orgDataPermissionRows() {
    return this.orgDataPermissionsContext === this.orgDataContextKey ? this.orgDataPermissionMembers : [];
  },
  orgDataOpen: false,
  orgDataSrc: '',
  orgDataSrcdoc: '',
  orgDataBundleVisible: false,
  orgDataFrameReady: false,
  orgDataRetainDraft: false,
  orgDataHostStatus: 'loading',
  orgDataHostError: '',
  orgDataInstallationContext: '',
  orgDataInstallations: [],
  orgDataView: 'catalogue',
  get orgDataDisplayTitle() { return this.toolboxApps?.find(a => a.orgDataView === this.orgDataView)?.title || 'Organisation Data'; },
  orgDataFull: false,
  orgDataMenuOpen: false,
  orgDataHistory: [],
  orgDataHistoryIndex: -1,
  get orgDataCanBack() { return this.orgDataHistoryIndex > 0; },
  get orgDataCanForward() { return this.orgDataHistoryIndex < this.orgDataHistory.length - 1; },
  orgDataOpenedContext: '',
  get orgDataContextKey() { return orgDataLifecycle(orgDataContext(this)); },

  async openOrgData({ opener = null, view = 'catalogue' } = {}) {
    const existing = RUNTIMES.get(this);
    if (this.orgDataOpen && existing?.context === this.orgDataContextKey && this.orgDataView === view) {
      document.querySelector('#org-data-modal [data-napplet-close]')?.focus();
      return;
    }
    this.closeOrgData();
    if (this.orgDataOpen) return;
    this.orgDataView = view;
    const session = crypto.randomUUID();
    const runtime = { session, context: this.orgDataContextKey,
      view, capabilities: ['org_data.read','org_data.write','org_data.schema','profile.open','dm.open'], request: null, subscription: null, ready: false, state: { status: 'loading', view },
      opener: opener || document.activeElement, frame: null };
    const current = () => RUNTIMES.get(this) === runtime && this.orgDataOpen && this.orgDataContextKey === runtime.context;
    runtime.send = state => {
      if (!current()) return;
      runtime.state = state;
      this.orgDataHostStatus = state.status;
      this.orgDataHostError = state.error || '';
      this.orgDataBundleVisible = state.status === 'ready' && runtime.ready;
      this.orgDataRetainDraft = state.retainDraft === true && runtime.ready;
      if (state.status !== 'ready') this.orgDataInstallations = [];
      if (runtime.bundle) state = { ...state, projection: runtime.capabilities.includes('org_data.read') ? state.projection : undefined };
      if (runtime.ready) runtime.frame?.contentWindow?.postMessage({ version: 1, session: runtime.session, type: 'state', ...state }, '*');
    };
    runtime.listener = event => {
      if (!current() || !validOrgDataRequest(event, runtime.frame?.contentWindow, runtime.session)) return;
      const data = event.data;
      if (data.type === 'dirty') { runtime.dirty = data.dirty; return; }
      if (data.type === 'bundle') { if (runtime.bundle) return; if (!this.confirmOrgDataDiscard(runtime)) return; void this.openOrgData({ view: 'bundle:' + data.key }); return; }
      if (data.type === 'write' && (runtime.authorizing || runtime.blocked || !this.orgDataWriteAllowed(data, runtime))) return;
      if (data.type === 'write') { void this.writeOrgData(data); return; }
      if (['profile','dm'].includes(data.type)) {
        if (!runtime.capabilities.includes(data.type === 'dm' ? 'dm.open' : 'profile.open')) return;
        const person = runtime.state.projection?.records?.people?.find(p => p.id === data.id);
        const npub = person?.values?.nostr || runtime.state.projection?.identities?.[person?.values?.actor];
        if (npub && this.confirmOrgDataDiscard(runtime)) { this.closeOrgData(); if (data.type === 'dm') void this.createBotDm(npub); else this.openIdentityCard(null, npub); } return;
      }
      if (data.type === 'close') {
        if (this.orgDataMenuOpen) return this.dismissOrgDataMenu();
        return this.closeOrgData();
      }
      if (data.type === 'ready') { runtime.ready = true; this.orgDataFrameReady = true; clearTimeout(runtime.readyTimeout); runtime.send(runtime.state); return; }
      if (data.type === 'view') {
        if (runtime.view === data.view || !this.confirmOrgDataDiscard(runtime)) return;
        this.orgDataHistory = [...this.orgDataHistory.slice(0, this.orgDataHistoryIndex + 1), data.view];
        this.orgDataHistoryIndex = this.orgDataHistory.length - 1;
        runtime.view = data.view; this.orgDataView = data.view;
      }
      // Repeated refresh clicks while a read is active do not amplify traffic.
      if (data.type === 'refresh' && runtime.state.status === 'loading') return;
      void this.refreshOrgData();
    };
    runtime.onPageHide = () => this.closeOrgData(true);
    RUNTIMES.set(this, runtime);
    runtime.frame = document.getElementById('org-data-modal')?.querySelector('iframe');
    window.addEventListener('message', runtime.listener);
    window.addEventListener('pagehide', runtime.onPageHide);
    this.orgDataOpenedContext = runtime.context;
    runtime.view = view; this.orgDataHistory = [view];
    this.orgDataHistoryIndex = 0;
    this.orgDataOpen = true;
    // A query change forces a fresh document even when an immediate reopen
    // supersedes the pending about:blank navigation. A fragment alone would
    // retain the old script's session in a same-document navigation.
    this.orgDataSrcdoc = '';
    this.orgDataSrc = view.startsWith('bundle:') ? 'about:blank' : `/napplets/org-data/v1/index.html?session=${session}#${session}`;
    this.armOrgDataReadyTimeout(runtime);
    await new Promise(resolve => queueMicrotask(resolve));
    if (!current()) return;
    const dialog = document.getElementById('org-data-modal');
    runtime.frame = dialog?.querySelector('iframe');
    dialog?.showModal();
    dialog?.querySelector('[data-napplet-close]')?.focus();
    void this.refreshOrgData();
  },

  armOrgDataReadyTimeout(runtime) {
    clearTimeout(runtime.readyTimeout);
    runtime.readyTimeout = setTimeout(() => {
      if (RUNTIMES.get(this) !== runtime || !this.orgDataOpen || runtime.ready || runtime.state.status === 'loading') return;
      this.clearOrgDataDocument(runtime);
      runtime.send({ status: 'error', view: runtime.view, error: 'Organisation data frame did not become ready. Refresh to retry.' });
    }, 45000);
  },

  toggleOrgDataPresentation() {
    if (!this.orgDataOpen) return;
    this.orgDataMenuOpen = false;
    this.orgDataFull = !this.orgDataFull;
    // Resize in place: no reparenting, dialog close, frame reload or data read.
  },

  toggleOrgDataMenu() {
    this.orgDataMenuOpen = !this.orgDataMenuOpen;
    if (this.orgDataMenuOpen) queueMicrotask(() => document.querySelector('#org-data-menu button')?.focus());
  },

  dismissOrgDataMenu() {
    this.orgDataMenuOpen = false;
    document.querySelector('[data-napplet-menu]')?.focus();
  },

  handleOrgDataEscape(event) {
    event.preventDefault(); event.stopPropagation();
    if (this.orgDataMenuOpen) this.dismissOrgDataMenu();
    else this.closeOrgData();
  },

  navigateOrgData(direction) {
    const runtime = RUNTIMES.get(this);
    if (!runtime || !['back', 'forward'].includes(direction)) return;
    if (direction === 'back' ? !this.orgDataCanBack : !this.orgDataCanForward) return;
    this.orgDataMenuOpen = false;
    if (!this.confirmOrgDataDiscard(runtime)) return;
    this.orgDataHistoryIndex += direction === 'back' ? -1 : 1;
    runtime.view = this.orgDataHistory[this.orgDataHistoryIndex]; this.orgDataView = runtime.view;
    void this.refreshOrgData();
  },

  confirmOrgDataDiscard(runtime) {
    if (runtime?.writing) return false;
    if (runtime?.dirty && !window.confirm('Discard unsaved changes?')) return false;
    if (runtime) runtime.dirty = false; return true;
  },

  orgDataWriteAllowed(data, runtime) {
    const capability = data.path === 'bootstrap' || /^types(?:\/[a-z][a-z0-9_]*)?$/.test(data.path) ? 'org_data.schema' : 'org_data.write';
    if (data.path.startsWith('napplets/')) return !runtime.bundle;
    return runtime.capabilities.includes(capability);
  },

  async syncOrgData() {
    const runtime = RUNTIMES.get(this);
    if (!runtime) return;
    await this.refreshOrgData({ preserveDraft: true, error: 'Shared data changed. Save checks your revision; refresh discards the draft.' });
  },

  async refreshOrgData({ preserveDraft = false, error: draftError = '' } = {}) {
    const runtime = RUNTIMES.get(this);
    if (!runtime) return;
    if (!preserveDraft && !this.confirmOrgDataDiscard(runtime)) return;
    this.orgDataMenuOpen = false;
    runtime.request?.abort(); runtime.subscription?.unsubscribe();
    const controller = new AbortController(), requestId = crypto.randomUUID(), view = runtime.view;
    const prior = runtime.authority;
    const retaining = preserveDraft && (runtime.dirty || runtime.writing) && !!prior && !runtime.blocked;
    runtime.authorizing = true;
    runtime.request = controller;
    const current = () => RUNTIMES.get(this) === runtime && !controller.signal.aborted
      && this.orgDataOpen && this.orgDataContextKey === runtime.context;
    runtime.send({ status: 'loading', view, retainDraft: retaining });
    try {
      const c = orgDataContext(this), db = getWorkspaceDb();
      const service = this.getTowerSyncService();
      if (!service || !c.sessionNpub || !c.workspaceId) throw new Error('Workspace unavailable');
      runtime.subscription = liveQuery(async () => {
        const row = await db.org_data.get(orgDataPartition(c));
        if (!row || row.request_id !== requestId) return null;
        return { projection: projectOrgData(row), bundles: row.installations };
      }).subscribe({ next: result => {
        const projection = result?.projection;
        if (!current() || !projection || runtime.deliveredRequestId === requestId) return;
        // liveQuery can emit the same committed request twice when its initial
        // read overlaps the transaction. Re-sending ready would erase a form
        // opened between those emissions. Every reauthorization has a new ID.
        runtime.deliveredRequestId = requestId;
        const unchanged = retaining && sameOrgDataAuthority(prior, projection);
        if (retaining && !unchanged || runtime.bundle && prior && !sameOrgDataAuthority(prior, projection)) { this.clearOrgDataDocument(runtime); runtime.bundle = null; }
        runtime.authority = projection; runtime.authorizing = false; runtime.blocked = false;
        if (runtime.documentCleared) {
          runtime.documentCleared = false; runtime.ready = false; runtime.session = crypto.randomUUID();
          this.orgDataSrcdoc = view.startsWith('bundle:') ? '<!doctype html>' : '';
          this.orgDataSrc = view.startsWith('bundle:') ? 'about:blank' : `/napplets/org-data/v1/index.html?session=${runtime.session}#${runtime.session}`;
        }
        if (!runtime.ready) this.armOrgDataReadyTimeout(runtime);
        this.orgDataInstallations = projection.installations || []; this.orgDataInstallationContext = runtime.context;
        if (view.startsWith('bundle:')) {
          const bundle = result.bundles?.find(b => b.key === view.slice(7));
          if (!bundle) { this.clearOrgDataDocument(runtime); runtime.send({ status: 'error', view, error: 'Installed napplet unavailable.' }); return; }
          if (!runtime.bundle || runtime.bundle.sha256 !== bundle.sha256) {
            runtime.bundle = bundle; runtime.capabilities = bundle.capabilities;
            this.orgDataSrcdoc = sandboxBundle(bundle.html, sessionFor(runtime));
          }
        }
        runtime.send(unchanged ? { status: 'error', view, requestId, projection, retainDraft: true, error: draftError || 'Save failed. Your authorised draft is retained.' } : { status: 'ready', view, requestId, projection });
      }, error: error => { if (current()) { this.clearOrgDataDocument(runtime); runtime.send({ status: 'error', view, error: (error?.status === 403 ? 'Organisation data access denied.' : error?.message || 'Organisation data unavailable. Refresh to retry.') }); } } });
      let timeout;
      try {
        await Promise.race([
          service.ensureLoaded('org-data', `${view}:${requestId}`, { force: true, requestId, signal: controller.signal }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Organisation data loading timed out. Refresh to retry.')), 45000); }),
        ]);
        if (current()) {
          const row = await db.org_data.get(orgDataPartition(c));
          if (!row || row.request_id !== requestId) throw new Error('Organisation data was not loaded. Refresh to retry.');
        }
      } finally { clearTimeout(timeout); }
    } catch (error) {
      if (current()) { runtime.subscription?.unsubscribe(); this.clearOrgDataDocument(runtime); runtime.send({ status: 'error', view, error: (error?.status === 403 ? 'Organisation data access denied.' : error?.message || 'Organisation data unavailable. Refresh to retry.') }); controller.abort(); }
    }
  },

  async writeOrgData(data) {
    const runtime = RUNTIMES.get(this);
    if (!runtime || runtime.writing || runtime.authorizing || runtime.blocked) return;
    runtime.writing = true;
    const current = () => RUNTIMES.get(this) === runtime && this.orgDataContextKey === runtime.context;
    try { await this.getTowerSyncService().command('org-data.write', { path: data.path, method: data.method, body: data.body }); if (!current()) return; runtime.dirty = false; runtime.writing = false; await this.refreshOrgData({ preserveDraft: true }); }
    catch (error) { if (current()) { runtime.writing = false;
      if (error?.status === 403) { runtime.request?.abort(); runtime.subscription?.unsubscribe();
        this.clearOrgDataDocument(runtime); runtime.send({ status: 'error', view: runtime.view, error: 'Organisation data access denied.' });
        try { await getWorkspaceDb().org_data.delete(orgDataPartition(orgDataContext(this))); } catch { /* disposed */ }
      }
      else await this.refreshOrgData({ preserveDraft: true, error: error?.message || 'Save failed. Your draft is retained.' }); } }
    finally { runtime.writing = false; }
  },

  clearOrgDataDocument(runtime) {
    clearTimeout(runtime.readyTimeout); this.orgDataFrameReady = false; this.orgDataRetainDraft = false;
    runtime.blocked = true; runtime.authorizing = false; runtime.dirty = false;
    runtime.authority = null; runtime.bundle = null; runtime.ready = false; runtime.documentCleared = true;
    runtime.state = { status: 'error', view: runtime.view };
    // Destroy even a bundle that ignores bridge state. Removing srcdoc is
    // essential: it takes precedence over a navigation to about:blank.
    if (runtime.frame) {
      const replacement = runtime.frame.cloneNode(false);
      replacement.removeAttribute('srcdoc'); replacement.src = 'about:blank';
      // Removing the browsing context clears populated DOM and script state
      // even when navigation/state handlers in published code are uncooperative.
      runtime.frame.replaceWith(replacement); runtime.frame = replacement;
    }
    this.orgDataSrc = 'about:blank'; this.orgDataSrcdoc = '<!doctype html>';
    this.orgDataBundleVisible = false; this.orgDataInstallations = [];
  },

  closeOrgData(force = false) {
    const runtime = RUNTIMES.get(this);
    if (!force && !this.confirmOrgDataDiscard(runtime)) return;
    if (runtime) {
      runtime.request?.abort(); runtime.subscription?.unsubscribe();
      window.removeEventListener('message', runtime.listener);
      window.removeEventListener('pagehide', runtime.onPageHide);
      // Context changes/close remove the browsing context just as revocation does.
      this.clearOrgDataDocument(runtime);
      RUNTIMES.delete(this);
    }
    this.orgDataFull = false; this.orgDataMenuOpen = false;
    this.orgDataHistory = []; this.orgDataHistoryIndex = -1;
    this.orgDataOpen = false; this.orgDataSrc = ''; this.orgDataSrcdoc = ''; this.orgDataOpenedContext = '';
    this.orgDataBundleVisible = false; this.orgDataHostError = ''; this.orgDataHostStatus = 'loading';
    const dialog = document.getElementById('org-data-modal');
    if (dialog?.open) dialog.close();
    if (runtime?.opener?.isConnected) runtime.opener.focus();
  },
};

function sessionFor(runtime) { return runtime.session; }

// A draft can include options/identities from other permitted datasets. Any
// narrowing, reference redaction, schema or capability change discards it.
export function sameOrgDataAuthority(before, after) {
  const signature = p => JSON.stringify({
    types: p.types, capabilities: p.capabilities, identities: p.identities,
    records: p.types.map(t => [t.key, (p.records[t.key] || []).map(r => [r.id,
      t.fields.filter(f => f.type.endsWith('_ref')).map(f => [f.key, r.values[f.key]])])]),
    installations: p.installations,
  });
  return signature(before) === signature(after);
}
