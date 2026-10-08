import { clearPgAuthorityPresentation } from './pg-authority-presentation.js';
import { towerFetch as fetch } from './tower-transport.js';
/**
 * Workspace management methods extracted from app.js.
 *
 * The workspaceManagerMixin object contains methods and getters that use `this`
 * (the Alpine store) and should be spread into the store definition via applyMixins.
 */

import { legacyWorkspaceRecoveryMixin } from './legacy-workspace-recovery-manager.js';

import {
  getSettings,
  saveSettings,
  getWorkspaceSettings,
  upsertWorkspaceSettings,
  openWorkspaceDb,
  isWorkspaceDbOpenForKey,
  deleteWorkspaceDb,
  clearRuntimeData,
  cacheStorageImage,
  evictStorageImageCache,
} from './db.js';
import {
  setBaseUrl,
  createWorkspace,
  fetchWorkspaceAppSchemas,
  getWorkspaces,
  getTowerPgPersonalAgentSettings,
  listTowerPgWorkspaces,
  publishWorkspaceAppSchema,
  recoverWorkspace,
  updateWorkspace,
  registerWorkspaceApp,
  prepareStorageObject,
  uploadStorageObject,
  completeStorageObject,
} from './api.js';
import {
  deleteTowerPgWorkspace,
  updateTowerPgWorkspace,
  updateTowerPgPersonalAgentSettings,
  queueTowerPendingWrite,
} from './tower-command-intents.js';
import {
  findWorkspaceByKey,
  filterWorkspacesForSession,
  mergeWorkspaceEntries,
  normalizeWorkspaceEntry,
  workspaceFromToken,
  slugify,
} from './workspaces.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import {
  toRaw,
  normalizeBackendUrl,
  workspaceSettingsRecordId,
  storageObjectIdFromRef,
  storageImageCacheKey,
} from './utils/state-helpers.js';
import {
  getWorkspaceAdminGroupNpub as resolveWorkspaceAdminGroupNpub,
  getWorkspaceAdminGroupRef as resolveWorkspaceAdminGroupRef,
  getPrivateGroupNpub as resolvePrivateGroupNpub,
  getPrivateGroupRef as resolvePrivateGroupRef,
  getWorkspaceSettingsGroupNpub as resolveWorkspaceSettingsGroupNpub,
  getWorkspaceSettingsGroupRef as resolveWorkspaceSettingsGroupRef,
} from './workspace-group-refs.js';
import {
  buildWrappedMemberKeys,
  createGroupIdentity,
  hasGroupKey,
} from './crypto/group-keys.js';
import {
  clearActiveWorkspaceKey,
  getActiveWorkspaceKey,
  removeCachedWorkspaceKeyBlob,
} from './crypto/workspace-keys.js';
import { personalEncryptForNpub } from './auth/nostr.js';
import { outboundWorkspaceSettings } from './translators/settings.js';
import { normalizeChannelOrder, sortChannelsByOrder } from './channel-order.js';
import { buildAppSchemaManifestRequest, getFlightDeckSchemaBundle } from './translators/app-schema.js';
import { buildStoragePrepareBody } from './storage-payloads.js';
import { buildSuperBasedConnectionToken } from './superbased-token.js';
import { flightDeckLog } from './logging.js';
import { APP_NAME, APP_NPUB, DEFAULT_SUPERBASED_URL, FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
import { getRecordWriteFieldsForStore } from './preferred-write-group.js';
import { pgWorkspaceSessionNpubFromMe } from './pg-workspace-descriptor.js';
import { blockDisabledFlightDeckSurface, isFlightDeckSurfaceDisabled } from './disabled-surfaces.js';
import {
  normalizeOrderedAutopilotAgents,
  normalizedAutopilotLaunchUrl,
  projectPrimaryAutopilotAgent,
} from './autopilot-agents.js';
import {
  WORKROOMS_FEATURE_FLAG,
  isWorkspaceFeatureEnabled,
  withWorkspaceFeatureFlag,
} from './workspace-feature-flags.js';

const WORKSPACE_ALL_BOARD_ID = '__all__';
const PERSONAL_HARNESS_SETTINGS_PREFIX = 'flightdeck:personal-harness-settings:v1';

export function isDefinitiveMissingPgWorkspaceError(error) {
  return Number(error?.status) === 404;
}

function pgWorkspaceIdentityKeys(workspace = {}) {
  const identity = workspace?.identity && typeof workspace.identity === 'object' ? workspace.identity : workspace;
  const workspaceKey = String(workspace.workspaceKey || '').trim();
  const workspaceId = String(identity.workspaceId || identity.workspace_id || '').trim();
  const workspaceServiceNpub = String(identity.workspaceServiceNpub || identity.workspace_service_npub || '').trim();
  const workspaceOwnerNpub = String(identity.workspaceOwnerNpub || identity.workspace_owner_npub || '').trim();
  return [
    workspaceKey ? `key:${workspaceKey}` : '',
    workspaceId ? `id:${workspaceId}` : '',
    workspaceServiceNpub ? `service:${workspaceServiceNpub}` : '',
    !workspaceKey && !workspaceId && !workspaceServiceNpub && workspaceOwnerNpub ? `owner:${workspaceOwnerNpub}` : '',
  ].filter(Boolean);
}

function forgottenPgWorkspaceMarker(workspace = {}, {
  sessionNpub = '',
  forgottenAt = new Date().toISOString(),
  reason = 'local_forget',
} = {}) {
  const identity = workspace?.identity && typeof workspace.identity === 'object' ? workspace.identity : workspace;
  return {
    sessionNpub: String(sessionNpub || '').trim(),
    workspaceKey: String(workspace.workspaceKey || '').trim(),
    workspaceId: String(identity.workspaceId || identity.workspace_id || '').trim(),
    workspaceServiceNpub: String(identity.workspaceServiceNpub || identity.workspace_service_npub || '').trim(),
    workspaceOwnerNpub: String(identity.workspaceOwnerNpub || identity.workspace_owner_npub || '').trim(),
    towerServiceNpub: String(identity.towerServiceNpub || identity.tower_service_npub || '').trim(),
    appNpub: String(identity.appNpub || identity.app_npub || '').trim(),
    forgottenAt: String(forgottenAt || new Date().toISOString()),
    reason: String(reason || 'local_forget'),
  };
}

function sameForgottenPgWorkspace(left = {}, right = {}) {
  const normalize = (workspace) => {
    const identity = workspace?.identity && typeof workspace.identity === 'object' ? workspace.identity : workspace;
    return {
      workspaceKey: String(workspace?.workspaceKey || '').trim(),
      workspaceId: String(identity?.workspaceId || identity?.workspace_id || '').trim(),
      workspaceServiceNpub: String(identity?.workspaceServiceNpub || identity?.workspace_service_npub || '').trim(),
      workspaceOwnerNpub: String(identity?.workspaceOwnerNpub || identity?.workspace_owner_npub || '').trim(),
      towerServiceNpub: String(identity?.towerServiceNpub || identity?.tower_service_npub || '').trim(),
      appNpub: String(identity?.appNpub || identity?.app_npub || '').trim(),
    };
  };
  const a = normalize(left);
  const b = normalize(right);
  if (a.workspaceKey && b.workspaceKey) return a.workspaceKey === b.workspaceKey;
  if (a.workspaceServiceNpub && b.workspaceServiceNpub) {
    return a.workspaceServiceNpub === b.workspaceServiceNpub
      && (!a.towerServiceNpub || !b.towerServiceNpub || a.towerServiceNpub === b.towerServiceNpub);
  }
  if (a.workspaceId && b.workspaceId) {
    return a.workspaceId === b.workspaceId
      && Boolean(a.towerServiceNpub && a.towerServiceNpub === b.towerServiceNpub);
  }
  return Boolean(
    a.workspaceOwnerNpub
    && a.workspaceOwnerNpub === b.workspaceOwnerNpub
    && a.towerServiceNpub
    && a.towerServiceNpub === b.towerServiceNpub
    && (!a.appNpub || !b.appNpub || a.appNpub === b.appNpub)
  );
}

function samePgWorkspaceIdentity(left = {}, right = {}) {
  const leftKey = String(left.workspaceKey || '').trim();
  const rightKey = String(right.workspaceKey || '').trim();
  if (leftKey && rightKey) return leftKey === rightKey;
  const leftId = String(left.workspaceId || '').trim();
  const rightId = String(right.workspaceId || '').trim();
  const leftService = String(left.workspaceServiceNpub || '').trim();
  const rightService = String(right.workspaceServiceNpub || '').trim();
  return Boolean(leftId && rightId && leftId === rightId && leftService && leftService === rightService);
}

function resultWorkspaces(result) {
  return Array.isArray(result?.workspaces) ? result.workspaces : [];
}

async function listTowerPgWorkspacesForSession({ baseUrl, appNpub, limit } = {}) {
  const filtered = await listTowerPgWorkspaces({ baseUrl, appNpub, limit });
  if (resultWorkspaces(filtered).length > 0 || !String(appNpub || '').trim()) {
    return filtered;
  }
  return listTowerPgWorkspaces({ baseUrl, appNpub: '', limit });
}

export function guessDefaultBackendUrl() {
  return DEFAULT_SUPERBASED_URL || '';
}

function getPersonalHarnessSettingsKey(store) {
  const userNpub = String(store?.session?.npub || store?.currentViewerNpub || '').trim();
  const workspaceKey = String(
    store?.currentWorkspaceKey
    || store?.selectedWorkspaceKey
    || store?.currentWorkspace?.workspaceKey
    || store?.currentWorkspaceOwnerNpub
    || store?.workspaceOwnerNpub
    || '',
  ).trim();
  if (!userNpub || !workspaceKey || typeof localStorage === 'undefined') return '';
  return `${PERSONAL_HARNESS_SETTINGS_PREFIX}:${encodeURIComponent(userNpub)}:${encodeURIComponent(workspaceKey)}`;
}

function readPersonalHarnessSettings(store) {
  const key = getPersonalHarnessSettingsKey(store);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.personal_autopilot_configured !== true) return null;
    const legacy = {
      wingman_harness_url: String(parsed.wingman_harness_url || '').trim(),
      wingman_harness_agent_npub: String(parsed.wingman_harness_agent_npub || '').trim(),
    };
    return {
      ...legacy,
      autopilot_agents: normalizeOrderedAutopilotAgents(parsed.autopilot_agents, {
        agent_npub: legacy.wingman_harness_agent_npub,
        url: legacy.wingman_harness_url,
      }),
    };
  } catch {
    return null;
  }
}

function writePersonalHarnessSettings(store, settings) {
  const key = getPersonalHarnessSettingsKey(store);
  if (!key) return false;
  const autopilotAgents = normalizeOrderedAutopilotAgents(settings?.autopilot_agents, {
    agent_npub: settings?.wingman_harness_agent_npub,
    url: settings?.wingman_harness_url,
  });
  const primary = projectPrimaryAutopilotAgent(autopilotAgents);
  const payload = {
    personal_autopilot_configured: true,
    autopilot_agents: autopilotAgents,
    ...primary,
    updated_at: new Date().toISOString(),
  };
  localStorage.setItem(key, JSON.stringify(payload));
  return true;
}

// ---------------------------------------------------------------------------
// Mixin — methods and getters that use `this` (the Alpine store)
// ---------------------------------------------------------------------------

