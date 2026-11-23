import {
  createTowerPgWappDelegation,
  createTowerPgWappInstallIntent,
  getTowerPgManagedWappInstallations,
  getTowerPgWappDelegations,
  getTowerPgWappInstallIntents,
  reconcileTowerPgManagedWappInstallation,
  revokeTowerPgManagedWappInstallation,
  revokeTowerPgWappDelegation,
} from './tower-command-intents.js';
import {
  claimAutopilotWappInstallIntent,
  loadAutopilotWappActivationCatalog,
} from './wapp-autopilot-service.js';

const text = (value) => String(value ?? '').trim();
const lines = (value) => [...new Set(String(value || '').split(/[\n,]+/).map(text).filter(Boolean))];
const futureDefault = () => { const date = new Date(Date.now() + 30 * 86400000); return date.toISOString().slice(0, 16); };
const exactOrigins = (value) => lines(value).map((entry) => { const url = new URL(entry); if (url.protocol !== 'https:' || url.origin !== entry || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Origins must be exact HTTPS origins without paths, queries, or wildcards.'); return url.origin; });

export function delegationStatus(delegation, now = Date.now()) {
  if (delegation?.revoked_at) return 'revoked';
  if (Date.parse(delegation?.expires_at || 0) <= now) return 'expired';
  return 'active';
}

export function capabilityPreview({ delegateName = 'This person', filters = {}, expiresAt = '' } = {}) {
  const resources = [...(filters.app_ids || []), ...(filters.installation_ids || [])];
  const destinations = [...(filters.scope_ids || []), ...(filters.channel_ids || [])];
  const capabilities = filters.capabilities || [];
  return `${delegateName} can assign and manage ${resources.length ? resources.join(', ') : 'only explicitly requested WApps'}${destinations.length ? ` for ${destinations.join(', ')}` : ''}${capabilities.includes('activity.publish') ? ', publish Feed items only to approved destinations' : ', without Feed publishing'}${(filters.open_origins || []).length ? `, and use View links from ${(filters.open_origins || []).join(', ')}` : ''}. This does not grant workspace admin, people, billing, storage, arbitrary publishing, or channel/message access. Expires ${expiresAt || 'at the selected time'}.`;
}

export const wappManagementManagerMixin = {
  wappDelegations: [], wappInstallIntents: [], managedWappInstallations: [], wappManagementLoading: false, wappManagementError: '', wappManagementNotice: '',
  wappDelegationEditorOpen: false, wappDelegationSaving: false, wappDelegationDraft: null,
  wappInstallEditorOpen: false, wappInstallSaving: false, wappInstallDraft: null,
  wappActivationApps: [], wappActivationLoading: false,

  get wappManagementMembers() { return (this.pgWorkspaceMembers || []).filter((member) => text(member.actor_id || member.id)); },
  wappMemberName(actorId) { const member = this.wappManagementMembers.find((entry) => text(entry.actor_id || entry.id) === text(actorId)); return member ? this.getPgWorkspaceMemberLabel(member) : 'Unknown actor'; },
  wappDelegationStatus: delegationStatus,
  get wappDelegationPreview() { const draft = this.wappDelegationDraft || {}; return capabilityPreview({ delegateName: this.wappMemberName(draft.delegate_actor_id), filters: this.buildWappDelegationFilters(false), expiresAt: draft.expires_at }); },

  wappManagementContext() { const workspaceId = text(this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id); if (!workspaceId) throw new Error('Connect to a Tower PG workspace first.'); return { workspaceId, baseUrl: text(this.currentWorkspaceBackendUrl || this.backendUrl), appNpub: text(this.currentWorkspace?.appNpub || this.currentWorkspace?.app_npub) }; },
  wappAutopilotUrl() { const value = text(this.workspaceHarnessUrl || this.workspaceHarnesses?.[0]?.wingman_harness_url || this.workspaceHarnesses?.[0]?.url); if (!value) throw new Error('Configure this workspace’s Autopilot URL in Setup first.'); return new URL(value).origin; },
  async refreshWappManagement() {
    if (!this.isTowerPgMode) return [];
    this.wappManagementLoading = true; this.wappManagementError = '';
    try {
      const context = this.wappManagementContext();
      const [delegations, intents, installations] = await Promise.all([
        getTowerPgWappDelegations(this, context.workspaceId, context), getTowerPgWappInstallIntents(this, context.workspaceId, context), getTowerPgManagedWappInstallations(this, context.workspaceId, context),
      ]);
      this.wappDelegations = delegations?.delegations || [];
      this.wappInstallIntents = intents?.intents || [];
      this.managedWappInstallations = installations?.installations || [];
      return this.wappDelegations;
    } catch (error) { this.wappManagementError = error?.reason || error?.message || 'Could not load WApp management.'; return []; }
    finally { this.wappManagementLoading = false; }
  },
  openWappDelegationEditor(actorId = '') { this.wappDelegationDraft = { delegate_actor_id: text(actorId), expires_at: futureDefault(), app_ids: '', installation_ids: '', scope_ids: '', channel_ids: '', open_origins: '', autopilot_origins: '', activity_publish: true }; this.wappDelegationEditorOpen = true; this.wappManagementError = ''; },
  buildWappDelegationFilters(validate = true) { const d = this.wappDelegationDraft || {}; try { return { installation_ids: lines(d.installation_ids), app_ids: lines(d.app_ids), scope_ids: lines(d.scope_ids), channel_ids: lines(d.channel_ids), capabilities: d.activity_publish ? ['activity.publish'] : [], open_origins: exactOrigins(d.open_origins), autopilot_origins: exactOrigins(d.autopilot_origins) }; } catch (error) { if (validate) throw error; return { installation_ids: lines(d.installation_ids), app_ids: lines(d.app_ids), scope_ids: lines(d.scope_ids), channel_ids: lines(d.channel_ids), capabilities: d.activity_publish ? ['activity.publish'] : [], open_origins: lines(d.open_origins), autopilot_origins: lines(d.autopilot_origins) }; } },
  async saveWappDelegation() { const d = this.wappDelegationDraft || {}; if (!d.delegate_actor_id) { this.wappManagementError = 'Choose a person or agent.'; return; } this.wappDelegationSaving = true; this.wappManagementError = ''; try { const context = this.wappManagementContext(); await createTowerPgWappDelegation(this, context.workspaceId, { delegate_actor_id: d.delegate_actor_id, expires_at: new Date(d.expires_at).toISOString(), filters: this.buildWappDelegationFilters() }, context); this.wappDelegationEditorOpen = false; this.wappManagementNotice = 'WApp management delegation signed and saved.'; await this.refreshWappManagement(); } catch (error) { this.wappManagementError = error?.reason || error?.message || 'Could not grant WApp management.'; } finally { this.wappDelegationSaving = false; } },
  async revokeWappDelegation(delegation) { if (!confirm(`Revoke WApp management for ${this.wappMemberName(delegation.delegate_actor_id)} immediately?`)) return; try { const context = this.wappManagementContext(); await revokeTowerPgWappDelegation(this, context.workspaceId, delegation.id, context); this.wappManagementNotice = 'Delegation revoked immediately.'; await this.refreshWappManagement(); } catch (error) { this.wappManagementError = error?.reason || error?.message || 'Could not revoke delegation.'; } },

  async openWappInstallEditor(preferredTitle = '') { this.wappInstallDraft = { delegation_id: '', app_id: '', app_version: '', wapp_installation_id: crypto.randomUUID(), title: '', description: '', launch_url: '', autopilot_origin: '', autopilot_npub: '', open_origins: '', activity_publish: true, destination_scope_id: '', destination_channel_id: '' }; this.wappInstallEditorOpen = true; this.wappManagementError = ''; this.wappActivationLoading = true; try { const payload = await loadAutopilotWappActivationCatalog(this.wappAutopilotUrl()); this.wappActivationApps = payload?.apps || []; const selected = this.wappActivationApps.find((app) => text(app.title).toLowerCase() === text(preferredTitle).toLowerCase()) || this.wappActivationApps.find((app) => text(app.title).toLowerCase().includes('book of sand')) || this.wappActivationApps[0]; if (selected) this.selectWappActivationApp(selected.app_id); } catch (error) { this.wappManagementError = error?.reason || error?.message || 'Could not discover managed Autopilot apps.'; } finally { this.wappActivationLoading = false; } },
  selectWappActivationApp(appId) { const app = this.wappActivationApps.find((entry) => entry.app_id === appId); if (!app || !this.wappInstallDraft) return; Object.assign(this.wappInstallDraft, { app_id: app.app_id, app_version: app.app_version, title: app.title, launch_url: app.launch_url, autopilot_origin: app.autopilot_origin, autopilot_npub: app.autopilot_npub, open_origins: app.view_origin }); },
  selectWappActivationDestination(channelId) { const channel = this.wappPublishingDestinationGroups.flatMap((group) => group.channels).find((entry) => entry.channel_id === channelId); if (!this.wappInstallDraft) return; this.wappInstallDraft.destination_channel_id = channel?.channel_id || ''; this.wappInstallDraft.destination_scope_id = channel?.scope_id || ''; },
  async createWappInstallIntent() { const d = this.wappInstallDraft || {}; this.wappInstallSaving = true; this.wappManagementError = ''; try { const context = this.wappManagementContext(); const origin = exactOrigins(d.open_origins); const destinations = d.destination_scope_id && d.destination_channel_id ? [{ scope_id: d.destination_scope_id, channel_id: d.destination_channel_id }] : []; const created = await createTowerPgWappInstallIntent(this, context.workspaceId, { client_request_id: crypto.randomUUID(), delegation_id: text(d.delegation_id) || undefined, app_id: text(d.app_id), app_version: text(d.app_version), wapp_installation_id: text(d.wapp_installation_id), title: text(d.title), description: text(d.description) || undefined, launch_url: text(d.launch_url), autopilot_origin: text(d.autopilot_origin), autopilot_npub: text(d.autopilot_npub), registered_open_origins: origin, capabilities: d.activity_publish ? ['activity.publish'] : [], destinations }, context); await claimAutopilotWappInstallIntent(context.workspaceId, created.intent.id, this.wappAutopilotUrl()); this.wappInstallEditorOpen = false; this.wappManagementNotice = 'Book of Sand activation signed, claimed, and completed with Feed-only authority.'; await this.refreshWappManagement(); } catch (error) { this.wappManagementError = error?.reason || error?.message || 'Could not activate the WApp.'; } finally { this.wappInstallSaving = false; } },
  async reconcileManagedWapp(installation) { try { const context = this.wappManagementContext(); await reconcileTowerPgManagedWappInstallation(this, context.workspaceId, installation.wapp_installation_id, context); this.wappManagementNotice = 'Reconciliation requested. Autopilot will report the resulting state.'; await this.refreshWappManagement(); } catch (error) { this.wappManagementError = error?.code === 'step_up_required' ? 'Owner approval is required for this operation.' : error?.reason || error?.message || 'Could not request reconciliation.'; } },
  async revokeManagedWapp(installation) { if (!confirm(`Revoke ${installation.display_name || installation.wapp_installation_id}? Its launcher and Feed authority will be disabled immediately.`)) return; try { const context = this.wappManagementContext(); await revokeTowerPgManagedWappInstallation(this, context.workspaceId, installation.wapp_installation_id, context); this.wappManagementNotice = 'Installation authority revoked; runtime teardown is queued separately.'; await this.refreshWappManagement(); } catch (error) { this.wappManagementError = error?.code === 'step_up_required' ? 'Owner approval is required for this operation.' : error?.reason || error?.message || 'Could not revoke installation.'; } },
  requestWappUninstallApproval() { this.wappManagementNotice = 'Owner approval required: uninstall needs an owner step-up plus Autopilot teardown confirmation. Flight Deck will not broaden this delegation silently.'; },
};
