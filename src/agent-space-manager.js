import { createAutopilotDiscoveryClient, verifyAutopilotConnectPackage } from './autopilot-connect-client.js';
import { createTowerPgAutopilotConnection, createTowerPgWorkspaceAgent } from './tower-command-intents.js';
import { refreshInstalledAutopilotConnection, storedPackage } from './autopilot-connection-refresh.js';

const text = (value) => String(value ?? '').trim();
const VIEWS = new Set(['overview', 'pipelines', 'schedules', 'triggers']);

export function normalizeAgentPipelineView(payload = {}) {
  const definitions = new Map((Array.isArray(payload.available_definitions) ? payload.available_definitions : [])
    .map((row) => [text(row?.pipeline_definition_id), {
      id: text(row?.pipeline_definition_id), name: text(row?.name) || text(row?.pipeline_definition_id),
      description: text(row?.description), scope: text(row?.scope), version: row?.version ?? null,
      tags: Array.isArray(row?.tags) ? row.tags.map(text).filter(Boolean) : [],
    }]).filter(([id]) => id));
  const ids = (rows) => new Set((Array.isArray(rows) ? rows : []).map((row) => text(row?.pipeline_definition_id)).filter(Boolean));
  const assigned = ids(payload.assignments);
  const defaults = ids(payload.defaults);
  const overrides = (Array.isArray(payload.overrides) ? payload.overrides : []).map((row) => ({
    kind: text(row?.kind), contextId: text(row?.context_id), pipelineDefinitionId: text(row?.pipeline_definition_id),
  })).filter((row) => row.kind && row.contextId && row.pipelineDefinitionId);
  const missing = new Set((Array.isArray(payload.missing_definition_ids) ? payload.missing_definition_ids : []).map(text).filter(Boolean));
  const referenced = new Set([...assigned, ...defaults, ...overrides.map((row) => row.pipelineDefinitionId), ...missing]);
  return {
    availabilityMode: payload.availability_mode === 'implicit_all' ? 'implicit_all' : 'explicit',
    defaultMode: payload.default_mode === 'implicit_library' ? 'implicit_library' : 'explicit',
    definitions: [...definitions.values()].map((definition) => ({
      ...definition, assigned: assigned.has(definition.id), default: defaults.has(definition.id),
      overrides: overrides.filter((row) => row.pipelineDefinitionId === definition.id), missing: false,
    })),
    missing: [...referenced].filter((id) => !definitions.has(id)).map((id) => ({
      id, name: id, assigned: assigned.has(id), default: defaults.has(id),
      overrides: overrides.filter((row) => row.pipelineDefinitionId === id), missing: true,
    })),
  };
}

export function normalizeAgentBoundRows(payload, key, agent) {
  return (Array.isArray(payload?.[key]) ? payload[key] : []).filter((row) => (
    text(row?.agent_id) === text(agent?.agentId) && text(row?.bot_npub) === text(agent?.botNpub)
  ));
}

export { storedPackage } from './autopilot-connection-refresh.js';

export function formatAgentConnectError(error, fallback) {
  const rawMessage = text(error?.message || error?.reason);
  const prematureCommit = error?.name === 'PrematureCommitError' || /transaction committed too early/i.test(rawMessage);
  const message = prematureCommit
    ? 'Flight Deck could not finish saving agents locally. Retry Add selected agents; Tower will safely reuse completed requests.'
    : rawMessage.replace(/\s*See\s+https?:\/\/bit\.ly\/2kdckMn\.?\s*$/i, '').trim() || fallback;
  if (prematureCommit) return `${message} [local_storage_transaction]`;
  const code = /^[a-z][a-z0-9_]{2,48}$/.test(text(error?.code)) ? text(error.code) : '';
  const requestId = /^[A-Za-z0-9._-]{1,64}$/.test(text(error?.correlationId)) ? text(error.correlationId) : '';
  if (!code) return message;
  return `${message} [${code}${requestId ? `; request ${requestId}` : ''}]`;
}

const managerError = formatAgentConnectError;