export const workspaceManagerMixin = {

  workspaceSelectionError: '',
  ...legacyWorkspaceRecoveryMixin,

  async activateCachedWorkspace({ workspace = this.currentWorkspace, workspaceKey = '' } = {}) {
    const expectedWorkspaceKey = String(
      workspaceKey || workspace?.workspaceKey || workspace?.workspaceOwnerNpub || '',
    ).trim();
    const expectedOwnerNpub = String(workspace?.workspaceOwnerNpub || '').trim();
    if (!expectedWorkspaceKey || !expectedOwnerNpub) return false;
    if (String(this.currentWorkspaceKey || '').trim() !== expectedWorkspaceKey) return false;
    if (String(this.workspaceOwnerNpub || '').trim() !== expectedOwnerNpub) return false;
    if (!isWorkspaceDbOpenForKey(expectedWorkspaceKey)) return false;

    // Cache activation is deliberately authority-free: the matching persisted
    // partition can render before signer restoration, Tower verification, or
    // workspace session-key setup. Live-query and local-load generation guards
    // prevent a late emission from crossing a workspace switch.
    this.startWorkspaceLiveQueries?.();
    const generation = this._workspaceSelectionGeneration;
    await Promise.all([
      this.loadLocalScopes?.(),
      this.loadLocalChannels?.({ syncRoute: false }),
    ]);
    if (
      String(this.currentWorkspaceKey || '').trim() !== expectedWorkspaceKey
      || String(this.workspaceOwnerNpub || '').trim() !== expectedOwnerNpub
      || this._workspaceSelectionGeneration !== generation
      || !isWorkspaceDbOpenForKey(expectedWorkspaceKey)
    ) return false;
    return true;
  },

  // --- computed getters ---

  get currentWorkspaceKey() {
    return this.currentWorkspace?.workspaceKey || this.selectedWorkspaceKey || '';
  },

  get workspaceOwnerNpub() {
    return this.currentWorkspace?.workspaceOwnerNpub
      || this.currentWorkspaceOwnerNpub
      || this.superbasedConnectionConfig?.workspaceOwnerNpub
      || this.ownerNpub
      || this.session?.npub
      || '';
  },

  get currentWorkspace() {
    return findWorkspaceByKey(this.knownWorkspaces, this.selectedWorkspaceKey)
      || (!this.selectedWorkspaceKey ? this.getWorkspaceByOwner(this.currentWorkspaceOwnerNpub) : null)
      || null;
  },

  get activeWorkspaceOwnerNpub() {
    return this.currentWorkspace?.workspaceOwnerNpub || this.currentWorkspaceOwnerNpub || '';
  },

  get isWorkspaceSwitching() {
    return Boolean(this.workspaceSwitchPendingKey || this.workspaceSwitchPendingNpub);
  },

  get currentWorkspaceName() {
    if (this.currentWorkspace?.name) return this.currentWorkspace.name;
    if (this.activeWorkspaceOwnerNpub) return 'Workspace';
    return 'No workspace selected';
  },

  get currentWorkspaceMeta() {
    if (this.isWorkspaceSwitching) {
      const pendingWorkspace = this.getWorkspaceByKey(this.workspaceSwitchPendingKey)
        || this.getWorkspaceByOwner(this.workspaceSwitchPendingNpub);
      const fallbackLabel = pendingWorkspace?.workspaceOwnerNpub || this.workspaceSwitchPendingNpub;
      return `Switching to ${pendingWorkspace?.name || this.getShortNpub(fallbackLabel) || 'workspace'}...`;
    }
    if (this.currentWorkspace?.description) return this.currentWorkspace.description;
    if (this.activeWorkspaceOwnerNpub) return this.getShortNpub(this.activeWorkspaceOwnerNpub);
    return 'Choose or create a workspace';
  },

  get currentWorkspaceBackendUrl() {
    return String(
      this.currentWorkspace?.directHttpsUrl
      || this.superbasedConnectionConfig?.directHttpsUrl
      || this.backendUrl
      || ''
    ).trim();
  },

  get currentWorkspaceBackendName() {
    const towerName = String(
      this.currentWorkspace?.towerName
      || this.superbasedConnectionConfig?.towerName
      || ''
    ).trim();
    if (towerName) return towerName;
    const backendUrl = this.currentWorkspaceBackendUrl;
    if (!backendUrl) return 'Self Hosted';
    const cleanUrl = normalizeBackendUrl(backendUrl);
    const host = this.mergedHostsList.find((entry) => normalizeBackendUrl(entry.url) === cleanUrl);
    const label = String(host?.label || '').trim();
    if (!label || label === cleanUrl || label === host?.url) return 'Self Hosted';
    return label;
  },

  get currentWorkspaceAvatarUrl() {
    return this.getWorkspaceAvatar(this.currentWorkspace || this.activeWorkspaceOwnerNpub);
  },

  get currentWorkspaceInitials() {
    return this.getInitials(this.currentWorkspace?.name || this.activeWorkspaceOwnerNpub || 'WS');
  },

  get currentWorkspaceGroups() {
    return this.groups.filter((group) => group.owner_npub === this.workspaceOwnerNpub);
  },

  get currentWorkspaceContentGroups() {
    return this.currentWorkspaceGroups.filter((group) => group.group_kind !== 'workspace_admin');
  },

  get canAdminWorkspace() {
    const viewerNpub = String(this.session?.npub || '').trim();
    if (!viewerNpub || !this.currentWorkspace) return false;
    if (isTowerPgBackendMode() || this.currentWorkspace?.pgBackendMode) {
      const permissions = Array.isArray(this.currentWorkspace.pgMe?.permissions)
        ? this.currentWorkspace.pgMe.permissions
        : [];
      if (permissions.includes('workspace.manage')) return true;
    }
    if (String(this.currentWorkspace.creatorNpub || '').trim() === viewerNpub) return true;
    return this.currentWorkspaceGroups.some((group) =>
      group.group_kind === 'workspace_admin'
      && Array.isArray(group.member_npubs)
      && group.member_npubs.includes(viewerNpub)
    );
  },

  get workroomsEnabled() {
    return isWorkspaceFeatureEnabled(this.currentWorkspace?.metadata, WORKROOMS_FEATURE_FLAG);
  },

  get memberPrivateGroup() {
    const memberNpub = this.session?.npub;
    if (!memberNpub) return null;
    return this.currentWorkspaceGroups.find((group) =>
      group.group_kind === 'private' && group.private_member_npub === memberNpub
    ) || null;
  },

  get memberPrivateGroupNpub() {
    return resolvePrivateGroupNpub({
      memberPrivateGroup: this.memberPrivateGroup,
      currentWorkspace: this.currentWorkspace,
    });
  },

  get memberPrivateGroupRef() {
    return resolvePrivateGroupRef({
      memberPrivateGroup: this.memberPrivateGroup,
      currentWorkspace: this.currentWorkspace,
    });
  },

  get currentWorkspaceSlug() {
    return this.currentWorkspace?.slug || slugify(this.currentWorkspaceName) || 'workspace';
  },

  isProtectedWorkspaceGroup(groupOrId) {
    const group = typeof groupOrId === 'object' && groupOrId
      ? groupOrId
      : this.groups.find((item) => item.group_id === groupOrId || item.group_npub === groupOrId);
    return ['workspace_shared', 'workspace_admin', 'private'].includes(String(group?.group_kind || '').trim());
  },

  getWorkspaceAdvancedOptionsStorageKey(workspace = this.currentWorkspace) {
    const workspaceKey = String(workspace?.workspaceKey || this.currentWorkspaceKey || workspace?.workspaceOwnerNpub || this.currentWorkspaceOwnerNpub || '').trim();
    return workspaceKey ? `flightdeck:workspace-advanced-options:${workspaceKey}` : '';
  },

  loadWorkspaceAdvancedOptionsPreference(workspace = this.currentWorkspace) {
    const key = this.getWorkspaceAdvancedOptionsStorageKey(workspace);
    if (!key || typeof localStorage === 'undefined') return false;
    return localStorage.getItem(key) === 'true';
  },

  setWorkspaceAdvancedOptionsEnabled(enabled) {
    this.workspaceAdvancedOptionsEnabled = Boolean(enabled);
    const key = this.getWorkspaceAdvancedOptionsStorageKey();
    if (key && typeof localStorage !== 'undefined') {
      localStorage.setItem(key, this.workspaceAdvancedOptionsEnabled ? 'true' : 'false');
    }
    this.normalizeSettingsTab();
  },

  normalizeSettingsTab() {
    const advancedTabs = this.workspaceAdvancedOptionsEnabled && !isFlightDeckSurfaceDisabled('flows') ? ['flows', 'data'] : (this.workspaceAdvancedOptionsEnabled ? ['data'] : []);
    const adminAdvancedTabs = this.workspaceAdvancedOptionsEnabled && !isFlightDeckSurfaceDisabled('schedules') ? ['schedules'] : [];
    const personalTabs = ['deck', 'notifications', 'apps'];
    const visibleTabs = this.canAdminWorkspace
      ? ['workspace', 'connection', ...personalTabs, 'permissions', 'scopes', 'sharing', ...advancedTabs, ...adminAdvancedTabs]
      : ['connection', ...personalTabs, 'permissions', ...(this.canAccessScopeSettings ? ['scopes'] : []), ...advancedTabs];
    if (!visibleTabs.includes(this.settingsTab)) {
      this.settingsTab = 'connection';
    }
  },

  openSettingsTab(tab) {
    const requestedTab = String(tab || 'connection').trim() || 'connection';
    const disabledSurface = requestedTab === 'flows'
      ? 'flows'
      : requestedTab === 'schedules'
        ? 'schedules'
        : '';
    if (disabledSurface && blockDisabledFlightDeckSurface(this, disabledSurface)) {
      this.settingsTab = 'connection';
      return;
    }
    this.settingsTab = requestedTab;
    this.normalizeSettingsTab();
    if (this.settingsTab === 'schedules') this.refreshSchedules?.();
    if (this.settingsTab === 'notifications') this.refreshNotificationSettings?.();
    if (this.settingsTab === 'apps') this.refreshPersonalWapps?.();
    if (this.settingsTab === 'permissions') { this.refreshTowerPgWorkspaceMembers?.({ force: true, limit: 200 }); this.refreshWappManagement?.(); }
    if (this.settingsTab === 'scopes') this.refreshScopes?.();
    if (this.settingsTab === 'sharing') this.prepareWorkspaceSharingSettings?.();
  },

  async prepareWorkspaceSharingSettings(options = {}) {
    if (!this.canAdminWorkspace) return;
    this.groupsLoading = true;
    this.groupsLoadError = null;
    try {
      const refreshOptions = {
        force: options.force === true,
        maxAgeMs: options.maxAgeMs ?? 30_000,
        minIntervalMs: options.minIntervalMs ?? 5_000,
      };
      await Promise.all([
        this.refreshGroups?.(refreshOptions) ?? Promise.resolve([]),
        this.isTowerPgMode ? (this.refreshTowerPgWorkspaceMembers?.({ force: options.force === true, limit: 200 }) ?? Promise.resolve([])) : Promise.resolve([]),
        this.isTowerPgMode ? (this.refreshChannels?.() ?? Promise.resolve([])) : Promise.resolve([]),
      ]);
      if (this.isTowerPgMode && typeof this.resetChannelBulkGrantDraft === 'function') {
        this.resetChannelBulkGrantDraft({ selectAll: true });
      }
    } catch (error) {
      this.groupsLoadError = error?.message || 'Failed to load groups';
    } finally {
      this.groupsLoading = false;
    }
  },

  // --- workspace display ---

  getWorkspaceByOwner(workspaceOwnerNpub) {
    if (!workspaceOwnerNpub) return null;
    const matches = this.knownWorkspaces.filter((entry) => entry.workspaceOwnerNpub === workspaceOwnerNpub);
    return matches.length === 1 ? matches[0] : null;
  },

  getWorkspaceByKey(workspaceKey) {
    return findWorkspaceByKey(this.knownWorkspaces, workspaceKey);
  },

  getWorkspaceDisplayEntry(workspace) {
    const workspaceKey = typeof workspace === 'string' ? workspace : workspace?.workspaceKey || '';
    const workspaceOwnerNpub = typeof workspace === 'string' ? '' : workspace?.workspaceOwnerNpub || '';
    const known = this.getWorkspaceByKey(workspaceKey)
      || this.getWorkspaceByOwner(workspaceOwnerNpub)
      || (typeof workspace === 'object' ? workspace : null)
      || {};
    const profile = this.workspaceProfileRowsByKey?.[known.workspaceKey || workspaceKey] || {};
    return {
      ...profile,
      ...known,
      workspaceKey: known.workspaceKey || workspaceKey,
      workspaceOwnerNpub: known.workspaceOwnerNpub || workspaceOwnerNpub,
      name: String(known?.name || '').trim() || String(profile?.name || '').trim(),
      description: String(known?.description || '').trim() || String(profile?.description || '').trim(),
      avatarUrl: String(known?.avatarUrl || '').trim() || String(profile?.avatarUrl || '').trim() || null,
      dashboardGreetingTemplate: String(known?.dashboardGreetingTemplate || '').trim() || String(profile?.dashboardGreetingTemplate || '').trim(),
      slug: String(known?.slug || '').trim() || String(profile?.slug || '').trim() || '',
    };
  },

  getWorkspaceName(workspace) {
    const entry = this.getWorkspaceDisplayEntry(workspace);
    return String(entry?.name || '').trim() || 'Untitled workspace';
  },

  getWorkspaceMeta(workspace) {
    const entry = this.getWorkspaceDisplayEntry(workspace);
    return String(entry?.description || '').trim() || this.getShortNpub(entry?.workspaceOwnerNpub || '');
  },

  getWorkspaceStorageBackendUrl(workspace) {
    const entry = this.getWorkspaceDisplayEntry(workspace);
    const workspaceOwnerNpub = entry?.workspaceOwnerNpub || '';
    if (entry?.directHttpsUrl) return String(entry.directHttpsUrl).trim();
    if (entry?.workspaceKey && entry.workspaceKey === this.currentWorkspaceKey) {
      return this.currentWorkspaceBackendUrl;
    }
    return '';
  },

  getWorkspaceAvatar(workspace) {
    const entry = this.getWorkspaceDisplayEntry(workspace);
    const workspaceOwnerNpub = entry?.workspaceOwnerNpub || '';
    const storedAvatar = String(entry?.avatarUrl || entry?.avatar_url || '').trim();
    const storedObjectId = storageObjectIdFromRef(storedAvatar);
    if (storedObjectId) {
      const backendUrl = this.getWorkspaceStorageBackendUrl(entry || workspaceOwnerNpub);
      const cacheKey = storageImageCacheKey(storedObjectId, backendUrl);
      const resolved = this.storageImageUrlCache?.[cacheKey];
      if (resolved) return resolved;
      const knownFailure = this.getStorageImageFailure?.(cacheKey);
      if (!knownFailure) {
        this.resolveStorageImageUrl(storedObjectId, { backendUrl }).catch(() => {});
      }
    } else if (storedAvatar) {
      return storedAvatar;
    }
    if (workspaceOwnerNpub) {
      void this.ensureWorkspaceProfileHydrated(entry?.workspaceKey || workspaceOwnerNpub);
    }
    return null;
  },

  getWorkspaceInitials(workspace) {
    if (!workspace) return this.getInitials('WS');
    if (typeof workspace === 'string') return this.getInitials(workspace);
    return this.getInitials(this.getWorkspaceName(workspace) || workspace.workspaceOwnerNpub || 'WS');
  },

  // --- workspace switcher ---

  toggleWorkspaceSwitcherMenu() {
    if (this.isWorkspaceSwitching) return;
    this.showWorkspaceSwitcherMenu = !this.showWorkspaceSwitcherMenu;
    if (this.showWorkspaceSwitcherMenu) {
      void this.hydrateKnownWorkspaceProfiles();
    }
  },

  closeWorkspaceSwitcherMenu() {
    this.showWorkspaceSwitcherMenu = false;
  },

  async handleWorkspaceSwitcherSelect(workspaceKeyOrOwner) {
    if (!workspaceKeyOrOwner || this.isWorkspaceSwitching) return;
    const workspace = this.getWorkspaceByKey(workspaceKeyOrOwner) || this.getWorkspaceByOwner(workspaceKeyOrOwner);
    if (!workspace) return;
    if (workspace.workspaceKey === this.currentWorkspaceKey) {
      this.closeWorkspaceSwitcherMenu();
      return;
    }
    // Keep the switcher visible during the switch so the user sees progress.
    this.workspaceSwitchPendingKey = workspace.workspaceKey || '';
    this.workspaceSwitchPendingNpub = workspace.workspaceOwnerNpub || '';
    this.mobileNavOpen = false;

    // Persist the new workspace selection, then navigate via slug URL so the
    // browser does a full reload into the new workspace context.
    this.selectedWorkspaceKey = workspace.workspaceKey || '';
    this.currentWorkspaceOwnerNpub = workspace.workspaceOwnerNpub;
    this.superbasedTokenInput = workspace.connectionToken || this.superbasedTokenInput;
    this.backendUrl = normalizeBackendUrl(workspace.directHttpsUrl || this.backendUrl || guessDefaultBackendUrl());
    this.ownerNpub = workspace.workspaceOwnerNpub;
    setBaseUrl(this.backendUrl);
    await this.persistWorkspaceSettings();
    const slug = workspace.slug || slugify(workspace.name);
    const page = this.navSection === 'status' ? 'flight-deck' : (this.navSection || 'flight-deck');
    const nextUrl = new URL(window.location.href);
    nextUrl.pathname = `/${slug}/${page}`;
    nextUrl.searchParams.set('workspacekey', workspace.workspaceKey || '');
    window.location.href = `${nextUrl.pathname}${nextUrl.search}`;
  },

  // --- workspace list ---

  mergeKnownWorkspaces(entries = []) {
    this.knownWorkspaces = mergeWorkspaceEntries(this.knownWorkspaces, entries);
    this.syncWorkspaceProfileDraft();
  },

  filterKnownWorkspacesForActiveSession() {
    if (!isTowerPgBackendMode()) return;
    const sessionNpub = String(this.session?.npub || '').trim();
    if (!sessionNpub) {
      const selected = this.getWorkspaceByKey(this.selectedWorkspaceKey) || this.getWorkspaceByOwner(this.currentWorkspaceOwnerNpub);
      if (selected?.pgBackendMode) {
        this.selectedWorkspaceKey = '';
        this.currentWorkspaceOwnerNpub = '';
      }
      return;
    }
    const scoped = filterWorkspacesForSession(this.knownWorkspaces, sessionNpub);
    const selectedStillVisible = scoped.some((workspace) => workspace.workspaceKey === this.selectedWorkspaceKey);
    const ownerStillVisible = scoped.some((workspace) => workspace.workspaceOwnerNpub === this.currentWorkspaceOwnerNpub);
    this.knownWorkspaces = scoped;
    if (!selectedStillVisible) this.selectedWorkspaceKey = '';
    if (!ownerStillVisible) this.currentWorkspaceOwnerNpub = '';
  },

  async hydrateKnownWorkspaceProfiles() {
    // Canonical workspace metadata now comes from the workspace API route,
    // not the shared workspace_settings record family.
  },

  async ensureWorkspaceProfileHydrated(workspaceKeyOrOwner) {
    const existing = this.getWorkspaceByKey(workspaceKeyOrOwner) || this.getWorkspaceByOwner(workspaceKeyOrOwner);
    const workspaceKey = String(existing?.workspaceKey || '').trim();
    if (!workspaceKey) return;
    if (!this._workspaceProfileHydratedKeys) this._workspaceProfileHydratedKeys = new Set();
    this._workspaceProfileHydratedKeys.add(workspaceKey);
  },

  // --- workspace profile editing ---

  revokeWorkspaceAvatarPreviewObjectUrl() {
    if (this.workspaceProfilePendingAvatarObjectUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(this.workspaceProfilePendingAvatarObjectUrl);
    }
    this.workspaceProfilePendingAvatarObjectUrl = '';
  },

  setWorkspaceAvatarPreview(url = '') {
    this.workspaceProfileAvatarPreviewUrl = String(url || '').trim();
  },

  syncWorkspaceProfileDraft(options = {}) {
    if (this.workspaceProfileDirty && !options.force) return;
    const workspace = this.currentWorkspace;
    const storedAvatar = String(workspace?.avatarUrl || '').trim();
    const storedObjectId = storageObjectIdFromRef(storedAvatar);
    const backendUrl = this.getWorkspaceStorageBackendUrl(workspace);
    this.revokeWorkspaceAvatarPreviewObjectUrl();
    this.workspaceProfilePendingAvatarFile = null;
    this.workspaceProfileNameInput = String(workspace?.name || '').trim();
    this.workspaceProfileSlugInput = String(workspace?.slug || '').trim() || slugify(workspace?.name);
    this.workspaceProfileDescriptionInput = String(workspace?.description || '').trim();
    this.workspaceProfileDashboardGreetingTemplateInput = String(workspace?.dashboardGreetingTemplate || '').trim();
    this.workspaceWorkroomsEnabledInput = isWorkspaceFeatureEnabled(workspace?.metadata, WORKROOMS_FEATURE_FLAG);
    this.workspaceProfileAvatarInput = storedAvatar;
    this.workspaceAdvancedOptionsEnabled = this.loadWorkspaceAdvancedOptionsPreference(workspace);
    this.setWorkspaceAvatarPreview(storedObjectId ? '' : (this.getWorkspaceAvatar(workspace) || ''));
    if (storedObjectId) {
      this.resolveStorageImageUrl(storedObjectId, { backendUrl })
        .then((url) => {
          if (this.workspaceProfileDirty) return;
          if (this.workspaceProfileAvatarInput !== storedAvatar) return;
          this.setWorkspaceAvatarPreview(url);
        })
        .catch(() => {});
    }
    this.workspaceProfileDirty = false;
    this.workspaceProfileError = null;
  },

  markWorkspaceProfileDirty() {
    this.workspaceProfileDirty = true;
    this.workspaceProfileError = null;
  },

  handleWorkspaceProfileField(field, value) {
    if (field === 'name') this.workspaceProfileNameInput = value;
    if (field === 'slug') this.workspaceProfileSlugInput = slugify(value);
    if (field === 'description') this.workspaceProfileDescriptionInput = value;
    if (field === 'dashboardGreetingTemplate') this.workspaceProfileDashboardGreetingTemplateInput = value;
    this.markWorkspaceProfileDirty();
  },

  handleWorkspaceWorkroomsEnabled(enabled) {
    this.workspaceWorkroomsEnabledInput = enabled === true;
    this.markWorkspaceProfileDirty();
  },

  async handleWorkspaceAvatarSelection(event) {
    const [file] = [...(event?.target?.files || [])];
    if (!file) return;
    if (!String(file.type || '').startsWith('image/')) {
      this.workspaceProfileError = 'Choose an image file for the workspace avatar.';
      event.target.value = '';
      return;
    }
    this.revokeWorkspaceAvatarPreviewObjectUrl();
    const objectUrl = URL.createObjectURL(file);
    this.workspaceProfilePendingAvatarFile = file;
    this.workspaceProfilePendingAvatarObjectUrl = objectUrl;
    this.workspaceProfileAvatarInput = '';
    this.setWorkspaceAvatarPreview(objectUrl);
    this.markWorkspaceProfileDirty();
    event.target.value = '';
  },

  clearWorkspaceAvatarDraft() {
    this.revokeWorkspaceAvatarPreviewObjectUrl();
    this.workspaceProfilePendingAvatarFile = null;
    this.workspaceProfileAvatarInput = '';
    this.setWorkspaceAvatarPreview('');
    this.markWorkspaceProfileDirty();
  },

  resetWorkspaceProfileDraft() {
    if (this.workspaceProfileSaving) return;
    this.syncWorkspaceProfileDraft({ force: true });
  },

  // --- workspace settings row ---

  applyWorkspaceSettingsRow(row, options = {}) {
    const overwriteInput = options.overwriteInput !== false;
    const pgMetadata = row ? null : (this.currentWorkspace?.metadata || this.currentWorkspace?.pgDescriptor?.metadata || null);
    const source = row || (isTowerPgBackendMode() && pgMetadata ? {
      record_id: '',
      version: 0,
      group_ids: [],
      wingman_harness_url: pgMetadata.wingman_harness_url || pgMetadata.autopilot_url || '',
      wingman_harness_agent_npub: pgMetadata.wingman_harness_agent_npub || pgMetadata.autopilot_agent_npub || '',
      triggers: [],
      channel_order: this.channelOrder || [],
    } : null);
    this.workspaceSettingsRecordId = row?.record_id || '';
    this.workspaceSettingsVersion = Number(row?.version || 0);
    this.workspaceSettingsGroupIds = Array.isArray(row?.group_ids) ? [...row.group_ids] : [];
    let autopilotAgents = normalizeOrderedAutopilotAgents(source?.autopilot_agents, {
      agent_npub: source?.wingman_harness_agent_npub,
      url: source?.wingman_harness_url,
    });
    const personalHarnessSettings = !isTowerPgBackendMode() ? readPersonalHarnessSettings(this) : null;
    if (personalHarnessSettings) {
      autopilotAgents = personalHarnessSettings.autopilot_agents;
    }
    this.workspaceHarnessAgents = autopilotAgents.map((entry) => ({ ...entry }));
    const primary = projectPrimaryAutopilotAgent(this.workspaceHarnessAgents);
    this.workspaceHarnessUrl = primary.wingman_harness_url;
    this.workspaceHarnessAgentNpub = primary.wingman_harness_agent_npub;
    for (const entry of this.workspaceHarnessAgents) {
      if (entry.agent_npub) this.resolveChatProfile?.(entry.agent_npub);
    }
    this.workspaceTriggers = Array.isArray(source?.triggers) ? [...source.triggers] : [];
    const rowChannelOrder = Array.isArray(source?.channel_order)
      ? source.channel_order.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    this.channelOrder = Array.isArray(this.channels) && this.channels.length > 0
      ? normalizeChannelOrder(rowChannelOrder, this.channels)
      : rowChannelOrder;
    if (Array.isArray(this.channels) && this.channels.length > 0) {
      this.channels = sortChannelsByOrder(this.channels, this.channelOrder);
    }
    if (overwriteInput || !this.wingmanHarnessDirty) {
      this.wingmanHarnessInput = '';
      this.wingmanHarnessDraftAgentNpub = '';
      this.wingmanHarnessAgentQuery = '';
      this.wingmanHarnessDirty = false;
    }
  },

  applyPersonalAgentSettings(settings, options = {}) {
    const remoteAgents = normalizeOrderedAutopilotAgents(settings?.autopilot_agents);
    const rowVersion = Number(settings?.row_version || 0);
    const legacyLocal = rowVersion === 0 ? readPersonalHarnessSettings(this) : null;
    const agents = remoteAgents.length > 0 || rowVersion > 0
      ? remoteAgents
      : (legacyLocal?.autopilot_agents || []);
    this.personalAgentSettingsRowVersion = rowVersion;
    this.workspaceHarnessAgents = agents.map((entry) => ({ ...entry }));
    const primary = projectPrimaryAutopilotAgent(this.workspaceHarnessAgents);
    this.workspaceHarnessUrl = primary.wingman_harness_url;
    this.workspaceHarnessAgentNpub = primary.wingman_harness_agent_npub;
    for (const entry of this.workspaceHarnessAgents) this.resolveChatProfile?.(entry.agent_npub);
    if (options.overwriteInput !== false || !this.wingmanHarnessDirty) {
      this.wingmanHarnessInput = '';
      this.wingmanHarnessDraftAgentNpub = '';
      this.wingmanHarnessAgentQuery = '';
      this.wingmanHarnessDirty = false;
    }
  },

  async refreshWorkspaceSettings(options = {}) {
    const workspaceKey = this.currentWorkspaceKey;
    const generation = this._workspaceSelectionGeneration;
    const isCurrent = () => this.currentWorkspaceKey === workspaceKey && this._workspaceSelectionGeneration === generation;
    const workspaceOwnerNpub = this.workspaceOwnerNpub;
    if (!workspaceOwnerNpub) {
      this.applyWorkspaceSettingsRow(null);
      return null;
    }

    const workspace = this.currentWorkspace;
    const personalRequest = isTowerPgBackendMode() && workspace?.workspaceId
      ? getTowerPgPersonalAgentSettings(workspace.workspaceId, {
          baseUrl: workspace.directHttpsUrl || this.backendUrl,
          appNpub: workspace.appNpub || FLIGHT_DECK_PG_APP_NPUB,
        })
      : Promise.resolve(null);
    const row = await getWorkspaceSettings(workspaceOwnerNpub);
    if (isCurrent()) this.applyWorkspaceSettingsRow(row, options);
    if (options.deferPersonalResponse === true) {
      personalRequest.then((personalResponse) => {
        if (personalResponse && isCurrent()) {
          this.applyPersonalAgentSettings(personalResponse.settings, options);
        }
      }).catch((error) => {
        flightDeckLog('debug', 'workspace', 'deferred personal settings refresh failed', {
          workspaceOwnerNpub,
          error: error?.message || String(error),
        });
      });
      return row;
    }
    const personalResponse = await personalRequest;
    if (personalResponse && isCurrent()) this.applyPersonalAgentSettings(personalResponse.settings, options);
    return row;
  },

  async loadLocalWorkspaceCoreData(options = {}) {
    const [scopes, channels, dailyNotes] = await Promise.all([
      typeof this.loadLocalScopes === 'function' ? this.loadLocalScopes() : Promise.resolve([]),
      typeof this.loadLocalChannels === 'function' ? this.loadLocalChannels(options) : Promise.resolve([]),
      typeof this.refreshDailyNotes === 'function' ? this.refreshDailyNotes().catch(() => []) : Promise.resolve([]),
    ]);
    return { scopes, channels, dailyNotes };
  },

  getWorkspaceSettingsGroupNpub() {
    return resolveWorkspaceSettingsGroupNpub({
      memberPrivateGroup: this.memberPrivateGroup,
      currentWorkspace: this.currentWorkspace,
    });
  },

  getWorkspaceSettingsGroupRef() {
    return resolveWorkspaceSettingsGroupRef({
      memberPrivateGroup: this.memberPrivateGroup,
      currentWorkspace: this.currentWorkspace,
    });
  },

  getWorkspaceAdminGroupNpub() {
    return resolveWorkspaceAdminGroupNpub({
      currentWorkspace: this.currentWorkspace,
    });
  },

  getWorkspaceAdminGroupRef() {
    return resolveWorkspaceAdminGroupRef({
      currentWorkspace: this.currentWorkspace,
    });
  },

  // --- workspace settings persistence ---

  async persistWorkspaceSettings() {
    await saveSettings({
      ...((await getSettings()) || {}),
      backendUrl: this.backendUrl,
      ownerNpub: this.ownerNpub,
      botNpub: this.botNpub,
      connectionToken: this.superbasedTokenInput,
      useCvmSync: this.useCvmSync,
      knownWorkspaces: this.knownWorkspaces,
      forgottenPgWorkspaces: this.forgottenPgWorkspaces,
      knownHosts: this.knownHosts,
      currentWorkspaceKey: this.currentWorkspaceKey || '',
      currentWorkspaceOwnerNpub: this.currentWorkspaceOwnerNpub || '',
      defaultAgentNpub: this.defaultAgentNpub || '',
    });
  },

  async uploadWorkspaceAvatarFile(file) {
    const workspaceOwnerNpub = this.workspaceOwnerNpub;
    if (!workspaceOwnerNpub) {
      throw new Error('Select a workspace first');
    }
    if (!this.canAdminWorkspace) {
      throw new Error('Only workspace admins can update the workspace avatar.');
    }
    if (!file || !String(file.type || '').startsWith('image/')) {
      throw new Error('Choose an image file for the workspace avatar.');
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const usesPgStorage = Boolean(isTowerPgBackendMode() && this.currentWorkspace?.pgBackendMode);
    const settingsGroupId = this.getWorkspaceAdminGroupRef();
    if (!settingsGroupId && !usesPgStorage) {
      throw new Error('Workspace admin group is not configured yet.');
    }
    try {
      const prepareStorage = typeof this.prepareStorageObjectForCurrentWorkspace === 'function'
        ? this.prepareStorageObjectForCurrentWorkspace.bind(this)
        : prepareStorageObject;
      const storageBackendUrl = this.getWorkspaceStorageBackendUrl(this.currentWorkspace)
        || this.currentWorkspaceBackendUrl
        || this.backendUrl
        || '';
      const storageRequestOptions = storageBackendUrl ? { baseUrl: storageBackendUrl } : {};
      const prepared = await prepareStorage(buildStoragePrepareBody({
        ownerNpub: workspaceOwnerNpub,
        ownerGroupId: usesPgStorage ? null : settingsGroupId,
        accessGroupIds: usesPgStorage ? [] : [settingsGroupId],
        isPublic: usesPgStorage,
        metadata: usesPgStorage ? {
          purpose: 'workspace-profile/avatar',
          visibility: 'public',
          workspace_id: this.currentWorkspace?.workspaceId || null,
        } : null,
        contentType: file.type || 'image/png',
        sizeBytes: file.size || bytes.byteLength,
        fileName: this.defaultPastedImageName(file, 'workspace-avatar'),
      }));
      await uploadStorageObject(prepared, bytes, file.type || 'image/png', storageRequestOptions);
      await completeStorageObject(prepared.object_id, {
        size_bytes: bytes.byteLength,
        sha256_hex: await this.sha256HexForBytes(bytes),
      }, storageRequestOptions);
      const backendUrl = storageBackendUrl || this.getWorkspaceStorageBackendUrl(this.currentWorkspace);
      const cacheKey = storageImageCacheKey(prepared.object_id, backendUrl);
      const blob = new Blob([bytes], { type: file.type || 'image/png' });
      await cacheStorageImage({
        object_id: cacheKey,
        blob,
        content_type: blob.type || 'application/octet-stream',
      });
      this.rememberStorageImageUrl(cacheKey, URL.createObjectURL(blob));
      return `storage://${prepared.object_id}`;
    } catch (error) {
      const message = String(error?.message || error);
      flightDeckLog('error', 'storage', 'workspace avatar upload failed', {
        backendUrl: this.backendUrl || null,
        workspaceOwnerNpub,
        requestUrl: error?.requestUrl || null,
        method: error?.method || null,
        status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
        message,
      });
      if (
        Number(error?.status) === 404
        && String(error?.requestUrl || '').endsWith('/api/v4/storage/prepare')
      ) {
        throw new Error(
          `Workspace avatar upload requires SuperBased storage on ${this.backendUrl || 'the workspace backend'}, `
          + 'but POST /api/v4/storage/prepare returned 404 there.',
        );
      }
      throw error;
    }
  },

  async saveWorkspaceProfile() {
    const workspace = this.currentWorkspace;
    if (!workspace) {
      this.workspaceProfileError = 'Select a workspace first';
      return;
    }
    if (!this.canAdminWorkspace) {
      this.workspaceProfileError = 'Only workspace admins can update the workspace profile.';
      return;
    }

    const name = String(this.workspaceProfileNameInput || '').trim();
    if (!name) {
      this.workspaceProfileError = 'Workspace name is required';
      return;
    }

    this.workspaceProfileSaving = true;
    this.workspaceProfileError = null;
    try {
      let avatarUrl = String(this.workspaceProfileAvatarInput || '').trim() || null;
      if (this.workspaceProfilePendingAvatarFile) {
        avatarUrl = await this.uploadWorkspaceAvatarFile(this.workspaceProfilePendingAvatarFile);
      }
      const workspaceOwnerNpub = workspace.workspaceOwnerNpub;
      const description = String(this.workspaceProfileDescriptionInput || '').trim();
      const dashboardGreetingTemplate = String(this.workspaceProfileDashboardGreetingTemplateInput || '').trim();
      const newSlug = String(this.workspaceProfileSlugInput || '').trim() || slugify(name);
      const currentSlug = String(workspace.slug || '').trim() || slugify(workspace.name);
      if (
        newSlug !== currentSlug
        && typeof window !== 'undefined'
        && !window.confirm(
          `Change the workspace URL slug from "${currentSlug}" to "${newSlug}"?\n\nExisting bookmarked links will break.`,
        )
      ) {
        return;
      }

      const requestBody = {
        name,
        slug: newSlug,
        description,
        avatar_url: avatarUrl,
      };
      const metadata = withWorkspaceFeatureFlag(
        workspace.metadata,
        WORKROOMS_FEATURE_FLAG,
        this.workspaceWorkroomsEnabledInput,
      );
      if (workspace.pgBackendMode) requestBody.metadata = metadata;
      const response = workspace.pgBackendMode
        ? await updateTowerPgWorkspace(this, workspace.workspaceId, requestBody, {
          baseUrl: workspace.directHttpsUrl || this.currentWorkspaceBackendUrl,
          appNpub: workspace.appNpub || FLIGHT_DECK_PG_APP_NPUB,
        })
        : await updateWorkspace(workspaceOwnerNpub, requestBody);
      const savedSlug = String(response?.slug || '').trim() || newSlug;
      this.workspaceProfileRowsByKey = {
        ...(this.workspaceProfileRowsByKey || {}),
        [workspace.workspaceKey]: {
          ...(this.workspaceProfileRowsByKey?.[workspace.workspaceKey] || {}),
          workspaceKey: workspace.workspaceKey,
          workspaceOwnerNpub,
          name: response?.name ?? name,
          description: response?.description ?? description,
          avatarUrl: response?.avatar_url ?? avatarUrl,
          dashboardGreetingTemplate,
          metadata: response?.metadata ?? metadata,
          slug: savedSlug,
        },
      };
      this.mergeKnownWorkspaces([{
        workspaceKey: workspace.workspaceKey,
        workspaceOwnerNpub,
        name: response?.name ?? name,
        description: response?.description ?? description,
        avatarUrl: response?.avatar_url ?? avatarUrl,
        dashboardGreetingTemplate,
        metadata: response?.metadata ?? metadata,
        slug: savedSlug,
      }]);
      await this.persistWorkspaceSettings();
      this.syncWorkspaceProfileDraft({ force: true });
    } catch (error) {
      this.workspaceProfileError = error?.message || 'Failed to save workspace profile';
    } finally {
      this.workspaceProfileSaving = false;
    }
  },

  async saveHarnessSettings({ triggerOnly = false } = {}) {
    if (!triggerOnly) this.wingmanHarnessError = null;
    if (!this.session?.npub) {
      const msg = 'Sign in first';
      if (triggerOnly) throw new Error(msg);
      this.wingmanHarnessError = msg;
      return;
    }

    const workspaceOwnerNpub = this.workspaceOwnerNpub;
    if (!workspaceOwnerNpub) {
      const msg = 'Select a workspace first';
      if (triggerOnly) throw new Error(msg);
      this.wingmanHarnessError = msg;
      return;
    }
    let normalizedUrl;
    let normalizedAgents = [];
    if (triggerOnly) {
      // When saving triggers, use the stored harness URL, not the input field
      normalizedUrl = this.workspaceHarnessUrl || '';
    } else {
      const draftAgents = Array.isArray(this.workspaceHarnessAgents)
        && (this.workspaceHarnessAgents.length > 0 || this.wingmanHarnessDirty)
        ? this.workspaceHarnessAgents
        : ((this.workspaceHarnessAgentNpub || this.wingmanHarnessInput) ? [{
            agent_npub: this.workspaceHarnessAgentNpub,
            url: this.wingmanHarnessInput,
          }] : []);
      for (const [index, entry] of draftAgents.entries()) {
        const agentNpub = String(entry?.agent_npub || '').trim();
        const rawUrl = String(entry?.url || '').trim();
        const url = normalizedAutopilotLaunchUrl(rawUrl);
        if (!agentNpub) {
          this.wingmanHarnessError = `Select an agent for Autopilot ${index + 1}.`;
          return;
        }
        if (!url) {
          this.wingmanHarnessError = `Enter a valid http(s) Autopilot URL for ${this.getSenderName?.(agentNpub) || `agent ${index + 1}`}.`;
          return;
        }
        normalizedAgents.push({ agent_npub: agentNpub, url });
      }
      normalizedUrl = normalizedAgents[0]?.url || '';
    }

    if (!triggerOnly) {
      const primary = projectPrimaryAutopilotAgent(normalizedAgents);
      if (isTowerPgBackendMode()) {
        const workspace = this.currentWorkspace;
        try {
          const response = await updateTowerPgPersonalAgentSettings(this, workspace.workspaceId, {
            autopilot_agents: normalizedAgents,
            expected_row_version: Number(this.personalAgentSettingsRowVersion || 0),
          }, {
            baseUrl: workspace.directHttpsUrl || this.backendUrl,
            appNpub: workspace.appNpub || FLIGHT_DECK_PG_APP_NPUB,
          });
          this.applyPersonalAgentSettings(response?.settings, { overwriteInput: true });
          writePersonalHarnessSettings(this, { autopilot_agents: normalizedAgents });
          this.wingmanHarnessError = null;
          return response?.settings || null;
        } catch (error) {
          if (Number(error?.status) === 409) {
            await this.refreshWorkspaceSettings({ overwriteInput: true });
            this.wingmanHarnessError = 'Your agent list changed in another client. The latest Tower list has been reloaded; review it and save again.';
            return null;
          }
          this.wingmanHarnessError = error?.message || 'Failed to save agents';
          return null;
        }
      }
      const saved = writePersonalHarnessSettings(this, { autopilot_agents: normalizedAgents });
      if (!saved) {
        this.wingmanHarnessError = 'Select a workspace first';
        return null;
      }
      this.workspaceHarnessAgents = normalizedAgents;
      this.workspaceHarnessUrl = primary.wingman_harness_url;
      this.workspaceHarnessAgentNpub = primary.wingman_harness_agent_npub;
      for (const entry of this.workspaceHarnessAgents) this.resolveChatProfile?.(entry.agent_npub);
      this.wingmanHarnessInput = '';
      this.wingmanHarnessDraftAgentNpub = '';
      this.wingmanHarnessAgentQuery = '';
      this.wingmanHarnessDirty = false;
      this.wingmanHarnessError = null;
      return { personal: true };
    }

    if (!this.canAdminWorkspace) {
      const msg = 'Only workspace admins can update shared automation settings.';
      throw new Error(msg);
    }

    if (isTowerPgBackendMode()) {
      return null;
    }

    const now = new Date().toISOString();
    const writeGroupRef = this.getWorkspaceAdminGroupRef();
    if (!writeGroupRef) {
      const msg = 'Workspace admin group is not configured yet.';
      if (triggerOnly) throw new Error(msg);
      this.wingmanHarnessError = msg;
      return;
    }
    const groupIds = [writeGroupRef];
    const nextVersion = Math.max(1, Number(this.workspaceSettingsVersion || 0) + 1);
    const recordId = this.workspaceSettingsRecordId || workspaceSettingsRecordId(workspaceOwnerNpub);

    // Preserve workspace profile fields so a harness/trigger save doesn't blank them
    const existing = await getWorkspaceSettings(workspaceOwnerNpub);
    const workspaceName = existing?.workspace_name ?? String(this.workspaceProfileNameInput || '').trim();
    const workspaceDescription = existing?.workspace_description ?? String(this.workspaceProfileDescriptionInput || '').trim();
    const workspaceAvatarUrl = (existing?.workspace_avatar_url ?? String(this.workspaceProfileAvatarInput || '').trim()) || null;
    const harnessAgentNpub = triggerOnly
      ? String(existing?.wingman_harness_agent_npub ?? this.workspaceHarnessAgentNpub ?? '').trim()
      : String(this.workspaceHarnessAgentNpub || '').trim();

    const localRow = {
      workspace_owner_npub: workspaceOwnerNpub,
      record_id: recordId,
      owner_npub: workspaceOwnerNpub,
      workspace_name: workspaceName,
      workspace_description: workspaceDescription,
      workspace_avatar_url: workspaceAvatarUrl,
      wingman_harness_url: normalizedUrl,
      wingman_harness_agent_npub: harnessAgentNpub,
      triggers: toRaw(this.workspaceTriggers || []),
      group_ids: groupIds,
      sync_status: 'pending',
      record_state: 'active',
      version: nextVersion,
      updated_at: now,
    };

    await upsertWorkspaceSettings(localRow);
    this.applyWorkspaceSettingsRow(localRow);

    const writeFields = await getRecordWriteFieldsForStore(this, localRow, {
      label: 'Workspace settings write',
      writeGroupRef,
    });
    const envelope = await outboundWorkspaceSettings({
      record_id: recordId,
      owner_npub: workspaceOwnerNpub,
      workspace_owner_npub: workspaceOwnerNpub,
      workspace_name: workspaceName,
      workspace_description: workspaceDescription,
      workspace_avatar_url: workspaceAvatarUrl,
      wingman_harness_url: normalizedUrl,
      wingman_harness_agent_npub: harnessAgentNpub,
      triggers: toRaw(this.workspaceTriggers || []),
      group_ids: writeFields.group_ids,
      version: nextVersion,
      previous_version: Math.max(0, nextVersion - 1),
      signature_npub: this.session.npub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: recordId,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    // Perform immediate sync so the caller gets feedback on push failures.
    // If sync fails, the pending write remains in Dexie for the next cycle.
    try {
      await this.flushAndBackgroundSync();
    } catch (syncError) {
      flightDeckLog('warn', 'settings', 'harness settings sync failed, will retry', {
        error: syncError?.message || String(syncError),
      });
    }
    await this.refreshSyncStatus();
    this.ensureBackgroundSync(true);
  },

  async saveWorkspaceChannelOrder(order = []) {
    const workspaceOwnerNpub = this.workspaceOwnerNpub;
    if (!workspaceOwnerNpub || !this.session?.npub) return null;

    const normalizedOrder = normalizeChannelOrder(order, this.channels || []);
    this.channelOrder = normalizedOrder;
    this.channels = sortChannelsByOrder(this.channels || [], normalizedOrder);
    if (isTowerPgBackendMode()) {
      this.error = 'Channel order persistence is not available for Tower PG workspaces yet.';
      return null;
    }

    const existing = await getWorkspaceSettings(workspaceOwnerNpub);
    const now = new Date().toISOString();
    const nextVersion = Math.max(
      1,
      Number(existing?.version || 0),
      Number(this.workspaceSettingsVersion || 0),
    ) + 1;
    const recordId = existing?.record_id || this.workspaceSettingsRecordId || workspaceSettingsRecordId(workspaceOwnerNpub);
    const workspaceName = existing?.workspace_name ?? String(this.workspaceProfileNameInput || '').trim();
    const workspaceDescription = existing?.workspace_description ?? String(this.workspaceProfileDescriptionInput || '').trim();
    const workspaceAvatarUrl = (existing?.workspace_avatar_url ?? String(this.workspaceProfileAvatarInput || '').trim()) || null;
    const harnessUrl = existing?.wingman_harness_url ?? this.workspaceHarnessUrl ?? '';
    const harnessAgentNpub = existing?.wingman_harness_agent_npub ?? this.workspaceHarnessAgentNpub ?? '';
    const triggers = Array.isArray(existing?.triggers) ? existing.triggers : toRaw(this.workspaceTriggers || []);
    const writeGroupRef = this.getWorkspaceSettingsGroupRef()
      || this.getWorkspaceAdminGroupRef()
      || this.workspaceSettingsGroupIds?.[0]
      || null;
    if (!writeGroupRef) {
      this.error = 'Workspace settings group is not configured yet.';
      return null;
    }

    const localRow = {
      workspace_owner_npub: workspaceOwnerNpub,
      record_id: recordId,
      owner_npub: workspaceOwnerNpub,
      workspace_name: workspaceName,
      workspace_description: workspaceDescription,
      workspace_avatar_url: workspaceAvatarUrl,
      wingman_harness_url: harnessUrl,
      wingman_harness_agent_npub: harnessAgentNpub,
      triggers,
      channel_order: normalizedOrder,
      group_ids: [writeGroupRef],
      sync_status: 'pending',
      record_state: 'active',
      version: nextVersion,
      updated_at: now,
    };

    await upsertWorkspaceSettings(localRow);
    this.applyWorkspaceSettingsRow(localRow, { overwriteInput: false });

    const writeFields = await getRecordWriteFieldsForStore(this, localRow, {
      label: 'Workspace channel order write',
      writeGroupRef,
    });
    const envelope = await outboundWorkspaceSettings({
      record_id: recordId,
      owner_npub: workspaceOwnerNpub,
      workspace_owner_npub: workspaceOwnerNpub,
      workspace_name: workspaceName,
      workspace_description: workspaceDescription,
      workspace_avatar_url: workspaceAvatarUrl,
      wingman_harness_url: harnessUrl,
      wingman_harness_agent_npub: harnessAgentNpub,
      triggers,
      channel_order: normalizedOrder,
      group_ids: writeFields.group_ids,
      version: nextVersion,
      previous_version: Math.max(0, nextVersion - 1),
      signature_npub: this.session.npub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: recordId,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });

    try {
      await this.flushAndBackgroundSync();
    } catch (syncError) {
      flightDeckLog('warn', 'settings', 'channel order sync failed, will retry', {
        error: syncError?.message || String(syncError),
      });
    }
    await this.refreshSyncStatus?.();
    this.ensureBackgroundSync?.(true);
    return localRow;
  },

  // --- workspace CRUD ---

  async selectWorkspace(workspaceKeyOrOwner, options = {}) {
    const selectionGeneration = (this._workspaceSelectionRequest || 0) + 1;
    this._workspaceSelectionRequest = selectionGeneration;
    let workspace = this.getWorkspaceByKey(workspaceKeyOrOwner) || this.getWorkspaceByOwner(workspaceKeyOrOwner);
    if (!workspace) return;
    if (isTowerPgBackendMode() && workspace.pgBackendMode && !options.pgVerified && !options.skipPgVerification) {
      try {
        workspace = await this.ensurePgWorkspaceAvailable(workspace, { allowCached: options.refresh === false });
      } catch (error) {
        if (this._workspaceSelectionRequest !== selectionGeneration) return;
        const detail = error?.message || 'Workspace access verification failed';
        const message = `Could not verify workspace access: ${detail}. Check your connection and signer, then select the workspace again to retry.`;
        this.superbasedError = message;
        this.connectWorkspacesError = message;
        this.workspaceSelectionError = message;
        // A failed request is not evidence that the saved workspace is missing.
        // Return before activation, cache resets, or persisting a new selection.
        // Retain the existing rejection of a saved selection from another signer.
        const current = this.currentWorkspace;
        const sessionNpub = String(this.session?.npub || '').trim();
        if (current?.pgSessionNpub && sessionNpub && current.pgSessionNpub !== sessionNpub) {
          this.selectedWorkspaceKey = '';
          this.currentWorkspaceOwnerNpub = '';
          this.showWorkspaceBootstrapModal = false;
          this.showConnectModal = true;
          await this.persistWorkspaceSettings?.();
        }
        return;
      }
      if (!workspace) return;
    }

    if (this._workspaceSelectionRequest !== selectionGeneration) return;
    this.workspaceSelectionError = '';
    const previousWorkspaceKey = this.currentWorkspaceKey;
    const nextWorkspaceKey = workspace.workspaceKey || workspace.workspaceOwnerNpub;
    if (previousWorkspaceKey !== nextWorkspaceKey && this.chatImagePreviewModal?.objectId) this.closeChatImagePreview?.({ restoreFocus: false });
    const shouldOpenWorkspaceHome = Boolean(options.openWorkspaceHome);
    const loadedWorkspaceKey = String(this.localWorkspaceCoreLoadedForKey || '').trim();
    const hasRuntimeData = Boolean(
      this.selectedChannelId
      || this.activeThreadId
      || this.channels?.length
      || this.messages?.length
      || this.groups?.length
      || this.documents?.length
      || this.tasks?.length
    );
    const shouldResetRuntimeData = Boolean(
      (previousWorkspaceKey && previousWorkspaceKey !== nextWorkspaceKey)
      || (loadedWorkspaceKey && loadedWorkspaceKey !== nextWorkspaceKey)
      || (shouldOpenWorkspaceHome && hasRuntimeData && loadedWorkspaceKey !== nextWorkspaceKey)
      || (!loadedWorkspaceKey && hasRuntimeData && previousWorkspaceKey !== nextWorkspaceKey)
    );
    if (previousWorkspaceKey && previousWorkspaceKey !== nextWorkspaceKey) {
      this.disposeTowerSyncService?.('workspace-switch');
    }
    this.stopDrive?.();
    this._workspaceSelectionGeneration = (this._workspaceSelectionGeneration || 0) + 1;
    this.selectedWorkspaceKey = workspace.workspaceKey || '';
    this.workspaceSwitchPendingNpub = workspace.workspaceOwnerNpub;
    this.workspaceSwitchPendingKey = workspace.workspaceKey || '';
    this.showWorkspaceSwitcherMenu = false;
    try {
      this.startSharedLiveQueries();
      this.stopWorkspaceLiveQueries();
      this.currentWorkspaceOwnerNpub = workspace.workspaceOwnerNpub;
      openWorkspaceDb(workspace.workspaceKey || workspace.workspaceOwnerNpub);
      this.legacyWorkspaceRecoveryNotice = '';
      void this.refreshLegacyWorkspaceRecovery(workspace);
      this.showWorkspaceBootstrapModal = false;
      this.superbasedTokenInput = workspace.connectionToken || this.superbasedTokenInput;
      this.backendUrl = normalizeBackendUrl(workspace.directHttpsUrl || this.backendUrl || guessDefaultBackendUrl());
      this.ownerNpub = workspace.workspaceOwnerNpub;
      setBaseUrl(this.backendUrl);
      const activeWorkspaceKey = getActiveWorkspaceKey();
      const activeWorkspaceOwnerNpub = String(
        activeWorkspaceKey?.workspaceServiceNpub
        || activeWorkspaceKey?.workspaceOwnerNpub
        || ''
      ).trim();
      const expectedWorkspaceServiceNpub = String(
        workspace.workspaceServiceNpub
        || workspace.workspaceOwnerNpub
        || ''
      ).trim();
      const activeWorkspaceUserNpub = String(activeWorkspaceKey?.userNpub || '').trim();
      const currentUserNpub = String(this.session?.npub || '').trim();
      if (
        activeWorkspaceKey
        && (
          activeWorkspaceOwnerNpub !== expectedWorkspaceServiceNpub
          || (currentUserNpub && activeWorkspaceUserNpub && activeWorkspaceUserNpub !== currentUserNpub)
        )
      ) {
        clearActiveWorkspaceKey();
      }

      // Reset hydration cache so the new workspace can hydrate fresh
      if (this._workspaceProfileHydratedKeys) this._workspaceProfileHydratedKeys.clear();

      if (shouldResetRuntimeData) {
        this.chatPresentationCache?.clear?.();
        // Switching changes the active partition; retain its rows, outbox and cursors.
        evictStorageImageCache().catch(() => {});
        this.revokeStorageImageObjectUrls();
        this.scopes = [];
        this.reports = [];
        this.wapps = [];
        this.fileFolders = [];
        this.fileMessages = [];
        this.fileComments = [];
        this.docComments = [];
        this.statusRecentChanges = [];
        this.workspaceHarnessAgents = [];
        this.dailyNotes = [];
        this.pgWorkspaceMembers = [];
        this.closeMentionPopover?.();
        this.recentChannelMessages = [];
        this.resetWappActivityProjection?.();
        this.selectedDocId = null;
        this.selectedDocType = null;
        this.currentFolderId = null;
        this.selectedReportId = null;
        this.activeOpportunityId = null;
        this.closeTaskDetail?.({ syncRoute: false });
        this.chatProfiles = {};
        this.channels = [];
        this.messages = [];
        this.selectedChannelId = null;
        // PG channel/thread context is derived from the selected board.
        this.selectedBoardId = null;
        this.closeThread?.({ syncRoute: false });
        this.stopSelectedChannelLiveQuery?.();
        this.groups = [];
        this.documents = [];
        this.directories = [];
        this.tasks = [];
        this.schedules = [];
        this.audioNotes = [];
        this.taskComments = [];
        this.flows = [];
        this.approvals = [];
        this.showNewScheduleModal = false;
        this.cancelEditSchedule();
        this.hasForcedInitialBackfill = false;
        this.hasForcedTaskFamilyBackfill = false;
        this.docCommentBackfillAttemptsByDocId = {};
        this.scopesLoaded = false;
        clearPgAuthorityPresentation(this);
        this.pgNavigationRecoveryPending = false;
        this.pgNavigationRecoverySelection = null;
        this.pgNavigationGeneration = null;
        this.pgNavigationWorkspaceKey = '';
        this.localWorkspaceCoreLoadedForKey = '';
      }

      if (isTowerPgBackendMode() && typeof this.ensureWorkspaceSessionKey === 'function') {
        await this.ensureWorkspaceSessionKey();
      }
      if (this._workspaceSelectionRequest !== selectionGeneration) return;

      if (this.localWorkspaceCoreLoadedForKey !== nextWorkspaceKey) {
        await this.loadLocalWorkspaceCoreData?.({ syncRoute: false });
        if (this._workspaceSelectionRequest !== selectionGeneration) return;
        this.localWorkspaceCoreLoadedForKey = nextWorkspaceKey;
      }
      this.startWorkspaceLiveQueries();
      if (shouldOpenWorkspaceHome) {
        this.navSection = 'status';
        this.selectedBoardId = WORKSPACE_ALL_BOARD_ID;
        this.persistSelectedBoardId?.(this.selectedBoardId);
        this.showBoardDescendantTasks = false;
        this.taskViewMode = 'kanban';
        this.taskSortMode = 'manual';
        this.selectedChannelId = null;
        await this.closeThread?.({ syncRoute: false });
        await this.closeTaskDetail?.({ syncRoute: false });
        this.selectedDocType = null;
        this.selectedDocId = null;
        this.selectedDocCommentId = null;
        this.currentFolderId = null;
        this.selectedReportId = null;
        this.activeOpportunityId = null;
      } else {
        this.selectedBoardId = this.readStoredTaskBoardId() || null;
      }
      this.validateSelectedBoardId();
      this.normalizeSettingsTab();
      await this.persistWorkspaceSettings();
      if (!isTowerPgBackendMode() && typeof this.ensureWorkspaceSessionKey === 'function') {
        await this.ensureWorkspaceSessionKey();
      }
      if (!isTowerPgBackendMode()) {
        this.registerCurrentWorkspaceApp().catch((error) => {
          console.debug('workspace app registration skipped:', error?.message || error);
        });
        this.publishCurrentWorkspaceAppSchema().catch((error) => {
          console.debug('workspace app schema publish skipped:', error?.message || error);
        });
      }
      await this.refreshWorkspaceSettings({ deferPersonalResponse: true });
      this.syncWorkspaceProfileDraft({ force: true });
      if (shouldOpenWorkspaceHome) this.syncRoute?.(true);
    } finally {
      if (this.workspaceSwitchPendingKey === workspace.workspaceKey) {
        this.workspaceSwitchPendingKey = '';
      }
      if (this.workspaceSwitchPendingNpub === workspace.workspaceOwnerNpub) {
        this.workspaceSwitchPendingNpub = '';
      }
    }
  },

  async verifyPgWorkspaceForSelection(workspace) {
    const sessionNpub = String(this.session?.npub || '').trim();
    if (!sessionNpub) throw new Error('Sign in first');
    const cachedSessionNpub = String(workspace?.pgSessionNpub || '').trim();
    if (cachedSessionNpub && cachedSessionNpub !== sessionNpub) {
      throw new Error('Cached workspace belongs to a different signer');
    }
    if (typeof this.verifyPgDescriptor !== 'function' || typeof this.rememberVerifiedPgWorkspace !== 'function') {
      throw new Error('PG workspace verifier is unavailable');
    }
    const descriptorInput = workspace.pgDescriptor || {
      type: 'wingman_workspace_locator',
      tower_base_url: workspace.directHttpsUrl || this.backendUrl,
      identity: {
        tower_service_npub: workspace.towerServiceNpub || workspace.serviceNpub,
        workspace_service_npub: workspace.workspaceServiceNpub,
        workspace_owner_npub: workspace.workspaceOwnerNpub,
        workspace_id: workspace.workspaceId,
        app_npub: workspace.appNpub || FLIGHT_DECK_PG_APP_NPUB,
      },
      label: workspace.name,
      description: workspace.description,
    };
    const { descriptor, me } = await this.verifyPgDescriptor(descriptorInput, {
      baseUrl: workspace.directHttpsUrl || this.backendUrl,
    });
    const verifiedSessionNpub = pgWorkspaceSessionNpubFromMe(me, sessionNpub);
    if (verifiedSessionNpub !== sessionNpub) {
      throw new Error('Workspace descriptor was verified by a different signer');
    }
    return this.rememberVerifiedPgWorkspace(descriptor, me);
  },

  isPgWorkspaceForgottenThisLoad(workspace = {}, { event = null } = {}) {
    const sessionNpub = String(this.session?.npub || '').trim();
    const marker = (this.forgottenPgWorkspaces || []).find((entry) =>
      (!entry.sessionNpub || entry.sessionNpub === sessionNpub)
      && sameForgottenPgWorkspace(entry, workspace)
    );
    if (!marker) return false;

    const eventMs = Number(event?.created_at || 0) * 1000;
    const forgottenMs = Date.parse(marker?.forgottenAt || '');
    if (eventMs > 0 && Number.isFinite(forgottenMs) && eventMs > forgottenMs) {
      this.clearPgWorkspaceForgotten(workspace);
      return false;
    }
    return true;
  },

  rememberPgWorkspaceForgottenThisLoad(workspace = {}, options = {}) {
    if (!(this._forgottenPgWorkspaceKeysThisLoad instanceof Set)) {
      this._forgottenPgWorkspaceKeysThisLoad = new Set();
    }
    for (const key of pgWorkspaceIdentityKeys(workspace)) {
      this._forgottenPgWorkspaceKeysThisLoad.add(key);
    }
    const marker = forgottenPgWorkspaceMarker(workspace, {
      sessionNpub: this.session?.npub,
      ...options,
    });
    const retained = (this.forgottenPgWorkspaces || []).filter((entry) =>
      entry.sessionNpub !== marker.sessionNpub || !sameForgottenPgWorkspace(entry, marker)
    );
    this.forgottenPgWorkspaces = [marker, ...retained].slice(0, 200);
    return marker;
  },

  clearPgWorkspaceForgotten(workspace = {}) {
    const sessionNpub = String(this.session?.npub || '').trim();
    this.forgottenPgWorkspaces = (this.forgottenPgWorkspaces || []).filter((entry) =>
      (entry.sessionNpub && entry.sessionNpub !== sessionNpub)
      || !sameForgottenPgWorkspace(entry, workspace)
    );
    if (this._forgottenPgWorkspaceKeysThisLoad instanceof Set) {
      for (const key of pgWorkspaceIdentityKeys(workspace)) this._forgottenPgWorkspaceKeysThisLoad.delete(key);
    }
  },

  findKnownPgWorkspaceForLocator(locator = {}) {
    const identity = locator?.identity && typeof locator.identity === 'object' ? locator.identity : locator;
    const workspaceId = String(identity.workspace_id || identity.workspaceId || '').trim();
    const workspaceServiceNpub = String(identity.workspace_service_npub || identity.workspaceServiceNpub || '').trim();
    return (this.knownWorkspaces || []).find((workspace) =>
      workspace?.pgBackendMode
      && ((!workspaceId || workspace.workspaceId === workspaceId)
        && (!workspaceServiceNpub || workspace.workspaceServiceNpub === workspaceServiceNpub))
    ) || null;
  },

  async ensurePgWorkspaceAvailable(workspace, { allowCached = false } = {}) {
    if (!workspace || this.isPgWorkspaceForgottenThisLoad(workspace)) return null;
    try {
      return await this.verifyPgWorkspaceForSelection(workspace);
    } catch (error) {
      const status = Number(error?.status || 0);
      const transient = status >= 500 || status === 408 || status === 429
        || (!status && (error?.name === 'TypeError' || error?.name === 'AbortError'
          || error?.name === 'TimeoutError' || /timed? out|timeout|failed to fetch|network/i.test(error?.message || '')));
      // Refresh may reuse this signer's previously verified selection. A
      // transport failure says nothing about membership; new selections and
      // explicit access denials still require successful verification.
      if (allowCached && transient && this.session?.npub
        && workspace.pgSessionNpub === this.session.npub
        && workspace.workspaceKey && workspace.workspaceKey === this.selectedWorkspaceKey) {
        this.superbasedError = `Updates unavailable: ${error?.message || 'Tower is unreachable'}. Your saved workspace is still available. Retry updates when the connection recovers.`;
        return workspace;
      }
      if (!isDefinitiveMissingPgWorkspaceError(error)) throw error;
      await this.forgetMissingPgWorkspace(workspace, {
        error,
        reason: 'descriptor_not_found',
        towerResult: 'workspace_not_found',
        selectFallback: true,
      });
      return null;
    }
  },

  async forgetMissingPgWorkspace(workspace, options = {}) {
    if (!workspace?.pgBackendMode) return { removed: false, reason: 'not_pg_workspace' };
    if (options.error && !isDefinitiveMissingPgWorkspaceError(options.error)) {
      return { removed: false, reason: 'not_definitive_404' };
    }
    if (this.isPgWorkspaceForgottenThisLoad(workspace)) {
      return { removed: false, reason: 'already_removed_this_load' };
    }

    this.rememberPgWorkspaceForgottenThisLoad(workspace, {
      reason: options.reason || 'workspace_unavailable',
    });
    const removedCurrent = samePgWorkspaceIdentity(workspace, this.currentWorkspace || {})
      || String(this.selectedWorkspaceKey || '').trim() === String(workspace.workspaceKey || '').trim();

    if (typeof this.publishPgWorkspaceSelfIndexTombstone === 'function') {
      await this.publishPgWorkspaceSelfIndexTombstone(workspace, {
        towerResult: options.towerResult || 'workspace_not_found',
        reason: options.reason || 'descriptor_not_found',
        ...(options.sourceEventId ? { sourceEventId: options.sourceEventId } : {}),
      }).catch(() => null);
    }

    this.knownWorkspaces = (this.knownWorkspaces || []).filter((entry) => !samePgWorkspaceIdentity(entry, workspace));

    await Promise.resolve(deleteWorkspaceDb(workspace.workspaceKey || workspace.workspaceOwnerNpub)).catch(() => null);
    await Promise.resolve(removeCachedWorkspaceKeyBlob(
      workspace.workspaceServiceNpub || workspace.workspaceOwnerNpub,
    )).catch(() => null);

    if (removedCurrent) {
      this.stopBackgroundSync?.();
      this.stopWorkspaceLiveQueries?.();
      clearActiveWorkspaceKey();
      this.selectedWorkspaceKey = '';
      this.currentWorkspaceOwnerNpub = '';
      this.ownerNpub = '';
      this.workspaceSwitchPendingKey = '';
      this.workspaceSwitchPendingNpub = '';
      await clearRuntimeData().catch(() => {});

      if (options.selectFallback !== false) {
        for (const candidate of [...this.knownWorkspaces]) {
          if (!candidate?.pgBackendMode || this.isPgWorkspaceForgottenThisLoad(candidate)) continue;
          try {
            const verified = await this.ensurePgWorkspaceAvailable(candidate);
            if (!verified) continue;
            await this.selectWorkspace?.(verified.workspaceKey || verified.workspaceOwnerNpub, {
              pgVerified: true,
              refresh: false,
              openWorkspaceHome: true,
            });
            break;
          } catch {
            // A transient verification failure must not remove the candidate or
            // make it the active workspace during this fallback pass.
            flightDeckLog('debug', 'workspace', 'PG fallback verification failed without removing workspace', {
              workspaceId: candidate.workspaceId || null,
            });
          }
        }
      }

      if (!this.selectedWorkspaceKey) {
        if (isTowerPgBackendMode()) {
          this.showWorkspaceBootstrapModal = false;
          this.showConnectModal = Boolean(this.session?.npub);
        }
        this.prepareWorkspaceAccessGate?.();
      }
    }

    await this.persistWorkspaceSettings?.();
    return { removed: true, removedCurrent };
  },

  async registerCurrentWorkspaceApp() {
    const workspaceOwnerNpub = String(this.currentWorkspaceOwnerNpub || this.ownerNpub || '').trim();
    if (!workspaceOwnerNpub || !APP_NPUB || !this.backendUrl) return null;
    return registerWorkspaceApp(workspaceOwnerNpub, {
      app_npub: APP_NPUB,
      app_name: APP_NAME || 'Flight Deck',
    });
  },

  getWorkspaceSchemaGroupRefs() {
    const refs = [
      this.currentWorkspace?.defaultGroupId,
      this.currentWorkspace?.defaultGroupNpub,
      this.getWorkspaceSettingsGroupRef(),
      this.getWorkspaceAdminGroupRef(),
      this.memberPrivateGroupRef,
      ...(this.currentWorkspaceGroups || []).flatMap((group) => [group.group_id, group.group_npub]),
    ];
    const seen = new Set();
    return refs
      .map((ref) => String(ref || '').trim())
      .filter((ref) => {
        if (!ref || seen.has(ref)) return false;
        seen.add(ref);
        return hasGroupKey(ref);
      });
  },

  async hasCurrentWorkspaceAppSchema(schemaHash) {
    const workspaceOwnerNpub = String(this.currentWorkspaceOwnerNpub || this.ownerNpub || '').trim();
    if (!workspaceOwnerNpub || !schemaHash) return false;
    const response = await fetchWorkspaceAppSchemas(workspaceOwnerNpub, {
      app_npub: APP_NPUB,
      latest: false,
    });
    return (response.schemas || []).some((schema) =>
      String(schema?.app_npub || '') === APP_NPUB
      && String(schema?.schema_hash || '') === schemaHash
    );
  },

  async publishCurrentWorkspaceAppSchema() {
    const workspaceOwnerNpub = String(this.currentWorkspaceOwnerNpub || this.ownerNpub || '').trim();
    if (!workspaceOwnerNpub || !APP_NPUB || !this.backendUrl) return null;
    if (typeof this.refreshGroups === 'function') {
      await this.refreshGroups({ force: true, minIntervalMs: 0 });
    }
    if (!this.canAdminWorkspace) return null;
    const bundle = getFlightDeckSchemaBundle();
    if (await this.hasCurrentWorkspaceAppSchema(bundle.schema_hash)) return null;
    const groupIds = this.getWorkspaceSchemaGroupRefs();
    if (groupIds.length === 0) return null;
    const body = await buildAppSchemaManifestRequest({
      owner_npub: workspaceOwnerNpub,
      group_ids: groupIds,
    });
    return publishWorkspaceAppSchema(workspaceOwnerNpub, APP_NPUB, body);
  },

  async removeWorkspace(workspaceKeyOrOwner) {
    if (!workspaceKeyOrOwner || this.removingWorkspace) return;
    const workspace = this.getWorkspaceByKey(workspaceKeyOrOwner) || this.getWorkspaceByOwner(workspaceKeyOrOwner);
    if (!workspace) return;
    const label = workspace?.name || workspace.workspaceOwnerNpub;
    const deletesFromTower = Boolean(workspace.pgBackendMode && workspace.workspaceId && this.canAdminWorkspace);
    const confirmationMessage = deletesFromTower
      ? `Permanently delete workspace "${label}"?\n\nThis deletes the workspace and its contents from Tower, publishes a Nostr removal marker, and clears this browser's cached copy. This cannot be undone.`
      : `Remove workspace "${label}" from this browser?\n\nThis deletes the local cached copy only. The workspace remains on Tower and can be re-added later.`;
    if (!confirm(confirmationMessage)) {
      return;
    }

    this.removingWorkspace = true;
    this.stopBackgroundSync();

    const isCurrentWorkspace = this.currentWorkspaceKey === workspace.workspaceKey;
    if (isCurrentWorkspace) this.stopWorkspaceLiveQueries();

    if (deletesFromTower) {
      let revocationRecipients = [...new Set((this.pgWorkspaceMembers || [])
        .map((member) => String(member?.npub || '').trim())
        .filter((npub) => npub.startsWith('npub1')))];
      try {
        const deletion = await deleteTowerPgWorkspace(this, workspace.workspaceId, {
          confirmation: workspace.workspaceId,
        }, {
          baseUrl: workspace.directHttpsUrl || this.backendUrl,
          appNpub: workspace.appNpub || FLIGHT_DECK_PG_APP_NPUB,
        });
        revocationRecipients = [...new Set([
          ...revocationRecipients,
          ...(Array.isArray(deletion?.revoked_member_npubs) ? deletion.revoked_member_npubs : []),
        ].map((npub) => String(npub || '').trim()).filter((npub) => npub.startsWith('npub1')))];
      } catch (error) {
        this.removingWorkspace = false;
        this.ensureBackgroundSync();
        alert(`Tower did not delete "${label}": ${error?.message || error}`);
        return;
      }

      if (typeof this.publishPgWorkspaceSelfIndexTombstone === 'function') {
        await this.publishPgWorkspaceSelfIndexTombstone(workspace, {
          towerResult: 'workspace_deleted',
          reason: 'workspace_deleted',
        }).catch(() => null);
      }
      if (typeof this.publishPgOnboardingAnnouncementRevocation === 'function') {
        await Promise.all(revocationRecipients.map((recipientNpub) => (
          this.publishPgOnboardingAnnouncementRevocation({
            recipientNpub,
            workspace,
            grantId: `${workspace.workspaceId}:workspace:${recipientNpub}`,
            reason: 'workspace_deleted',
            action: 'deleted',
          })
        )));
      }
    } else if (workspace.pgBackendMode) {
      this.rememberPgWorkspaceForgottenThisLoad(workspace, { reason: 'local_forget' });
    }

    // Remove from known workspaces list
    this.knownWorkspaces = this.knownWorkspaces.filter((w) => w.workspaceKey !== workspace.workspaceKey);

    // Delete the local IndexedDB for this workspace
    try {
      await deleteWorkspaceDb(workspace.workspaceKey || workspace.workspaceOwnerNpub);
    } catch (error) {
      console.warn('Failed to delete workspace database:', error?.message || error);
    }

    if (isCurrentWorkspace) {
      // Clear runtime state
      this.chatPresentationCache?.clear?.();
      this.channels = [];
      this.messages = [];
      this.groups = [];
      this.documents = [];
      this.directories = [];
      this.tasks = [];
      this.schedules = [];
      this.audioNotes = [];
      this.taskComments = [];
      this.showNewScheduleModal = false;
      this.hasForcedInitialBackfill = false;
      this.hasForcedTaskFamilyBackfill = false;
      this.selectedWorkspaceKey = '';
      this.currentWorkspaceOwnerNpub = '';

      if (this.knownWorkspaces.length > 0) {
        // Switch to next available workspace and land on home
        await this.selectWorkspace(this.knownWorkspaces[0].workspaceKey || this.knownWorkspaces[0].workspaceOwnerNpub);
        await this.persistWorkspaceSettings();
        this.navigateTo('status');
        this.ensureBackgroundSync(true);
      } else {
        // No workspaces left — go back to workspace creation (Connect in PG mode)
        this.ownerNpub = '';
        if (isTowerPgBackendMode()) {
          this.showWorkspaceBootstrapModal = false;
          this.showConnectModal = true;
        } else {
          this.showWorkspaceBootstrapModal = true;
        }
        this.navigateTo('status');
        await this.persistWorkspaceSettings();
      }
    } else {
      await this.persistWorkspaceSettings();
      this.ensureBackgroundSync();
    }

    this.removingWorkspace = false;
  },

  async clearUnavailablePgWorkspaces() {
    if (this.appManagementCleanupBusy) return null;
    this.appManagementCleanupMessage = '';
    this.appManagementCleanupError = '';
    if (!isTowerPgBackendMode()) {
      this.appManagementCleanupError = 'Unavailable workspace cleanup only applies to Flight Deck PG workspaces.';
      return null;
    }
    const sessionNpub = String(this.session?.npub || '').trim();
    if (!sessionNpub) {
      this.appManagementCleanupError = 'Sign in first.';
      return null;
    }
    const candidates = (this.knownWorkspaces || []).filter((workspace) =>
      workspace?.pgBackendMode
      && (!workspace.pgSessionNpub || workspace.pgSessionNpub === sessionNpub)
    );
    if (candidates.length === 0) {
      this.appManagementCleanupMessage = 'No Flight Deck PG workspaces to check.';
      return { checked: 0, removed: 0, kept: 0, failed: [] };
    }
    const confirmed = typeof confirm === 'function'
      ? confirm(`Check ${candidates.length} Flight Deck PG workspace${candidates.length === 1 ? '' : 's'} and remove any that Tower no longer verifies?\n\nThis removes local workspace entries and publishes deletion markers for workspace discovery. Tower data is not changed.`)
      : true;
    if (!confirmed) return null;

    this.appManagementCleanupBusy = true;
    const summary = { checked: 0, removed: 0, kept: 0, failed: [] };
    const removedKeys = new Set();
    let removedCurrentWorkspace = false;
    try {
      for (const workspace of candidates) {
        summary.checked += 1;
        const descriptorInput = workspace.pgDescriptor || {
          type: 'wingman_workspace_locator',
          tower_base_url: workspace.directHttpsUrl || this.backendUrl,
          identity: {
            tower_service_npub: workspace.towerServiceNpub || workspace.serviceNpub,
            workspace_service_npub: workspace.workspaceServiceNpub,
            workspace_owner_npub: workspace.workspaceOwnerNpub,
            workspace_id: workspace.workspaceId,
            app_npub: workspace.appNpub || FLIGHT_DECK_PG_APP_NPUB,
          },
          label: workspace.name,
          description: workspace.description,
        };
        try {
          const { descriptor, me } = await this.verifyPgDescriptor(descriptorInput, {
            baseUrl: workspace.directHttpsUrl || this.backendUrl,
          });
          const verifiedSessionNpub = pgWorkspaceSessionNpubFromMe(me, sessionNpub);
          if (verifiedSessionNpub !== sessionNpub) {
            throw new Error('Workspace descriptor was verified by a different signer');
          }
          summary.kept += 1;
          if (typeof this.rememberVerifiedPgWorkspace === 'function') {
            await this.rememberVerifiedPgWorkspace(descriptor, me, {
              select: false,
              publishSelfIndex: false,
            });
          }
        } catch (error) {
          const workspaceKey = workspace.workspaceKey || workspace.workspaceOwnerNpub || '';
          if (!isDefinitiveMissingPgWorkspaceError(error)) {
            summary.failed.push({
              workspaceKey,
              name: workspace.name || workspace.workspaceOwnerNpub || workspace.workspaceId || 'Workspace',
              error: error?.message || String(error || 'Tower verification failed'),
            });
            continue;
          }
          summary.removed += 1;
          if (workspaceKey) removedKeys.add(workspaceKey);
          const removal = await this.forgetMissingPgWorkspace(workspace, {
            error,
            towerResult: 'workspace_not_found',
            reason: 'app_management_cleanup',
            selectFallback: false,
          });
          removedCurrentWorkspace = removedCurrentWorkspace || Boolean(removal?.removedCurrent);
        }
      }

      if (removedKeys.size > 0) {
        const currentWasRemoved = removedCurrentWorkspace
          || removedKeys.has(this.currentWorkspaceKey)
          || removedKeys.has(this.selectedWorkspaceKey)
          || removedKeys.has(this.currentWorkspaceOwnerNpub);
        this.knownWorkspaces = (this.knownWorkspaces || []).filter((workspace) =>
          !removedKeys.has(workspace.workspaceKey || workspace.workspaceOwnerNpub || '')
        );
        if (currentWasRemoved) {
          this.stopBackgroundSync?.();
          this.stopWorkspaceLiveQueries?.();
          this.selectedWorkspaceKey = '';
          this.currentWorkspaceOwnerNpub = '';
          this.ownerNpub = '';
          if (this.knownWorkspaces.length > 0) {
            for (const nextWorkspace of [...this.knownWorkspaces]) {
              try {
                const verified = await this.ensurePgWorkspaceAvailable(nextWorkspace);
                if (!verified) continue;
                await this.selectWorkspace?.(verified.workspaceKey || verified.workspaceOwnerNpub, {
                  refresh: false,
                  pgVerified: true,
                });
                break;
              } catch (error) {
                // Keep transiently unavailable workspaces remembered, but do not
                // select them as the fallback for this cleanup pass.
                flightDeckLog('debug', 'workspace', 'manual cleanup fallback verification failed without removal', {
                  workspaceId: nextWorkspace.workspaceId || null,
                  error: error?.message || String(error),
                });
              }
            }
          } else {
            await clearRuntimeData().catch(() => {});
          }
        }
        await this.persistWorkspaceSettings();
      }

      if (summary.removed > 0) {
        this.appManagementCleanupMessage = `Removed ${summary.removed} unavailable workspace${summary.removed === 1 ? '' : 's'}; ${summary.kept} still verified.`;
      } else if (summary.failed.length > 0) {
        this.appManagementCleanupMessage = `No workspaces were removed; ${summary.failed.length} check${summary.failed.length === 1 ? '' : 's'} failed without a definitive Tower 404.`;
      } else {
        this.appManagementCleanupMessage = `All ${summary.kept} workspace${summary.kept === 1 ? '' : 's'} verified.`;
      }
      return summary;
    } catch (error) {
      this.appManagementCleanupError = error?.message || String(error || 'Workspace cleanup failed');
      return summary;
    } finally {
      this.appManagementCleanupBusy = false;
    }
  },

  prepareWorkspaceAccessGate(workspaces = null) {
    if (!isTowerPgBackendMode()) return false;
    if (!this.session?.npub) return false;
    if (this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub) return false;

    const source = Array.isArray(workspaces) && workspaces.length > 0 ? workspaces : this.knownWorkspaces;
    const seen = new Set();
    const candidates = source
      .filter((workspace) => workspace?.workspaceKey || workspace?.workspaceOwnerNpub)
      .filter((workspace) => {
        const key = workspace.workspaceKey || workspace.workspaceOwnerNpub;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (candidates.length === 0) return false;

    this.workspaceAccessGateWorkspaces = candidates;
    this.workspaceAccessGateStep = 'review';
    this.workspaceAccessGateProgress = {
      active: false,
      phase: 'idle',
      label: '',
      completed: 0,
      total: 4,
      error: '',
    };
    this.workspaceAccessGateBusy = false;
    this.showWorkspaceAccessGate = true;
    this.showConnectModal = false;
    this.showWorkspaceBootstrapModal = false;
    return true;
  },

  workspaceAccessGateProgressPercent() {
    const progress = this.workspaceAccessGateProgress || {};
    const total = Number(progress.total) || 0;
    if (!total) return progress.active ? 8 : 0;
    return Math.max(progress.active ? 8 : 0, Math.min(100, Math.round(((Number(progress.completed) || 0) / total) * 100)));
  },

  setWorkspaceAccessGateProgress(label, completed, phase = 'loading') {
    const current = this.workspaceAccessGateProgress || {};
    this.workspaceAccessGateProgress = {
      active: true,
      phase,
      label,
      completed,
      total: current.total || 4,
      error: '',
    };
  },

  async continueWorkspaceAccessGate() {
    if (this.workspaceAccessGateBusy) return;
    const target = (this.workspaceAccessGateWorkspaces || [])[0];
    if (!target) {
      this.showWorkspaceAccessGate = false;
      return;
    }

    this.workspaceAccessGateBusy = true;
    this.workspaceAccessGateStep = 'loading';
    this.setWorkspaceAccessGateProgress('Verifying workspace access...', 1);

    try {
      await this.selectWorkspace(target.workspaceKey || target.workspaceOwnerNpub, {
        refresh: false,
        openWorkspaceHome: true,
      });
      this.setWorkspaceAccessGateProgress('Saving workspace selection...', 2);
      await this.persistWorkspaceSettings?.();
      this.setWorkspaceAccessGateProgress('Loading workspace data...', 3);
      await this.bootstrapSelectedWorkspace?.({ runAccessPrune: true });
      this.setWorkspaceAccessGateProgress('Opening Flight Deck...', 4, 'complete');
      this.updateWorkspaceBootstrapPrompt?.();
      this.ensureBackgroundSync?.(true);
      this.showWorkspaceAccessGate = false;
      this.workspaceAccessGateBusy = false;
    } catch (error) {
      this.workspaceAccessGateStep = 'error';
      this.workspaceAccessGateBusy = false;
      this.workspaceAccessGateProgress = {
        active: false,
        phase: 'error',
        label: 'Workspace data could not be loaded.',
        completed: 0,
        total: 4,
        error: error?.message || 'Workspace data could not be loaded.',
      };
    }
  },

  async loadRemoteWorkspaces() {
    if (!this.session?.npub || !this.backendUrl) return;
    try {
      if (isTowerPgBackendMode()) {
        const activeBackendUrl = normalizeBackendUrl(this.backendUrl);
        const hadSelection = Boolean(this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub);
        const existingKeys = new Set((this.knownWorkspaces || [])
          .map((workspace) => workspace.workspaceKey || workspace.workspaceOwnerNpub)
          .filter(Boolean));
        const result = await listTowerPgWorkspacesForSession({ baseUrl: activeBackendUrl, appNpub: FLIGHT_DECK_PG_APP_NPUB, limit: 200 });
        const workspaces = (result.workspaces || [])
          .map((entry) => {
            const workspaceInput = {
              ...entry,
              directHttpsUrl: normalizeBackendUrl(entry.tower_base_url || activeBackendUrl),
              serviceNpub: entry.identity?.tower_service_npub || null,
              towerServiceNpub: entry.identity?.tower_service_npub || null,
              workspaceServiceNpub: entry.identity?.workspace_service_npub || null,
              workspaceId: entry.identity?.workspace_id || null,
              workspaceOwnerNpub: entry.identity?.workspace_owner_npub || null,
              appNpub: entry.identity?.app_npub || FLIGHT_DECK_PG_APP_NPUB,
              pgSessionNpub: this.session.npub,
              name: entry.label,
              slug: entry.slug,
              description: entry.description,
              capabilities: entry.capabilities || [],
              pgBackendMode: true,
            };
            const avatarUrl = String(entry.avatar_url || entry.avatarUrl || '').trim();
            delete workspaceInput.avatar_url;
            delete workspaceInput.avatarUrl;
            if (avatarUrl) workspaceInput.avatarUrl = avatarUrl;
            const workspace = normalizeWorkspaceEntry(workspaceInput);
            if (workspace && !avatarUrl) delete workspace.avatarUrl;
            return workspace;
          })
          .filter(Boolean);
        for (const workspace of workspaces) {
          this.clearPgWorkspaceForgotten(workspace);
        }
        // Discovery is additive. A workspace omitted from one list response is
        // not proof that its device-local cache should be destroyed. Definitive
        // removal is handled by the verified descriptor-404/forget flow.
        this.knownWorkspaces = mergeWorkspaceEntries(this.knownWorkspaces || [], workspaces);
        await this.persistWorkspaceSettings();
        const discovered = workspaces.filter((workspace) => !existingKeys.has(workspace.workspaceKey || workspace.workspaceOwnerNpub));
        if (!hadSelection && !this.showWorkspaceAccessGate) {
          this.prepareWorkspaceAccessGate(discovered.length > 0 ? discovered : workspaces);
        }
        return workspaces;
      }
      const serviceNpub = await this.fetchBackendServiceNpub();
      const activeBackendUrl = normalizeBackendUrl(this.backendUrl);
      const result = await getWorkspaces(this.session.npub);
      const workspaces = (result.workspaces || []).map((entry) => {
        const workspaceOwnerNpub = entry.workspace_owner_npub || entry.workspaceOwnerNpub || entry.owner_npub || '';
        const existing = this.knownWorkspaces.find((item) =>
          item.workspaceOwnerNpub === workspaceOwnerNpub
          && (
            (entry.service_npub && item.serviceNpub === entry.service_npub)
            || (entry.direct_https_url && item.directHttpsUrl === entry.direct_https_url)
          )
        ) || null;
        return {
          ...entry,
          directHttpsUrl: entry.direct_https_url || entry.directHttpsUrl || existing?.directHttpsUrl || activeBackendUrl,
          serviceNpub: entry.service_npub || entry.serviceNpub || existing?.serviceNpub || serviceNpub,
          appNpub: entry.app_npub || entry.appNpub || existing?.appNpub || this.superbasedConnectionConfig?.appNpub || null,
        };
      });
      this.mergeKnownWorkspaces(workspaces);
      await this.hydrateKnownWorkspaceProfiles();
      return workspaces;
    } catch (error) {
      console.debug('loadRemoteWorkspaces failed:', error?.message || error);
    }
  },

  async tryRecoverWorkspace() {
    const ownerNpub = this.superbasedConnectionConfig?.workspaceOwnerNpub;
    const memberNpub = this.session?.npub;
    if (!ownerNpub || !memberNpub) return;
    try {
      const workspaceIdentity = createGroupIdentity();
      const wrappedNsec = await personalEncryptForNpub(memberNpub, workspaceIdentity.nsec);
      const response = await recoverWorkspace({
        workspace_owner_npub: ownerNpub,
        name: 'Recovered Workspace',
        wrapped_workspace_nsec: wrappedNsec,
        wrapped_by_npub: memberNpub,
      });
      const serviceNpub = await this.fetchBackendServiceNpub();
      const workspace = normalizeWorkspaceEntry({
        ...response,
        serviceNpub,
        appNpub: this.superbasedConnectionConfig?.appNpub || null,
        connectionToken: this.superbasedTokenInput,
      });
      this.mergeKnownWorkspaces([workspace]);
      console.debug('Workspace recovered:', ownerNpub);
    } catch (error) {
      console.debug('Workspace recovery skipped:', error?.message || error);
    }
  },

  updateWorkspaceBootstrapPrompt() {
    const shouldPrompt = Boolean(this.session?.npub) && Boolean(this.backendUrl) && !this.currentWorkspaceKey && this.knownWorkspaces.length === 0;
    if (shouldPrompt && isTowerPgBackendMode()) {
      this.showWorkspaceBootstrapModal = false;
      this.showWorkspaceSwitcherMenu = false;
      this.mobileNavOpen = false;
      this.showConnectModal = true;
      return false;
    }
    if (shouldPrompt) {
      this.showConnectModal = false;
      this.showWorkspaceSwitcherMenu = false;
      this.mobileNavOpen = false;
    }
    this.showWorkspaceBootstrapModal = shouldPrompt;
    return shouldPrompt;
  },

  async fetchBackendServiceNpub() {
    const known = this.superbasedConnectionConfig?.serviceNpub || this.currentWorkspace?.serviceNpub || null;
    if (known) return known;
    if (!this.backendUrl) return null;
    try {
      const response = await fetch(`${this.backendUrl.replace(/\/+$/, '')}/health`);
      if (!response.ok) return null;
      const payload = await response.json();
      return String(payload?.service_npub || '').trim() || null;
    } catch {
      return null;
    }
  },

  openWorkspaceBootstrapModal() {
    if (isTowerPgBackendMode()) {
      this.openConnectModal?.();
      return;
    }
    this.newWorkspaceName = '';
    this.newWorkspaceDescription = '';
    this.showConnectModal = false;
    this.showWorkspaceBootstrapModal = true;
    this.showWorkspaceSwitcherMenu = false;
    this.mobileNavOpen = false;
  },

  closeWorkspaceBootstrapModal() {
    if (this.workspaceBootstrapSubmitting) return;
    this.showWorkspaceBootstrapModal = false;
  },

  async createWorkspaceBootstrap() {
    if (isTowerPgBackendMode()) {
      this.error = 'This Flight Deck build only creates Tower PG workspaces. Use Connect to create a PG workspace from a Tower host.';
      return;
    }
    const memberNpub = this.session?.npub;
    if (!memberNpub) {
      this.error = 'Sign in first';
      return;
    }
    const name = String(this.newWorkspaceName || '').trim();
    if (!name) {
      this.error = 'Workspace name is required';
      return;
    }

    this.workspaceBootstrapSubmitting = true;
    this.error = null;
    try {
      const workspaceIdentity = createGroupIdentity();
      const defaultGroupIdentity = createGroupIdentity();
      const adminGroupIdentity = createGroupIdentity();
      const privateGroupIdentity = createGroupIdentity();
      const serviceNpub = await this.fetchBackendServiceNpub();
      const wrappedWorkspaceNsec = await personalEncryptForNpub(memberNpub, workspaceIdentity.nsec);
      const defaultGroupMemberKeys = await buildWrappedMemberKeys(defaultGroupIdentity, [memberNpub], memberNpub);
      const adminGroupMemberKeys = await buildWrappedMemberKeys(adminGroupIdentity, [memberNpub], memberNpub);
      const privateGroupMemberKeys = await buildWrappedMemberKeys(privateGroupIdentity, [memberNpub], memberNpub);

      const response = await createWorkspace({
        workspace_owner_npub: workspaceIdentity.npub,
        name,
        description: String(this.newWorkspaceDescription || '').trim(),
        wrapped_workspace_nsec: wrappedWorkspaceNsec,
        wrapped_by_npub: memberNpub,
        default_group_npub: defaultGroupIdentity.npub,
        default_group_name: `${name} Shared`,
        default_group_member_keys: defaultGroupMemberKeys,
        admin_group_npub: adminGroupIdentity.npub,
        admin_group_name: 'Workspace Admins',
        admin_group_member_keys: adminGroupMemberKeys,
        private_group_npub: privateGroupIdentity.npub,
        private_group_name: 'Private',
        private_group_member_keys: privateGroupMemberKeys,
      });

      const workspace = normalizeWorkspaceEntry({
        ...response,
        serviceNpub,
        appNpub: this.superbasedConnectionConfig?.appNpub || null,
        connectionToken: buildSuperBasedConnectionToken({
          directHttpsUrl: response.direct_https_url || this.backendUrl || guessDefaultBackendUrl(),
          serviceNpub,
          towerName: this.superbasedConnectionConfig?.towerName || null,
          towerDescription: this.superbasedConnectionConfig?.towerDescription || null,
          workspaceOwnerNpub: response.workspace_owner_npub,
          appNpub: this.superbasedConnectionConfig?.appNpub || null,
        }),
      });
      this.mergeKnownWorkspaces([workspace]);
      await this.selectWorkspace(workspace.workspaceKey || workspace.workspaceOwnerNpub);
      this.showWorkspaceBootstrapModal = false;
    } catch (error) {
      this.error = error?.message || 'Failed to create workspace';
    } finally {
      this.workspaceBootstrapSubmitting = false;
    }
  },
};
