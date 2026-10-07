import { DiagnosticsWorkerClient, DiagnosticsCapture } from './diagnostics-runtime.js';
import { deliverDiagnosticIncident } from './diagnostics-delivery.js';
import { emitDiagnostic } from './diagnostics-events.js';
import { defaultDiagnosticsSettings } from './diagnostics-store.js';

const runtimes = new WeakMap();

export function diagnosticsScope(store) {
  const workspaceId = store.currentWorkspace?.workspaceId || store.currentWorkspace?.workspace_id;
  const actor = store.session?.npub;
  const backend = store.currentWorkspace?.directHttpsUrl || store.currentWorkspaceBackendUrl || store.backendUrl;
  return store.isTowerPgMode && workspaceId && actor && backend ? JSON.stringify([backend, actor, workspaceId]) : '';
}

export const diagnosticsManagerMixin = {
  showDiagnosticsDialog: false,
  diagnosticsSettings: null,
  diagnosticsDescription: '',
  diagnosticsStatus: 'Diagnostics are off.',
  diagnosticsError: '',
  diagnosticsBusy: false,
  diagnosticsCount: 0,
  diagnosticsPending: 0,
  diagnosticsLastReport: null,
  diagnosticsHostStatus: 'Browser-only capture.',

  get diagnosticsAgentOptions() {
    return (this.pgWorkspaceMembers || []).filter(member => member.kind === 'agent')
      .map(member => ({ npub: member.npub, label: member.display_name || this.getSenderName?.(member.npub) || 'Agent' }));
  },
  get diagnosticsChannelOptions() {
    return (this.channels || []).filter(channel => channel.record_state !== 'deleted' && !channel.archived_at && channel.is_archived !== true);
  },

  initDiagnosticsLifecycle() {
    if (runtimes.has(this) || typeof window === 'undefined') return;
    const runtime = { client: new DiagnosticsWorkerClient(), key: '', generation: 0, buffer: [], sending: false, enabled: false, native: false, flushPromise: null };
    runtimes.set(this, runtime);
    runtime.capture = new DiagnosticsCapture({ enabled: () => runtime.enabled && !runtime.sending && diagnosticsScope(this) === runtime.key ? runtime.key : false,
      record: event => { if (runtime.buffer.length < 100) runtime.buffer.push(event); } });
    this.$watch?.('session', () => { void this.refreshDiagnosticsScope(); });
    this.$watch?.('currentWorkspace', () => { void this.refreshDiagnosticsScope(); });
    this.$watch?.('backendUrl', () => { void this.refreshDiagnosticsScope(); });
    const tick = async () => {
      try { await this.refreshDiagnosticsScope(); await this.flushDiagnosticsEvents(); await this.retryDiagnosticsReports(); }
      catch { this.diagnosticsError = 'Local diagnostics unavailable. Your application can continue normally.'; }
    };
    runtime.timer = setInterval(() => { void tick(); }, 5_000);
    runtime.batchTimer = setInterval(() => { void this.flushDiagnosticsEvents().catch(() => { this.diagnosticsError = 'Diagnostics storage unavailable.'; }); }, 500);
    window.addEventListener('online', tick);
    window.addEventListener('pagehide', () => { runtime.enabled = false; runtime.generation++; runtime.capture.stop(); runtime.buffer = []; });
    window.addEventListener('pageshow', event => { if (event.persisted) { runtime.key = ''; void this.refreshDiagnosticsScope(); } });
    void this.refreshDiagnosticsScope();
  },

  async refreshDiagnosticsScope() {
    const runtime = runtimes.get(this);
    if (!runtime) return;
    const key = diagnosticsScope(this);
    if (key === runtime.key) return;
    const oldWorkspace = runtime.workspaceId;
    if (runtime.native && oldWorkspace) void window.wingmanDiagnostics?.configure({ workspaceId: oldWorkspace, enabled: false }).catch(() => {});
    runtime.native = false; runtime.enabled = false; runtime.buffer = []; runtime.generation++;
    runtime.capture.stop(); runtime.key = key;
    runtime.workspaceId = this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id;
    this.diagnosticsSettings = defaultDiagnosticsSettings(); this.diagnosticsDescription = ''; this.diagnosticsError = '';
    this.diagnosticsCount = 0; this.diagnosticsPending = 0; this.diagnosticsLastReport = null;
    this.diagnosticsHostStatus = 'Browser-only capture.';
    if (!key) { this.diagnosticsStatus = 'Select a signed-in Tower workspace to report a problem.'; return; }
    const generation = runtime.generation;
    try {
      const info = await runtime.client.call('info', key);
      if (generation !== runtime.generation || diagnosticsScope(this) !== key) return;
      this.applyDiagnosticsInfo(info); runtime.enabled = info.settings.enabled;
      if (runtime.enabled) runtime.capture.start();
      // Recovery never prompts or exposes native evidence without a new user
      // action. Browser consent and queue are restored only in their exact scope.
    } catch { this.diagnosticsError = 'Local diagnostics storage is unavailable.'; }
  },

  applyDiagnosticsInfo(info, preserveDraft = false) {
    if (!preserveDraft) this.diagnosticsSettings = { ...info.settings };
    this.diagnosticsCount = info.count ?? this.diagnosticsCount;
    this.diagnosticsPending = info.pending ?? this.diagnosticsPending;
    this.diagnosticsLastReport = info.lastReport ?? null;
    this.diagnosticsStatus = info.settings.enabled ? (info.settings.automatic ? 'Recording · automatic reports enabled' : 'Recording · manual reports only') : 'Diagnostics are off.';
  },

  async openDiagnosticsDialog() {
    this.showAvatarMenu = false; this.showDiagnosticsDialog = true; emitDiagnostic({source:'ui',code:'interaction',operation:'report-open'});
    this.initDiagnosticsLifecycle(); await this.refreshDiagnosticsScope();
    const runtime = runtimes.get(this);
    if (runtime?.key) {
      const key = runtime.key;
      const info = await runtime.client.call('info', key);
      if (runtime.key === key && diagnosticsScope(this) === key) this.applyDiagnosticsInfo(info);
    }
  },

  async saveDiagnosticsSettings() {
    const runtime = runtimes.get(this);
    if (!runtime?.key || diagnosticsScope(this) !== runtime.key) return;
    const key = runtime.key;
    const generation = ++runtime.generation;
    runtime.enabled = false; runtime.capture.stop(); runtime.buffer = [];
    this.diagnosticsError = ''; this.diagnosticsBusy = true;
    try {
      const settings = { ...this.diagnosticsSettings };
      if (settings.automatic && (!settings.channelId || !settings.agentNpub)) throw new Error('Choose a report channel and agent before enabling automatic reports.');
      const result = await runtime.client.call('configure', key, settings);
      if (generation !== runtime.generation || diagnosticsScope(this) !== key) return;
      this.applyDiagnosticsInfo(result); runtime.enabled = result.settings.enabled;
      if (runtime.enabled) runtime.capture.start();
      runtime.native = false;
      const bridge = window.wingmanDiagnostics;
      if (bridge?.version === 1) {
        try {
          const native = await bridge.configure({ workspaceId: runtime.workspaceId, enabled: runtime.enabled });
          if (generation !== runtime.generation || diagnosticsScope(this) !== key) return;
          runtime.native = native?.version === 1 && native.enabled === true;
          this.diagnosticsHostStatus = runtime.native ? 'WM App host capture authorized for this tab.' : 'Browser-only capture; host consent withheld.';
          if (runtime.native) {
            const snapshot = await bridge.snapshot({ workspaceId: runtime.workspaceId });
            if (generation !== runtime.generation || diagnosticsScope(this) !== key) return;
            if (snapshot?.version === 1 && snapshot.recovered === true) {
              this.diagnosticsHostStatus = 'Recovered WM App evidence is available for this tab. Include it in a report while it remains in the 30-minute window.';
              if (result.settings.automatic) {
                for (const trigger of (snapshot.events || []).filter(event => event.source === 'host' && event.level === 'error').slice(-3)) {
                  await runtime.client.call('queue', key, { incidentId: crypto.randomUUID(), automatic: true, trigger,
                    workspaceId: runtime.workspaceId, build: this.appBuildId || 'unknown' }).catch(() => {});
                }
              }
            }
          }
        } catch { this.diagnosticsHostStatus = 'Browser-only capture; WM App bridge unavailable.'; }
      }
    } catch (error) { this.diagnosticsError = error.message; }
    finally { this.diagnosticsBusy = false; }
  },

  async flushDiagnosticsEvents() {
    const runtime = runtimes.get(this);
    if (!runtime?.enabled || !runtime.key || runtime.flushPromise || !runtime.buffer.length) return runtime?.flushPromise;
    const key = runtime.key, generation = runtime.generation;
    const events = runtime.buffer.splice(0, 100);
    runtime.flushPromise = (async () => {
      const safe = await runtime.client.call('append', key, events);
      if (generation !== runtime.generation || diagnosticsScope(this) !== key) return;
      if (runtime.native && safe.length) {
        try { await window.wingmanDiagnostics.append({ workspaceId: runtime.workspaceId, events: safe }); }
        catch { runtime.native = false; this.diagnosticsHostStatus = 'Browser-only capture; host capability revoked.'; }
      }
      if (generation !== runtime.generation || diagnosticsScope(this) !== key) return;
      for (const trigger of safe.filter(event => event.level === 'error')) {
        await runtime.client.call('queue', key, { incidentId: crypto.randomUUID(), automatic: true, trigger,
          workspaceId: runtime.workspaceId, build: this.appBuildId || 'unknown' }).catch(() => {});
      }
    })().finally(() => { runtime.flushPromise = null; });
    return runtime.flushPromise;
  },

  async queueManualDiagnosticReport() {
    this.diagnosticsError = ''; this.diagnosticsBusy = true;
    try {
      emitDiagnostic({source:'ui',code:'interaction',operation:'report-send'});
      await this.flushDiagnosticsEvents();
      const runtime = runtimes.get(this), key = diagnosticsScope(this);
      if (!key || runtime?.key !== key) throw new Error('Select a signed-in Tower workspace.');
      if (!this.diagnosticsDescription.trim()) throw new Error('Describe what happened and what you expected.');
      await runtime.client.call('queue', key, { incidentId: crypto.randomUUID(), automatic: false,
        description: this.diagnosticsDescription, manualAuthorized: true, workspaceId: runtime.workspaceId, build: this.appBuildId || 'unknown' });
      this.diagnosticsDescription = ''; await this.retryDiagnosticsReports();
    } catch (error) { this.diagnosticsError = error.message; }
    finally { this.diagnosticsBusy = false; }
  },

  async retryDiagnosticsReports() {
    const runtime = runtimes.get(this), key = diagnosticsScope(this);
    if (!runtime || runtime.sending || !key || runtime.key !== key) return;
    runtime.sending = true;
    const generation = runtime.generation;
    const run = async () => {
      const info = await runtime.client.call('info', key);
      if (generation !== runtime.generation || diagnosticsScope(this) !== key) return;
      this.applyDiagnosticsInfo(info, this.showDiagnosticsDialog); runtime.enabled = info.settings.enabled;
      if (!runtime.enabled) runtime.capture.stop();
      const incident = await runtime.client.call('next', key);
      if (!incident) return;
      const agent = this.diagnosticsAgentOptions.find(agent => agent.npub === incident.agentNpub);
      const channel = this.diagnosticsChannelOptions.find(channel => channel.record_id === incident.channelId);
      if (!agent || !channel) throw new Error('Report destination is no longer available. Choose a current channel and agent.');
      const assertCurrent = async () => {
        if ((incident.automatic && !runtime.enabled) || generation !== runtime.generation || diagnosticsScope(this) !== key) throw new Error('Diagnostics scope or consent changed.');
        const consent = await runtime.client.call('info', key);
        if ((incident.automatic && !consent.settings.enabled) || (!incident.automatic && !consent.settings.enabled && !incident.manualAuthorized) || consent.revision !== incident.revision
          || generation !== runtime.generation || diagnosticsScope(this) !== key) throw new Error('Diagnostics scope or consent changed.');
      };
      const patch = async update => {
        await assertCurrent(); return runtime.client.call('patch', key, incident.incidentId, incident.revision, update);
      };
      try {
        await deliverDiagnosticIncident({ store: this, incident, agent, assertCurrent, patch,
          snapshot: runtime.native ? () => window.wingmanDiagnostics.snapshot({ workspaceId: runtime.workspaceId }) : null });
      } catch (error) { await patch({ retry: true }).catch(() => {}); throw error; }
      await assertCurrent(); this.diagnosticsError = ''; this.applyDiagnosticsInfo(await runtime.client.call('info', key), this.showDiagnosticsDialog);
    };
    try {
      // Without Web Locks, idempotent Tower message IDs still prevent duplicate
      // messages; only this tab drains at a time. Supported browsers coordinate
      // all tabs sharing this backend/actor/workspace.
      if (navigator.locks?.request) await navigator.locks.request(`diagnostics:${key}`, { ifAvailable: true }, lock => lock ? run() : undefined);
      else await run();
    } catch { if (generation === runtime.generation && diagnosticsScope(this) === key) this.diagnosticsError = 'Report remains queued. Check connection, signer approval and destination access, then retry.'; }
    finally { runtime.sending = false; }
  },

  async clearDiagnosticsHistory() {
    const runtime = runtimes.get(this), key = diagnosticsScope(this);
    if (!key || runtime?.key !== key) return;
    runtime.generation++; runtime.buffer = [];
    await runtime.client.call('clear', key);
    if (runtime.native) { try { await window.wingmanDiagnostics.clear({ workspaceId: runtime.workspaceId }); } catch { this.diagnosticsHostStatus = 'Native clear unavailable; reopen host consent and try again.'; } }
    if (diagnosticsScope(this) === key) this.applyDiagnosticsInfo(await runtime.client.call('info', key));
  },
};