export const agentSpaceManagerMixin = {
  agentConnections: [], workspaceAgents: [], agentConnectInput: '', agentConnectError: '', agentConnectBusy: false,
  agentConnectStep: 'package', agentDiscoveredAgents: [], agentSelectedDiscoveryIds: [], _verifiedAgentConnectPackage: null,
  selectedWorkspaceAgentId: '', agentSpaceView: 'overview', agentSpaceLoading: false, agentSpaceError: '', agentSpaceData: null,
  controlledRestartConfirmOpen: false, controlledRestartBusy: false, controlledRestartStatus: null, controlledRestartError: '',
  controlledRestartConnectionId: '', controlledRestartAvailability: 'idle', controlledRestartAvailabilityMessage: '',
  _verifiedControlledRestartPackages: null,

  openAgentConnectModal() {
    this.showAgentConnectModal = true; this.agentConnectStep = 'package'; this.agentConnectError = '';
    this.agentConnectInput = ''; this.agentDiscoveredAgents = []; this.agentSelectedDiscoveryIds = []; this._verifiedAgentConnectPackage = null;
  },
  closeAgentConnectModal() { if (!this.agentConnectBusy) this.showAgentConnectModal = false; },
  toggleDiscoveredAgent(agentId) {
    const id = text(agentId); const selected = new Set(this.agentSelectedDiscoveryIds || []);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    this.agentSelectedDiscoveryIds = [...selected];
  },
  async verifyAndDiscoverAutopilotAgents() {
    this.agentConnectBusy = true; this.agentConnectError = '';
    try {
      const verified = verifyAutopilotConnectPackage(this.agentConnectInput);
      const client = createAutopilotDiscoveryClient(verified);
      const health = await client.health();
      if (!health.ok) throw new Error('Autopilot reported that this installation is not healthy.');
      const agents = await client.discoverAgents();
      this._verifiedAgentConnectPackage = verified;
      this.agentDiscoveredAgents = agents;
      this.agentSelectedDiscoveryIds = agents.map((agent) => agent.agentId);
      this.agentConnectStep = 'agents';
      await client.disconnect();
    } catch (error) { this.agentConnectError = managerError(error, 'Could not verify this Autopilot connection package.'); }
    finally { this.agentConnectBusy = false; }
  },
  async installSelectedAutopilotAgents() {
    const verified = this._verifiedAgentConnectPackage;
    const selected = new Set(this.agentSelectedDiscoveryIds || []);
    const agents = (this.agentDiscoveredAgents || []).filter((agent) => selected.has(agent.agentId));
    const workspaceId = text(this.currentWorkspace?.workspaceId);
    if (!verified || !workspaceId || agents.length === 0) { this.agentConnectError = 'Select at least one agent to add.'; return; }
    this.agentConnectBusy = true; this.agentConnectError = '';
    try {
      const response = await createTowerPgAutopilotConnection(this, workspaceId, {
        installation_id: verified.installationId, fips_transport_npub: verified.transportNpub,
        display_name: `Autopilot ${verified.installationId}`,
        fips_endpoint: verified.fipsEndpoint, https_endpoint: verified.httpsEndpoint, api_version: String(verified.apiVersion),
        capabilities: [...verified.capabilities], metadata: { connect_package_version: verified.version, installation_npub: verified.installationNpub, health_path: verified.healthPath, agents_path: verified.agentsPath, pipeline_viewer_path: verified.pipelineViewerPath, controlled_restart_path: verified.controlledRestartPath, controlled_restart_status_path: verified.controlledRestartStatusPath },
      }, { baseUrl: this.backendUrl });
      const connection = response?.autopilot_connection;
      if (!connection?.id) throw new Error('Tower did not return the Autopilot connection.');
      let firstInstalledId = (this.workspaceAgents || []).find((row) => row.connection_id === connection.id && selected.has(row.agent_id))?.id || '';
      for (const [sortOrder, agent] of agents.entries()) {
        const existing = (this.workspaceAgents || []).find((row) => row.connection_id === connection.id && row.agent_id === agent.agentId);
        if (existing) { firstInstalledId ||= existing.id; continue; }
        const created = await createTowerPgWorkspaceAgent(this, workspaceId, {
          connection_id: connection.id, agent_id: agent.agentId, agent_npub: agent.botNpub,
          display_name: agent.name, capabilities: [], sort_order: sortOrder, is_visible: true,
          metadata: { description: agent.description, can_instruct: agent.canInstruct, paths: agent.paths },
        }, { baseUrl: this.backendUrl });
        firstInstalledId ||= created?.workspace_agent?.id || '';
      }
      await this.requestTowerSyncFamily?.('workspace-bootstrap', '', { force: true });
      this.showAgentConnectModal = false;
      if (firstInstalledId) this.openAgentSpace(firstInstalledId);
    } catch (error) { this.agentConnectError = managerError(error, 'Could not save the selected agents.'); }
    finally { this.agentConnectBusy = false; }
  },
  async openAgentSpace(workspaceAgentId, view = 'overview') {
    if (this.agentsEnabled !== true) { this.navigateTo('status'); return; }
    this.selectedWorkspaceAgentId = text(workspaceAgentId); this.navSection = 'agents'; this.mobileNavOpen = false;
    await this.selectAgentSpaceView(view, { syncRoute: true });
  },
  async initializeControlledRestartLifecycle() {
    const connections = this.controlledRestartConnections;
    if (!this.controlledRestartConnectionId || !connections.some((row) => row.id === this.controlledRestartConnectionId)) {
      this.controlledRestartConnectionId = connections.length === 1 ? connections[0].id : '';
    }
    if (!this.controlledRestartConnectionId) {
      this.controlledRestartAvailability = connections.length ? 'selection_required' : 'unavailable';
      this.controlledRestartAvailabilityMessage = connections.length
        ? 'Choose the Autopilot installation to check. No restart target is selected.'
        : 'No installed Autopilot connection is available in this workspace.';
      return false;
    }
    return this.refreshControlledRestartAvailability();
  },
  async selectControlledRestartConnection(connectionId) {
    this.controlledRestartConnectionId = text(connectionId);
    this.controlledRestartStatus = null;
    this.controlledRestartError = '';
    return this.refreshControlledRestartAvailability();
  },
  async refreshControlledRestartAvailability() {
    const connection = this.controlledRestartConnection;
    if (!connection) return this.initializeControlledRestartLifecycle();
    this.controlledRestartAvailability = 'checking';
    this.controlledRestartAvailabilityMessage = 'Checking the current signed Autopilot capabilities…';
    this.controlledRestartError = '';
    try {
      const { verified } = await refreshInstalledAutopilotConnection(this, connection);
      if (!this._verifiedControlledRestartPackages) this._verifiedControlledRestartPackages = new Map();
      this._verifiedControlledRestartPackages.set(connection.id, verified);
      if (!verified.capabilities.includes('system.controlled-restart.v1')) {
        this.controlledRestartAvailability = 'unavailable';
        this.controlledRestartAvailabilityMessage = 'This Autopilot installation does not advertise controlled restart.';
        return false;
      }
      this.controlledRestartAvailability = 'available';
      this.controlledRestartAvailabilityMessage = 'Controlled restart is available. The destructive request still requires your browser admin signature.';
      void this.resumeControlledRestartStatus();
      return true;
    } catch (error) {
      this._verifiedControlledRestartPackages?.delete(connection.id);
      this.controlledRestartAvailability = 'error';
      this.controlledRestartAvailabilityMessage = managerError(error, 'Could not verify the current signed Autopilot capabilities.');
      return false;
    }
  },
  async selectAgentSpaceView(view, { syncRoute = false } = {}) {
    if(this.pipelineViewerOpen)this.closePipelineViewer?.();
    const nextView = VIEWS.has(view) ? view : 'overview'; this.agentSpaceView = nextView;
    if (syncRoute) this.syncRoute?.();
    await this.loadSelectedAgentSpaceView();
  },
  async loadSelectedAgentSpaceView() {
    const row = (this.workspaceAgents || []).find((agent) => agent.id === this.selectedWorkspaceAgentId);
    const connection = (this.agentConnections || []).find((item) => item.id === row?.connection_id);
    if (!row || !connection) { this.agentSpaceData = null; this.agentSpaceError = row ? 'Installation connection is unavailable offline.' : ''; return; }
    this.agentSpaceLoading = true; this.agentSpaceError = '';
    try {
      const agent = { agentId: row.agent_id, botNpub: row.agent_npub, paths: row.metadata?.paths || {} };
      const payload = await createAutopilotDiscoveryClient(storedPackage(connection)).readAgent(agent, this.agentSpaceView);
      this.agentSpaceData = this.agentSpaceView === 'pipelines' ? normalizeAgentPipelineView(payload)
        : this.agentSpaceView === 'schedules' ? normalizeAgentBoundRows(payload, 'schedules', agent)
          : this.agentSpaceView === 'triggers' ? normalizeAgentBoundRows(payload, 'triggers', agent) : payload.agent;
    } catch (error) {
      this.agentSpaceError = globalThis.navigator?.onLine === false
        ? 'Agent Space is offline. The installed agent remains available after reconnecting.'
        : managerError(error, 'Could not load this Agent Space view.');
    } finally { this.agentSpaceLoading = false; }
  },
  openControlledRestartConfirm() {
    this.controlledRestartError = '';
    this.controlledRestartConfirmOpen = true;
  },
  closeControlledRestartConfirm() {
    if (!this.controlledRestartBusy) this.controlledRestartConfirmOpen = false;
  },
  async requestControlledRestart() {
    const connection = this.controlledRestartConnection;
    const verified = this._verifiedControlledRestartPackages?.get(connection?.id);
    if (!connection || !verified || this.controlledRestartAvailability !== 'available') return;
    this.controlledRestartBusy = true; this.controlledRestartError = '';
    try {
      const client = createAutopilotDiscoveryClient(verified);
      this.controlledRestartStatus = await client.controlledRestart();
      this.controlledRestartConfirmOpen = false;
      await this.pollControlledRestartStatus();
    } catch (error) {
      const code = text(error?.code);
      if (['fips_request_failed', 'fips_connection_failed', 'request_failed'].includes(code)) {
        this.controlledRestartConfirmOpen = false;
        const resumed = await this.resumeControlledRestartStatus();
        if (resumed) return;
      }
      this.controlledRestartError = managerError(error, 'Could not request the controlled restart. Check that the configured admin browser signer is available and authorized.');
    } finally { this.controlledRestartBusy = false; }
  },
  async pollControlledRestartStatus() {
    const connection = this.controlledRestartConnection;
    const verified = this._verifiedControlledRestartPackages?.get(connection?.id);
    if (!connection || !verified) return;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const client = createAutopilotDiscoveryClient(verified);
        const status = await client.controlledRestartStatus();
        this.controlledRestartStatus = status;
        this.controlledRestartError = '';
        const finalStatus = status?.operation?.status;
        if (!status?.inProgress && (['complete', 'partial', 'failed'].includes(finalStatus) || status?.outcome || status?.marker?.status === 'failed')) return status;
      } catch {
        this.controlledRestartStatus = { inProgress: true, marker: { status: 'restarting-disconnected' } };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    this.controlledRestartError = 'Autopilot did not report a final restart result within two minutes. Reopen Agents to resume the status check.';
    return null;
  },
  async resumeControlledRestartStatus() {
    const connection = this.controlledRestartConnection;
    const verified = this._verifiedControlledRestartPackages?.get(connection?.id);
    if (!connection || !verified) return false;
    try {
      const status = await createAutopilotDiscoveryClient(verified).controlledRestartStatus();
      this.controlledRestartStatus = status;
      this.controlledRestartError = '';
      if (status?.inProgress) void this.pollControlledRestartStatus();
      return Boolean(status?.operation || status?.marker || status?.outcome);
    } catch {
      return false;
    }
  },
  get selectedWorkspaceAgent() { return (this.workspaceAgents || []).find((row) => row.id === this.selectedWorkspaceAgentId) || null; },
  get selectedAgentConnection() { return (this.agentConnections || []).find((row) => row.id === this.selectedWorkspaceAgent?.connection_id) || null; },
  get selectedAgentAutopilotUrl() { return text(this.selectedWorkspaceAgent?.metadata?.launch_url || this.selectedAgentConnection?.https_endpoint); },
  get selectedAgentCanInstructLabel() { return this.selectedWorkspaceAgent?.metadata?.can_instruct === true ? 'Can receive instructions' : 'Read-only'; },
  get selectedAgentCanControlledRestart() { return (this.selectedAgentConnection?.capabilities || []).includes('system.controlled-restart.v1'); },
  get controlledRestartConnections() { return (this.agentConnections || []).filter((row) => row?.fips_endpoint && row?.metadata?.installation_npub); },
  get controlledRestartConnection() { return this.controlledRestartConnections.find((row) => row.id === this.controlledRestartConnectionId) || null; },
  get controlledRestartTargetLabel() {
    const connection = this.controlledRestartConnection;
    return connection ? `${connection.display_name || connection.installation_id} · ${connection.installation_id}` : 'No Autopilot installation selected';
  },
  get controlledRestartCanSubmit() { return this.controlledRestartAvailability === 'available' && !this.controlledRestartBusy && Boolean(this.controlledRestartConnection); },
  get controlledRestartStatusLabel() {
    const operation = this.controlledRestartStatus?.operation;
    if (operation) {
      const forced = Number(operation.counts?.forced || 0);
      const failed = (operation.sessions || []).filter((session) => session.recoveryStatus === 'failed').length;
      if (operation.status === 'partial') return `Restart partially recovered: ${failed} recovery failure(s), ${forced} forced stop(s).`;
      if (operation.status === 'failed') return `Restart failed during ${operation.failure?.phase || 'an unknown phase'}: ${operation.failure?.message || 'No detail reported.'}`;
      if (operation.status === 'complete') return `Restart complete: ${operation.counts?.eligible || 0} eligible session(s) recovered.`;
      return `Restart ${operation.status}.`;
    }
    return this.controlledRestartStatus?.marker?.status || this.controlledRestartStatus?.status || '';
  },
};
