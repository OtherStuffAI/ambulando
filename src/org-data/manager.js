import { liveQuery } from 'dexie';
import { getWorkspaceDb } from '../db.js';
import { orgDataContext, orgDataLifecycle, orgDataPartition, projectOrgData, sandboxBundle } from '../org-data/projection.js';
import { validOrgDataRequest } from './bridge.js';

const RUNTIMES = new WeakMap();
export const orgDataMixin = {
  orgDataOpen: false,
  orgDataSrc: '',
  orgDataSrcdoc: '',
  orgDataBundleVisible: false,
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
      this.orgDataBundleVisible = state.status === 'ready';
      if (state.status !== 'ready') this.orgDataInstallations = [];
      if (runtime.bundle) state = { ...state, projection: runtime.capabilities.includes('org_data.read') ? state.projection : undefined };
      if (runtime.ready) runtime.frame?.contentWindow?.postMessage({ version: 1, session, type: 'state', ...state }, '*');
    };
    runtime.listener = event => {
      if (!current() || !validOrgDataRequest(event, runtime.frame?.contentWindow, session)) return;
      const data = event.data;
      if (data.type === 'dirty') { runtime.dirty = data.dirty; return; }
      if (data.type === 'bundle') { if (runtime.bundle) return; if (!this.confirmOrgDataDiscard(runtime)) return; void this.openOrgData({ view: 'bundle:' + data.key }); return; }
      if (data.type === 'write' && !this.orgDataWriteAllowed(data, runtime)) return;
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
      if (data.type === 'ready') { runtime.ready = true; runtime.send(runtime.state); return; }
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
    await new Promise(resolve => queueMicrotask(resolve));
    if (!current()) return;
    const dialog = document.getElementById('org-data-modal');
    runtime.frame = dialog?.querySelector('iframe');
    dialog?.showModal();
    dialog?.querySelector('[data-napplet-close]')?.focus();
    void this.refreshOrgData();
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
    if (runtime.dirty || runtime.writing) { runtime.subscription?.unsubscribe(); runtime.send({ status: 'error', view: runtime.view, retainDraft: true, error: 'Shared data changed. Save checks your revision; refresh discards the draft.' }); return; }
    await this.refreshOrgData();
  },

  async refreshOrgData({ preserveDraft = false } = {}) {
    const runtime = RUNTIMES.get(this);
    if (!runtime || runtime.state.status === 'loading' && runtime.request && !runtime.request.signal.aborted && runtime.state.view === runtime.view) return;
    if (!preserveDraft && !this.confirmOrgDataDiscard(runtime)) return;
    this.orgDataMenuOpen = false;
    runtime.request?.abort(); runtime.subscription?.unsubscribe();
    const controller = new AbortController(), requestId = crypto.randomUUID(), view = runtime.view;
    runtime.request = controller;
    const current = () => RUNTIMES.get(this) === runtime && !controller.signal.aborted
      && this.orgDataOpen && this.orgDataContextKey === runtime.context;
    runtime.send({ status: 'loading', view });
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
        if (!current() || !projection) return;
        this.orgDataInstallations = projection.installations || []; this.orgDataInstallationContext = runtime.context;
        if (view.startsWith('bundle:') && !runtime.bundle) {
          const bundle = result.bundles?.find(b => b.key === view.slice(7));
          if (!bundle) { runtime.send({ status: 'error', view, error: 'Installed napplet unavailable.' }); return; }
          runtime.bundle = bundle; runtime.capabilities = bundle.capabilities;
          this.orgDataSrcdoc = sandboxBundle(bundle.html, sessionFor(runtime));
        }
        runtime.send({ status: 'ready', view, projection });
      }, error: error => { if (current()) runtime.send({ status: 'error', view, error: (error?.status === 403 ? 'Organisation data access denied.' : error?.message || 'Organisation data unavailable. Refresh to retry.') }); } });
      await service.ensureLoaded('org-data', `${view}:${requestId}`, { force: true, requestId, signal: controller.signal });
    } catch (error) {
      if (current()) { runtime.subscription?.unsubscribe(); runtime.send({ status: 'error', view, error: (error?.status === 403 ? 'Organisation data access denied.' : error?.message || 'Organisation data unavailable. Refresh to retry.') }); }
    }
  },

  async writeOrgData(data) {
    const runtime = RUNTIMES.get(this);
    if (!runtime || runtime.writing) return;
    runtime.writing = true;
    const current = () => RUNTIMES.get(this) === runtime && this.orgDataContextKey === runtime.context;
    try { await this.getTowerSyncService().command('org-data.write', { path: data.path, method: data.method, body: data.body }); if (!current()) return; runtime.dirty = false; runtime.writing = false; await this.refreshOrgData({ preserveDraft: true }); }
    catch (error) { if (current()) { runtime.subscription?.unsubscribe(); runtime.send({ status: 'error', view: runtime.view, retainDraft: true, error: error?.message || 'Save failed. Your draft is retained.' }); } }
    finally { runtime.writing = false; }
  },

  closeOrgData(force = false) {
    const runtime = RUNTIMES.get(this);
    if (!force && !this.confirmOrgDataDiscard(runtime)) return;
    if (runtime) {
      runtime.request?.abort(); runtime.subscription?.unsubscribe();
      window.removeEventListener('message', runtime.listener);
      window.removeEventListener('pagehide', runtime.onPageHide);
      RUNTIMES.delete(this);
      // Destroy the frame document, including its last aggregate content.
      if (runtime.frame) runtime.frame.src = 'about:blank';
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
