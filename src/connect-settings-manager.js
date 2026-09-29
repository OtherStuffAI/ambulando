import { towerFetch as fetch, connectTowerBridge, getTowerTransport, getTowerTransportPreference, saveTowerTransportPreference } from './tower-transport.js';
/**
 * Connection, settings, and agent-connect methods extracted from app.js.
 *
 * The connectSettingsManagerMixin object contains methods and getters that use `this`
 * (the Alpine store) and should be spread into the store definition via applyMixins.
 */

import {
  setBaseUrl,
  createWorkspace,
  getWorkspaces,
  getTowerPgService,
  verifyPairedTowerWorkspace,
  getTowerPgWorkspaceDescriptor,
  getTowerPgWorkspaceMe,
  listTowerPgWorkspaces,
} from './api.js';
import {
  createTowerPgAdminWorkspace,
  createTowerPgScopeChannel,
  createTowerPgWorkspaceScope,
} from './tower-command-intents.js';
import {
  normalizeWorkspaceEntry,
  workspaceFromToken,
} from './workspaces.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import { isFipsUrl, normalizeBackendUrl } from './utils/state-helpers.js';
import { parseSuperBasedToken, buildSuperBasedConnectionToken } from './superbased-token.js';
import { buildAgentConnectPackage } from './agent-connect.js';
import { APP_NPUB, DEFAULT_SUPERBASED_URL, FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
import {
  parsePgWorkspaceDescriptor,
  pgWorkspaceEntryFromDescriptor,
  pgWorkspaceSessionNpubFromMe,
} from './pg-workspace-descriptor.js';
import {
  personalEncryptForNpub,
} from './auth/nostr.js';
import {
  buildWrappedMemberKeys,
  createGroupIdentity,
} from './crypto/group-keys.js';
import { normalizedAutopilotLaunchUrl } from './autopilot-agents.js';

function trimUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function trimText(value) {
  return String(value || '').trim();
}

function buildDefaultKnownHosts() {
  const defaultUrl = trimUrl(DEFAULT_SUPERBASED_URL);
  if (!defaultUrl) return [];
  return [{
    url: defaultUrl,
    label: defaultUrl,
    serviceNpub: '',
    towerName: '',
    towerDescription: '',
  }];
}

function looksLikeJsonObject(value) {
  return String(value || '').trim().startsWith('{');
}

function pgWorkspaceIdFromEntry(entry = {}) {
  return trimText(
    entry.workspaceId
    || entry.workspace_id
    || entry.identity?.workspace_id
  );
}

function pgWorkspaceLabel(entry = {}) {
  return trimText(entry.label || entry.name) || 'Untitled workspace';
}

function pgErrorMessage(error, fallback = 'Flight Deck PG connection failed') {
  return error?.message || String(error || fallback);
}

function resultWorkspaces(result) {
  return Array.isArray(result?.workspaces) ? result.workspaces : [];
}

async function listTowerPgWorkspacesForPicker({ baseUrl, appNpub, limit } = {}) {
  const attempts = [];
  let filtered;
  try {
    filtered = await listTowerPgWorkspaces({ baseUrl, appNpub, limit });
    if (filtered?.towerPgRequest) attempts.push(filtered.towerPgRequest);
  } catch (error) {
    if (error?.towerPgRequest) attempts.push(error.towerPgRequest);
    error.towerPgWorkspaceList = { attempts };
    throw error;
  }
  if (resultWorkspaces(filtered).length > 0 || !String(appNpub || '').trim()) {
    return { ...filtered, towerPgWorkspaceList: { attempts } };
  }
  try {
    const unfiltered = await listTowerPgWorkspaces({ baseUrl, appNpub: '', limit });
    if (unfiltered?.towerPgRequest) attempts.push(unfiltered.towerPgRequest);
    return { ...unfiltered, towerPgWorkspaceList: { attempts } };
  } catch (error) {
    if (error?.towerPgRequest) attempts.push(error.towerPgRequest);
    error.towerPgWorkspaceList = { attempts };
    throw error;
  }
}

function shortDiagnosticNpub(value) {
  const text = trimText(value);
  if (!text) return 'unknown signer';
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function buildConnectWorkspaceDiagnostics(store, result, mappedWorkspaces = []) {
  const attempts = Array.isArray(result?.towerPgWorkspaceList?.attempts)
    ? result.towerPgWorkspaceList.attempts
    : (result?.towerPgRequest ? [result.towerPgRequest] : []);
  return {
    screen: 'connect-modal-pg-workspace-picker',
    sessionNpub: trimText(store?.session?.npub),
    towerServiceNpub: trimText(store?.connectHostServiceNpub),
    attempts,
    responseWorkspaceCount: resultWorkspaces(result).length,
    mappedWorkspaceCount: Array.isArray(mappedWorkspaces) ? mappedWorkspaces.length : 0,
    visibleWorkspaceCount: null,
  };
}

function buildConnectWorkspaceErrorDiagnostics(store, error) {
  const attempts = Array.isArray(error?.towerPgWorkspaceList?.attempts)
    ? error.towerPgWorkspaceList.attempts
    : (error?.towerPgRequest ? [error.towerPgRequest] : []);
  return {
    screen: 'connect-modal-pg-workspace-picker',
    sessionNpub: trimText(store?.session?.npub),
    towerServiceNpub: trimText(store?.connectHostServiceNpub),
    attempts,
    responseWorkspaceCount: null,
    mappedWorkspaceCount: 0,
    visibleWorkspaceCount: null,
    error: error?.message || String(error || ''),
  };
}

const PG_WORKSPACE_BOOTSTRAP_TEMPLATES = {
  company: {
    id: 'company',
    label: 'Company',
    description: 'Shared scopes for leadership, product, customers, and growth.',
    goals: [
      { title: 'Coordinate leadership', description: 'Strategy, ideas, and decisions need a visible home.', selected: true },
      { title: 'Ship product', description: 'Roadmap, features, bugs, implementation, and releases.', selected: true },
      { title: 'Grow the business', description: 'Marketing, campaigns, partnerships, and pipeline.', selected: false },
      { title: 'Serve customers', description: 'Key accounts and support escalations.', selected: false },
    ],
    scopes: [
      {
        name: 'Leadership',
        description: 'Shared direction and executive decisions.',
        selected: true,
        channels: [
          { name: 'Strategy', selected: true },
          { name: 'Ideas', selected: true },
        ],
      },
      {
        name: 'Product',
        description: 'Product direction and delivery work.',
        selected: true,
        channels: [
          { name: 'Roadmap', selected: true },
          { name: 'Features', selected: true },
          { name: 'Bugs', selected: true },
          { name: 'Implementation', selected: true },
          { name: 'Releases', selected: true },
        ],
      },
      {
        name: 'Customer Operations',
        description: 'Customer-facing work across accounts and support.',
        selected: true,
        channels: [
          { name: 'Key accounts', selected: true },
          { name: 'Support escalations', selected: true },
        ],
      },
      {
        name: 'Growth',
        description: 'Market, partnership, and pipeline work.',
        selected: true,
        channels: [
          { name: 'Marketing', selected: true },
          { name: 'Campaigns', selected: true },
          { name: 'Partnerships', selected: true },
          { name: 'Pipeline', selected: true },
        ],
      },
    ],
  },
  personal: {
    id: 'personal',
    label: 'Personal',
    description: 'Private scopes for home, projects, learning, and planning.',
    goals: [
      { title: 'Plan the week', description: 'Keep planning, reviews, and decisions together.', selected: true },
      { title: 'Manage life admin', description: 'Home, finances, and schedule.', selected: true },
      { title: 'Move projects forward', description: 'Active projects, ideas, and reviews.', selected: false },
      { title: 'Keep learning visible', description: 'Research, reading, and experiments.', selected: false },
    ],
    scopes: [
      {
        name: 'Home',
        description: 'Personal operating context for recurring life admin.',
        selected: true,
        channels: [
          { name: 'Finances', selected: true },
          { name: 'Schedule', selected: true },
        ],
      },
      {
        name: 'Projects',
        description: 'Active personal work that needs a place to move forward.',
        selected: true,
        channels: [
          { name: 'Active projects', selected: true },
          { name: 'Ideas', selected: true },
          { name: 'Reviews', selected: true },
        ],
      },
      {
        name: 'Learning',
        description: 'Research, reading, and experiments worth keeping together.',
        selected: true,
        channels: [
          { name: 'Research', selected: true },
          { name: 'Reading', selected: true },
          { name: 'Experiments', selected: true },
        ],
      },
    ],
  },
};

function clonePgWorkspaceBootstrapTemplates() {
  return Object.values(PG_WORKSPACE_BOOTSTRAP_TEMPLATES).map((template) => ({
    ...template,
    goals: (template.goals || []).map((goal) => ({ ...goal })),
    scopes: template.scopes.map((scope) => ({
      ...scope,
      channels: scope.channels.map((channel) => ({ ...channel })),
    })),
  }));
}

function selectedPgBootstrapScopes(templates = [], templateId = '') {
  const template = templates.find((entry) => entry.id === templateId) || templates[0];
  if (!template) return [];
  return template.scopes
    .filter((scope) => scope.selected)
    .map((scope) => ({
      ...scope,
      name: trimText(scope.name),
      description: trimText(scope.description),
      channels: (scope.channels || [])
        .filter((channel) => channel.selected)
        .map((channel) => ({
          ...channel,
          name: trimText(channel.name),
          description: trimText(channel.description),
        }))
        .filter((channel) => channel.name),
    }))
    .filter((scope) => scope.name);
}

function compactContextLine(label, value) {
  const text = trimText(value);
  return text ? `${label}: ${text}` : null;
}

function buildCopyContextText(store) {
  const workspace = store.currentWorkspace || {};
  const selectedChannelId = trimText(store.pgContextSelectedChannelId || store.selectedChannelId);
  const selectedChannel = selectedChannelId
    ? (store.channels || []).find((channel) => channel?.record_id === selectedChannelId)
    : null;
  const selectedThreadId = trimText(store.pgContextSelectedThreadId || store.activeThreadId);
  const selectedThread = selectedThreadId
    ? (store.pgContextThreads || []).find((thread) => thread?.id === selectedThreadId)
    : null;
  const selectedScope = store.pgContextScope || store.selectedBoardScope || null;
  const selectedScopeId = trimText(store.pgContextScopeId || selectedScope?.record_id || '');
  const selectedScopeLabel = selectedScopeId
    ? (store.getScopeBreadcrumb?.(selectedScopeId) || selectedScope?.title || selectedScopeId)
    : (trimText(store.selectedBoardLabel) || 'Current workspace');
  const selectedChannelLabel = selectedChannel
    ? (store.getChannelLabel?.(selectedChannel) || selectedChannel.title || selectedChannel.name || selectedChannelId)
    : '';

  return [
    'Flight Deck Context',
    compactContextLine('Tower', workspace.towerName || workspace.tower_name || store.superbasedConnectionConfig?.towerName || ''),
    compactContextLine('Tower URL', workspace.directHttpsUrl || store.currentWorkspaceBackendUrl || store.backendUrl),
    compactContextLine('Workspace', workspace.name || store.currentWorkspaceName),
    compactContextLine('Workspace ID', workspace.workspaceId || workspace.workspace_id),
    compactContextLine('Workspace Key', store.currentWorkspaceKey || workspace.workspaceKey),
    compactContextLine('Workspace Owner', store.workspaceOwnerNpub || workspace.workspaceOwnerNpub),
    compactContextLine('Scope', selectedScopeLabel),
    compactContextLine('Scope ID', selectedScopeId),
    compactContextLine('Channel', selectedChannelLabel),
    compactContextLine('Channel ID', selectedChannelId),
    compactContextLine('Thread', selectedThread?.label || ''),
    compactContextLine('Thread ID', selectedThreadId),
    compactContextLine('User', store.session?.npub),
  ].filter(Boolean).join('\n');
}

const PG_SELF_INDEX_STATE_KEYS = [
  'pgSelfIndexStatus',
  'pgSelfIndexError',
  'pgSelfIndexPublishedAt',
  'pgSelfIndexFailedAt',
  'pgSelfIndexDiscoveredAt',
  'pgSelfIndexVerifiedAt',
  'pgSelfIndexStaleAt',
  'pgSelfIndexEventId',
  'pgSelfIndexLastBroadcastAt',
  'pgSelfIndexSignedEvent',
  'pgSelfIndexRelays',
];

function findExistingPgWorkspace(workspaces = [], candidate = {}) {
  return (Array.isArray(workspaces) ? workspaces : []).find((workspace) => {
    if (workspace?.workspaceKey && candidate.workspaceKey && workspace.workspaceKey === candidate.workspaceKey) return true;
    return Boolean(
      workspace?.pgBackendMode
      && candidate.pgBackendMode
      && workspace.pgSessionNpub === candidate.pgSessionNpub
      && workspace.towerServiceNpub === candidate.towerServiceNpub
      && workspace.workspaceServiceNpub === candidate.workspaceServiceNpub
      && workspace.appNpub === candidate.appNpub
    );
  }) || null;
}

function preservePgSelfIndexState(candidate = {}, existing = null) {
  if (!existing) return candidate;
  const next = { ...candidate };
  for (const key of PG_SELF_INDEX_STATE_KEYS) {
    const value = next[key];
    const isEmptyArray = Array.isArray(value) && value.length === 0;
    if ((value == null || value === '' || isEmptyArray) && existing[key] != null && existing[key] !== '') {
      next[key] = existing[key];
    }
  }
  return next;
}

function preserveSparsePgWorkspaceProfile(candidate = {}, existing = null) {
  if (!existing) return candidate;
  const next = { ...candidate };
  if (!String(next.avatarUrl || '').trim() && String(existing.avatarUrl || '').trim()) {
    next.avatarUrl = existing.avatarUrl;
  }
  return next;
}

async function fetchTowerDiscovery(url, fallbackLabel = '') {
  const cleanUrl = trimUrl(url);
  if (!cleanUrl) throw new Error('URL is required');
  const healthRes = await fetch(`${cleanUrl}/health`);
  if (!healthRes.ok) throw new Error(`Server returned ${healthRes.status}`);
  const health = await healthRes.json();
  if (health.status !== 'ok') throw new Error('Server health check failed');
  const towerName = trimText(health.tower_name);
  const towerDescription = trimText(health.tower_description);
  return {
    url: cleanUrl,
    serviceNpub: trimText(health.service_npub),
    towerName,
    towerDescription,
    label: towerName || trimText(fallbackLabel) || cleanUrl,
  };
}

// ---------------------------------------------------------------------------
// Mixin — methods and getters that use `this` (the Alpine store)
// ---------------------------------------------------------------------------

export const connectSettingsManagerMixin = {

  backendOverrideDraft: null,
  towerTransportMode: 'https',
  towerFipsEndpoint: '',
  towerTransportBusy: false,
  towerTransportError: '',

  get towerBackendMisconfigured() {
    return isFipsUrl(this.backendUrl);
  },

  get towerRecoveryUrl() {
    const url = this.currentWorkspace?.directHttpsUrl;
    try { return new URL(url).protocol === 'https:' && !isFipsUrl(url) ? url : ''; }
    catch { return ''; }
  },

  async restoreWorkspaceTower() {
    if (this.towerTransportBusy || !this.towerBackendMisconfigured || !this.towerRecoveryUrl) return;
    this.towerTransportBusy = true;
    this.towerTransportError = '';
    const workspace = this.currentWorkspace;
    const recoveryUrl = this.towerRecoveryUrl;
    try {
      // Explicit user recovery uses only the selected workspace's stored locator.
      // Do not import a connection token or change workspace/key identity.
      await this.getTowerSyncService()?.prepareTransportReload();
      if (this.currentWorkspace !== workspace || this.towerRecoveryUrl !== recoveryUrl) {
        throw new Error('Workspace changed during recovery. Try again from the selected workspace.');
      }
      this.backendUrl = recoveryUrl;
      if (isFipsUrl(this.superbasedTokenInput)) {
        this.superbasedTokenInput = isFipsUrl(workspace.connectionToken) ? '' : (workspace.connectionToken || '');
      }
      await this.persistWorkspaceSettings();
      window.location.reload();
    } catch (error) {
      this.towerTransportError = error.message || 'Unable to restore the workspace Tower.';
    } finally {
      this.towerTransportBusy = false;
    }
  },

  get towerFipsSupported() {
    const transport = globalThis.window?.fipsTransport;
    return transport?.version >= 2 && transport.available !== false && typeof transport.connect === 'function';
  },

  get towerTransportStatus() {
    if (this.towerBackendMisconfigured) return 'Unavailable: FIPS address in HTTP backend override. Restore the workspace Tower, then choose FIPS.';
    const connection = getTowerTransport(this.backendUrl);
    if (connection.mode !== 'fips') return 'Public HTTPS';
    return connection.error || `FIPS via WMapp · ${connection.endpoint}`;
  },

  loadTowerTransportSettings() {
    this.backendOverrideDraft = this.backendUrl;
    const connection = getTowerTransport(this.backendUrl);
    this.towerTransportMode = connection.mode;
    this.towerFipsEndpoint = getTowerTransportPreference(this.backendUrl).endpoint || connection.endpoint || (isFipsUrl(this.superbasedTokenInput) ? this.superbasedTokenInput.trim() : '');
    this.towerTransportError = connection.error || '';
  },

  async saveTowerTransportSettings() {
    if (this.towerTransportBusy) return;
    this.towerTransportBusy = true;
    this.towerTransportError = '';
    const logicalTower = this.backendUrl;
    const workspaceId = this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id;
    const ownerNpub = this.workspaceOwnerNpub;
    const towerServiceNpub = this.currentWorkspace?.towerServiceNpub;
    const assertCurrent = () => {
      if (this.currentWorkspace?.towerServiceNpub !== towerServiceNpub
        || this.backendUrl !== logicalTower || this.workspaceOwnerNpub !== ownerNpub
        || (this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id) !== workspaceId) {
        throw new Error('Workspace changed while pairing Tower. Try again from the selected workspace.');
      }
    };
    try {
      if (isFipsUrl(logicalTower)) throw new Error('A FIPS endpoint cannot be the HTTP backend override. Restore the workspace Tower before choosing a transport.');
      let preference = { mode: 'https' };
      if (this.towerTransportMode === 'fips') {
        if (!this.towerFipsSupported) throw new Error('FIPS requires WMapp with workspace identity pairing. Update WMapp and reload Flight Deck.');
        if (!workspaceId || !this.isTowerPgMode) throw new Error('Select a Tower PG workspace before pairing FIPS.');
        const serviceNpub = this.currentWorkspace?.towerServiceNpub;
        if (!serviceNpub) throw new Error('The selected workspace has no verified Tower service identity.');
        try {
          preference = await connectTowerBridge(logicalTower, this.towerFipsEndpoint, serviceNpub);
          assertCurrent();
          await verifyPairedTowerWorkspace(preference, workspaceId, ownerNpub);
          assertCurrent();
        } catch (error) {
          await preference.handle?.disconnect?.();
          throw error;
        }
      }
      assertCurrent();
      try {
        await saveTowerTransportPreference(logicalTower, preference);
      } catch (error) {
        if (preference.mode === 'fips') await preference.handle?.disconnect?.();
        throw error;
      }
      // Reload the same page origin. Stable backend, workspace keys, cursor and
      // durable pending writes are unchanged; the usual service owns recovery.
      await this.getTowerSyncService()?.prepareTransportReload();
      window.location.reload();
    } catch (error) {
      this.towerTransportError = error.message || 'Unable to change Tower transport.';
    } finally {
      this.towerTransportBusy = false;
    }
  },


  get isTowerPgMode() {
    return isTowerPgBackendMode();
  },

  // --- settings ---

  handleHarnessInput(value) {
    this.wingmanHarnessInput = value;
    this.wingmanHarnessError = null;
  },

  handleHarnessAgentInput(value) {
    this.wingmanHarnessAgentQuery = value;
    this.wingmanHarnessError = null;
    if (this.wingmanHarnessAgentQuery.startsWith('npub1') && this.wingmanHarnessAgentQuery.length >= 20) {
      this.resolveChatProfile(this.wingmanHarnessAgentQuery);
    }
  },

  async selectHarnessAgent(npub) {
    const nextNpub = String(npub || '').trim();
    this.wingmanHarnessDraftAgentNpub = nextNpub;
    this.wingmanHarnessAgentQuery = '';
    this.wingmanHarnessError = null;
    if (nextNpub) {
      await this.rememberPeople([nextNpub], 'autopilot-agent');
    }
  },

  clearHarnessAgent() {
    this.wingmanHarnessDraftAgentNpub = '';
    this.wingmanHarnessAgentQuery = '';
    this.wingmanHarnessError = null;
  },

  addHarnessAgent() {
    const agentNpub = String(this.wingmanHarnessDraftAgentNpub || '').trim();
    const rawUrl = String(this.wingmanHarnessInput || '').trim();
    const url = normalizedAutopilotLaunchUrl(rawUrl);
    if (!agentNpub) {
      this.wingmanHarnessError = 'Select the Wingman agent for this Autopilot URL.';
      return false;
    }
    if (!url) {
      this.wingmanHarnessError = 'Enter a valid http(s) Autopilot URL for the selected agent.';
      return false;
    }
    if ((this.workspaceHarnessAgents || []).some((entry) => String(entry?.agent_npub || '').trim() === agentNpub)) {
      this.wingmanHarnessError = 'That agent already has an Autopilot entry.';
      return false;
    }
    this.workspaceHarnessAgents = [
      ...(this.workspaceHarnessAgents || []),
      { agent_npub: agentNpub, url },
    ];
    this.wingmanHarnessDraftAgentNpub = '';
    this.wingmanHarnessAgentQuery = '';
    this.wingmanHarnessInput = '';
    this.wingmanHarnessDirty = true;
    this.wingmanHarnessError = null;
    return true;
  },

  updateHarnessAgentUrl(index, value) {
    if (!Number.isInteger(index) || index < 0 || index >= (this.workspaceHarnessAgents || []).length) return;
    this.workspaceHarnessAgents = this.workspaceHarnessAgents.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, url: String(value || '') } : entry
    ));
    this.wingmanHarnessDirty = true;
    this.wingmanHarnessError = null;
  },

  removeHarnessAgent(index) {
    if (!Number.isInteger(index) || index < 0 || index >= (this.workspaceHarnessAgents || []).length) return;
    this.workspaceHarnessAgents = this.workspaceHarnessAgents.filter((_, entryIndex) => entryIndex !== index);
    this.wingmanHarnessDirty = true;
    this.wingmanHarnessError = null;
  },

  moveHarnessAgent(index, direction) {
    const offset = direction === 'up' ? -1 : 1;
    const swapIndex = index + offset;
    if (!Number.isInteger(index) || index < 0 || swapIndex < 0 || swapIndex >= (this.workspaceHarnessAgents || []).length) return;
    const reordered = this.workspaceHarnessAgents.map((entry) => ({ ...entry }));
    [reordered[index], reordered[swapIndex]] = [reordered[swapIndex], reordered[index]];
    this.workspaceHarnessAgents = reordered;
    this.wingmanHarnessDirty = true;
    this.wingmanHarnessError = null;
  },

  isHarnessAgentUrlValid(value) {
    return Boolean(normalizedAutopilotLaunchUrl(value));
  },

  handleDefaultAgentInput(value) {
    this.defaultAgentQuery = value;
    if (this.defaultAgentQuery.startsWith('npub1') && this.defaultAgentQuery.length >= 20) {
      this.resolveChatProfile(this.defaultAgentQuery);
    }
  },

  async saveSettings() {
    setBaseUrl(this.backendUrl);
    await this.persistWorkspaceSettings();
    this.ensureBackgroundSync();
  },

  async selectDefaultAgent(npub) {
    const nextNpub = String(npub || '').trim();
    this.defaultAgentNpub = nextNpub;
    this.defaultAgentQuery = '';
    if (nextNpub) {
      await this.rememberPeople([nextNpub], 'default-agent');
    }
    await this.persistWorkspaceSettings();
  },

  async clearDefaultAgent() {
    this.defaultAgentNpub = '';
    this.defaultAgentQuery = '';
    await this.persistWorkspaceSettings();
  },

  // --- connection settings ---

  async saveConnectionSettings() {
    this.superbasedError = null;
    const token = String(this.superbasedTokenInput || '').trim();
    if (isFipsUrl(this.backendOverrideDraft ?? this.backendUrl) || isFipsUrl(token)) {
      this.superbasedError = 'A FIPS address is not a connection key or HTTP backend override. Keep the workspace Tower URL and enter the exact http:// endpoint under FIPS above.';
      return;
    }
    if (isTowerPgBackendMode()) {
      if (!token) {
        this.superbasedError = 'Flight Deck PG requires a workspace descriptor. Connect through a Tower PG host or paste a descriptor.';
        return;
      }
      if (!looksLikeJsonObject(token)) {
        this.superbasedError = 'This Flight Deck build only accepts Tower PG workspace descriptors, not legacy connection tokens.';
        return;
      }
      try {
        await this.connectWithPgDescriptor(token, { closeModal: false });
      } catch (error) {
        this.superbasedError = pgErrorMessage(error);
      }
      return;
    }
    if (this.backendOverrideDraft != null) this.backendUrl = normalizeBackendUrl(this.backendOverrideDraft);
    if (token) {
      const config = parseSuperBasedToken(token);
      if (!config.isValid || !config.directHttpsUrl) {
        this.superbasedError = 'Connection key must include a direct HTTPS URL';
        return;
      }
      this.superbasedTokenInput = token;
      this.backendUrl = normalizeBackendUrl(config.directHttpsUrl);
      this.addKnownHost({
        url: config.directHttpsUrl,
        label: config.towerName || config.directHttpsUrl,
        serviceNpub: config.serviceNpub,
        towerName: config.towerName,
        towerDescription: config.towerDescription,
      });
      const workspace = workspaceFromToken(token, { name: 'Imported workspace' });
      if (workspace) {
        this.mergeKnownWorkspaces([workspace]);
        this.selectedWorkspaceKey = workspace.workspaceKey || '';
        this.currentWorkspaceOwnerNpub = workspace.workspaceOwnerNpub;
        this.ownerNpub = workspace.workspaceOwnerNpub;
      } else {
        this.ownerNpub = config.workspaceOwnerNpub || this.session?.npub || this.ownerNpub;
      }
    } else if (this.session?.npub) {
      this.ownerNpub = this.session.npub;
    }
    if (!this.backendUrl) {
      this.superbasedError = 'Connection key or backend URL required';
      return;
    }
    localStorage.setItem('use_cvm_sync', this.useCvmSync ? 'true' : 'false');
    await this.saveSettings();
    this.showAvatarMenu = false;
    if (this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub) {
      await this.selectWorkspace(this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub);
    }
  },

  async connectToPreset(presetUrl) {
    if (isTowerPgBackendMode()) {
      return this.connectToPgHost(presetUrl, this.presetConnectHost?.label || '');
    }
    this.presetConnecting = true;
    this.superbasedError = null;
    try {
      const discovery = await fetchTowerDiscovery(presetUrl, this.presetConnectHost?.label || '');
      if (!discovery.serviceNpub) throw new Error('Invalid health response');
      this.addKnownHost(discovery);
      const token = buildSuperBasedConnectionToken({
        directHttpsUrl: discovery.url,
        serviceNpub: discovery.serviceNpub,
        towerName: discovery.towerName,
        towerDescription: discovery.towerDescription,
        appNpub: APP_NPUB,
      });
      this.superbasedTokenInput = token;
      this.backendUrl = normalizeBackendUrl(discovery.url);
      await this.saveConnectionSettings();
      await this.loadRemoteWorkspaces();
      if (this.knownWorkspaces.length === 0 && this.session?.npub) {
        await this.tryRecoverWorkspace();
      }
      if (this.knownWorkspaces.length === 0) {
        this.updateWorkspaceBootstrapPrompt();
      }
    } catch (error) {
      this.superbasedError = `Failed to connect: ${error?.message || error}`;
    } finally {
      this.presetConnecting = false;
    }
  },

  toggleCvmSync() {
    this.useCvmSync = !this.useCvmSync;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('use_cvm_sync', this.useCvmSync ? 'true' : 'false');
    }
  },

  // --- Connect modal (two-step) ---

  openConnectModal() {
    this.showWorkspaceBootstrapModal = false;
    this.showConnectModal = true;
    this.connectStep = 1;
    this.connectPgOnboardingStep = 1;
    this.connectPgSelectedScopeIndex = 0;
    this.connectPgNewScopeName = '';
    this.connectPgNewChannelName = '';
    this.connectHostUrl = '';
    this.connectHostLabel = '';
    this.connectHostServiceNpub = '';
    this.connectHostTowerName = '';
    this.connectHostTowerDescription = '';
    this.connectHostError = null;
    this.connectHostBusy = false;
    this.connectManualUrl = '';
    this.connectWorkspaces = [];
    this.connectWorkspacesBusy = false;
    this.connectWorkspacesError = null;
    this.connectNewWorkspaceName = '';
    this.connectNewWorkspaceDescription = '';
    this.connectCreatingWorkspace = false;
    this.resetConnectPgBootstrapState();
    this.connectTokenInput = '';
    this.connectShowTokenFallback = false;
    this.showWorkspaceSwitcherMenu = false;
    this.mobileNavOpen = false;
    this.refreshKnownHostsMetadata().catch(() => {});
  },

  closeConnectModal() {
    if (this.connectHostBusy || this.connectWorkspacesBusy || this.connectCreatingWorkspace) return;
    this.showConnectModal = false;
  },

  resetConnectPgBootstrapState() {
    this.connectPgOnboardingStep = 1;
    this.connectPgSelectedScopeIndex = 0;
    this.connectPgNewScopeName = '';
    this.connectPgNewChannelName = '';
    this.connectPgBootstrapTemplateId = 'company';
    this.connectPgBootstrapTemplates = clonePgWorkspaceBootstrapTemplates();
    this.connectPgBootstrapProgress = {
      active: false,
      phase: 'idle',
      label: '',
      completed: 0,
      total: 0,
      error: '',
    };
  },

  selectedConnectPgBootstrapScopes() {
    return selectedPgBootstrapScopes(this.connectPgBootstrapTemplates, this.connectPgBootstrapTemplateId);
  },

  connectPgBootstrapTemplate() {
    return this.connectPgBootstrapTemplates.find((entry) => entry.id === this.connectPgBootstrapTemplateId)
      || this.connectPgBootstrapTemplates[0]
      || null;
  },

  connectPgBootstrapGoals() {
    return this.connectPgBootstrapTemplate()?.goals || [];
  },

  connectPgSelectedScope() {
    const template = this.connectPgBootstrapTemplate();
    const scopes = template?.scopes || [];
    return scopes[this.connectPgSelectedScopeIndex] || scopes[0] || null;
  },

  connectPgSetBootstrapTemplate(templateId) {
    this.connectPgBootstrapTemplateId = templateId;
    this.connectPgSelectedScopeIndex = 0;
    this.connectPgNewScopeName = '';
    this.connectPgNewChannelName = '';
  },

  connectPgAddBootstrapScope() {
    const name = trimText(this.connectPgNewScopeName);
    if (!name) return;
    const template = this.connectPgBootstrapTemplate();
    if (!template) return;
    const existingIndex = (template.scopes || []).findIndex((scope) => trimText(scope.name).toLowerCase() === name.toLowerCase());
    if (existingIndex >= 0) {
      template.scopes[existingIndex].selected = true;
      this.connectPgSelectedScopeIndex = existingIndex;
      this.connectPgNewScopeName = '';
      return;
    }
    template.scopes.push({
      name,
      description: 'Custom scope.',
      selected: true,
      channels: [],
    });
    this.connectPgSelectedScopeIndex = template.scopes.length - 1;
    this.connectPgNewScopeName = '';
    this.connectPgNewChannelName = '';
  },

  connectPgAddBootstrapChannel() {
    const name = trimText(this.connectPgNewChannelName);
    const scope = this.connectPgSelectedScope();
    if (!name || !scope) return;
    const existing = (scope.channels || []).find((channel) => trimText(channel.name).toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.selected = true;
      this.connectPgNewChannelName = '';
      return;
    }
    if (!Array.isArray(scope.channels)) scope.channels = [];
    scope.channels.push({ name, selected: true });
    scope.selected = true;
    this.connectPgNewChannelName = '';
  },

  connectPgWizardTitle() {
    if (this.connectCreatingWorkspace) return 'Building workspace';
    const titles = {
      1: 'Connect to a Tower',
      2: 'Choose or create a workspace',
      3: 'What kind of workspace is this?',
      4: 'What should this workspace help with?',
      5: 'Choose the spaces to create',
    };
    return titles[this.connectPgOnboardingStep] || titles[2];
  },

  connectPgWizardSummary() {
    if (this.connectCreatingWorkspace) {
      return 'Flight Deck is creating the workspace, spaces, channel grants, and local materialized view.';
    }
    const counts = this.connectPgBootstrapCounts();
    if (this.connectPgOnboardingStep === 2) return 'Create a workspace first, then bootstrap spaces inside it.';
    if (this.connectPgOnboardingStep === 5) {
      return `${counts.scopes} scopes and ${counts.channels} channels selected. Create runs the Tower updates in the background.`;
    }
    return 'Private until people or groups are granted to channels.';
  },

  connectPgPrimaryLabel() {
    if (this.connectCreatingWorkspace) return 'Building...';
    if (this.connectPgOnboardingStep === 2) return 'Create workspace';
    if (this.connectPgOnboardingStep === 5) return 'Create';
    return 'Continue';
  },

  connectPgCanContinue() {
    if (this.connectCreatingWorkspace) return false;
    if (this.connectPgOnboardingStep === 2) return Boolean(trimText(this.connectNewWorkspaceName));
    if (this.connectPgOnboardingStep === 5) return this.connectPgBootstrapCounts().scopes > 0;
    return true;
  },

  connectPgNext() {
    if (this.connectPgOnboardingStep < 5) {
      this.connectPgOnboardingStep += 1;
      return;
    }
    this.connectCreateWorkspace();
  },

  connectPgBack() {
    if (this.connectCreatingWorkspace) return;
    if (this.connectPgOnboardingStep > 2) {
      this.connectPgOnboardingStep -= 1;
      return;
    }
    this.connectGoBack();
  },

  connectPgBootstrapCounts() {
    const scopes = this.selectedConnectPgBootstrapScopes();
    return {
      scopes: scopes.length,
      channels: scopes.reduce((total, scope) => total + (scope.channels || []).length, 0),
    };
  },

  updateConnectPgBootstrapProgress(patch = {}) {
    this.connectPgBootstrapProgress = {
      ...(this.connectPgBootstrapProgress || {}),
      ...patch,
    };
  },

  async createConnectPgBootstrapSpaces(workspaceId, { baseUrl, appNpub, completed: initialCompleted = 0, total: totalOverride = null } = {}) {
    const scopes = this.selectedConnectPgBootstrapScopes();
    const total = totalOverride ?? scopes.reduce((count, scope) => count + 1 + (scope.channels || []).length, 0);
    if (!workspaceId || scopes.length === 0 || total === 0) return;
    let completed = initialCompleted;
    this.updateConnectPgBootstrapProgress({
      active: true,
      phase: 'spaces',
      label: 'Creating starter spaces...',
      completed,
      total,
      error: '',
    });
    for (const scope of scopes) {
      this.updateConnectPgBootstrapProgress({
        label: `Creating scope: ${scope.name}`,
        completed,
        total,
      });
      const scopeResult = await createTowerPgWorkspaceScope(this, workspaceId, {
        name: scope.name,
        description: scope.description,
        kind: 'project',
      }, { baseUrl, appNpub });
      completed += 1;
      const scopeId = trimText(scopeResult?.scope?.id || scopeResult?.scope?.record_id || scopeResult?.id || scopeResult?.record_id);
      if (!scopeId && (scope.channels || []).length > 0) {
        throw new Error(`Tower did not return a scope id for ${scope.name}`);
      }
      this.updateConnectPgBootstrapProgress({
        completed,
        total,
      });
      for (const channel of (scope.channels || [])) {
        this.updateConnectPgBootstrapProgress({
          label: `Creating channel: ${channel.name}`,
          completed,
          total,
        });
        await createTowerPgScopeChannel(this, workspaceId, scopeId, {
          name: channel.name,
          description: channel.description || undefined,
          kind: 'channel',
        }, { baseUrl, appNpub });
        completed += 1;
        this.updateConnectPgBootstrapProgress({
          completed,
          total,
        });
      }
    }
  },

  async connectToHost(hostUrl, hostLabel) {
    if (isTowerPgBackendMode()) {
      return this.connectToPgHost(hostUrl, hostLabel);
    }
    this.connectHostError = null;
    this.connectHostBusy = true;
    try {
      const discovery = await fetchTowerDiscovery(hostUrl, hostLabel);
      this.connectHostUrl = discovery.url;
      this.connectHostLabel = discovery.label;
      this.connectHostServiceNpub = discovery.serviceNpub;
      this.connectHostTowerName = discovery.towerName;
      this.connectHostTowerDescription = discovery.towerDescription;
      this.addKnownHost(discovery);
      this.backendUrl = normalizeBackendUrl(discovery.url);
      setBaseUrl(this.backendUrl);
      const token = buildSuperBasedConnectionToken({
        directHttpsUrl: discovery.url,
        serviceNpub: discovery.serviceNpub,
        towerName: discovery.towerName,
        towerDescription: discovery.towerDescription,
        appNpub: APP_NPUB,
      });
      this.superbasedTokenInput = token;
      await this.saveSettings();
      this.connectStep = 2;
      this.connectPgOnboardingStep = 2;
      await this.loadConnectWorkspaces();
    } catch (error) {
      this.connectHostError = `Failed to connect: ${error?.message || error}`;
    } finally {
      this.connectHostBusy = false;
    }
  },

  async connectManualHost() {
    await this.connectToHost(this.connectManualUrl, '');
  },

  async connectToPgHost(hostUrl, hostLabel) {
    if (!this.session?.npub) {
      this.connectHostError = 'Sign in first';
      return;
    }
    this.connectHostError = null;
    this.connectHostBusy = true;
    try {
      const cleanUrl = trimUrl(hostUrl);
      if (!cleanUrl) throw new Error('URL is required');
      this.backendUrl = normalizeBackendUrl(cleanUrl);
      setBaseUrl(this.backendUrl);
      const result = await getTowerPgService({ baseUrl: this.backendUrl, appNpub: FLIGHT_DECK_PG_APP_NPUB });
      const service = result.service || {};
      const towerName = trimText(service.name);
      const towerDescription = trimText(service.description);
      this.connectHostUrl = this.backendUrl;
      this.connectHostLabel = towerName || trimText(hostLabel) || this.backendUrl;
      this.connectHostServiceNpub = trimText(service.service_npub);
      this.connectHostTowerName = towerName;
      this.connectHostTowerDescription = towerDescription;
      this.addKnownHost({
        url: this.backendUrl,
        label: this.connectHostLabel,
        serviceNpub: this.connectHostServiceNpub,
        towerName,
        towerDescription,
      });
      await this.saveSettings();
      this.connectStep = 2;
      this.connectPgOnboardingStep = 2;
      await this.loadConnectWorkspaces();
    } catch (error) {
      this.connectHostError = `Failed to connect: ${pgErrorMessage(error)}`;
    } finally {
      this.connectHostBusy = false;
    }
  },

  async connectByo() {
    const input = String(this.connectManualUrl || '').trim();
    if (!input) return;
    // If it looks like a URL, treat as host URL
    if (/^https?:\/\//i.test(input)) {
      return this.connectToHost(input, '');
    }
    if (isTowerPgBackendMode() && looksLikeJsonObject(input)) {
      try {
        await this.connectWithPgDescriptor(input);
      } catch (error) {
        this.connectHostError = pgErrorMessage(error);
      }
      return;
    }
    if (isTowerPgBackendMode()) {
      this.connectHostError = 'Enter a Tower URL (https://...) or paste a Flight Deck PG descriptor';
      return;
    }
    // Otherwise try to parse as a connection token
    const parsed = parseSuperBasedToken(input);
    if (parsed.isValid && parsed.directHttpsUrl) {
      this.superbasedTokenInput = input;
      await this.saveConnectionSettings();
      this.showConnectModal = false;
      return;
    }
    this.connectHostError = 'Enter a URL (https://...) or paste a connection token';
  },

  async loadConnectWorkspaces() {
    if (!this.session?.npub) {
      this.connectWorkspacesError = 'Sign in first';
      this.connectWorkspaceRequestDiagnostics = {
        screen: 'connect-modal-pg-workspace-picker',
        sessionNpub: '',
        towerServiceNpub: trimText(this.connectHostServiceNpub),
        attempts: [],
        responseWorkspaceCount: null,
        mappedWorkspaceCount: 0,
        visibleWorkspaceCount: null,
        error: 'Sign in first',
      };
      return;
    }
    this.connectWorkspacesBusy = true;
    this.connectWorkspacesError = null;
    this.connectWorkspaceRequestDiagnostics = null;
    try {
      if (isTowerPgBackendMode()) {
        const result = await listTowerPgWorkspacesForPicker({
          baseUrl: this.connectHostUrl || this.backendUrl,
          appNpub: FLIGHT_DECK_PG_APP_NPUB,
        });
        const mappedWorkspaces = (result.workspaces || []).map((entry) => ({
          ...entry,
          directHttpsUrl: normalizeBackendUrl(entry.tower_base_url || this.connectHostUrl || this.backendUrl),
          serviceNpub: entry.identity?.tower_service_npub || this.connectHostServiceNpub,
          workspaceId: entry.identity?.workspace_id,
          workspaceOwnerNpub: entry.identity?.workspace_owner_npub,
          workspaceServiceNpub: entry.identity?.workspace_service_npub,
          appNpub: entry.identity?.app_npub || FLIGHT_DECK_PG_APP_NPUB,
          name: entry.label,
          description: entry.description,
          pgBackendMode: true,
        }));
        this.connectWorkspaces = mappedWorkspaces;
        this.connectWorkspaceRequestDiagnostics = buildConnectWorkspaceDiagnostics(this, result, mappedWorkspaces);
        return;
      }
      const result = await getWorkspaces(this.session.npub);
      this.connectWorkspaces = (result.workspaces || []).map((entry) => ({
        ...entry,
        directHttpsUrl: entry.direct_https_url || entry.directHttpsUrl || this.connectHostUrl,
        serviceNpub: this.connectHostServiceNpub,
        appNpub: APP_NPUB,
      }));
    } catch (error) {
      this.connectWorkspacesError = `Failed to load workspaces: ${error?.message || error}`;
      this.connectWorkspaceRequestDiagnostics = buildConnectWorkspaceErrorDiagnostics(this, error);
      this.connectWorkspaces = [];
    } finally {
      this.connectWorkspacesBusy = false;
      if (typeof window !== 'undefined' && window.Alpine?.nextTick) {
        window.Alpine.nextTick(() => this.updateConnectWorkspaceVisibleRowCount());
      }
    }
  },

  updateConnectWorkspaceVisibleRowCount() {
    if (!this.connectWorkspaceRequestDiagnostics || typeof document === 'undefined') return;
    const rows = document.querySelectorAll('[data-testid="connect-pg-workspace-row"]');
    const count = [...rows].filter((row) => row.getClientRects().length > 0).length;
    this.connectWorkspaceRequestDiagnostics = {
      ...this.connectWorkspaceRequestDiagnostics,
      visibleWorkspaceCount: count,
    };
  },

  async connectSelectWorkspace(workspaceEntry) {
    if (isTowerPgBackendMode()) {
      return this.connectSelectPgWorkspace(workspaceEntry);
    }
    const workspace = normalizeWorkspaceEntry({
      ...workspaceEntry,
      directHttpsUrl: this.connectHostUrl,
      serviceNpub: this.connectHostServiceNpub,
      appNpub: APP_NPUB,
      connectionToken: buildSuperBasedConnectionToken({
        directHttpsUrl: this.connectHostUrl,
        serviceNpub: this.connectHostServiceNpub,
        towerName: this.connectHostTowerName,
        towerDescription: this.connectHostTowerDescription,
        workspaceOwnerNpub: workspaceEntry.workspace_owner_npub || workspaceEntry.workspaceOwnerNpub,
        appNpub: APP_NPUB,
      }),
    });
    if (!workspace) return;
    this.mergeKnownWorkspaces([workspace]);
    this.selectedWorkspaceKey = workspace.workspaceKey || '';
    this.showConnectModal = false;
    await this.selectWorkspace(workspace.workspaceKey || workspace.workspaceOwnerNpub);
  },

  async verifyPgDescriptor(descriptorInput, { baseUrl = null } = {}) {
    if (!this.session?.npub) throw new Error('Sign in first');
    const candidate = parsePgWorkspaceDescriptor(descriptorInput);
    const towerBaseUrl = normalizeBackendUrl(baseUrl || candidate.towerBaseUrl);
    const descriptor = await getTowerPgWorkspaceDescriptor(candidate.workspaceId, {
      baseUrl: towerBaseUrl,
      appNpub: candidate.appNpub || FLIGHT_DECK_PG_APP_NPUB,
      path: candidate.links.descriptor || null,
    });
    const verified = parsePgWorkspaceDescriptor({
      ...descriptor,
      tower_base_url: descriptor.tower_base_url || towerBaseUrl,
    });
    if (candidate.towerServiceNpub && verified.towerServiceNpub && candidate.towerServiceNpub !== verified.towerServiceNpub) {
      throw new Error('Workspace descriptor Tower identity mismatch');
    }
    if (candidate.workspaceServiceNpub && verified.workspaceServiceNpub !== candidate.workspaceServiceNpub) {
      throw new Error('Workspace descriptor workspace identity mismatch');
    }
    if (candidate.appNpub && verified.appNpub !== candidate.appNpub) {
      throw new Error('Workspace descriptor app identity mismatch');
    }
    const me = await getTowerPgWorkspaceMe(verified.workspaceId, {
      baseUrl: towerBaseUrl,
      appNpub: verified.appNpub || FLIGHT_DECK_PG_APP_NPUB,
      path: verified.links.me || null,
    });
    return { descriptor: verified, me };
  },

  async rememberVerifiedPgWorkspace(descriptor, me = null, options = {}) {
    const sessionNpub = pgWorkspaceSessionNpubFromMe(me, this.session?.npub || '');
    if (!sessionNpub) throw new Error('Verified workspace descriptor is missing actor identity');
    if (this.session?.npub && sessionNpub !== this.session.npub) {
      throw new Error('Workspace descriptor was verified by a different signer');
    }
    let workspace = normalizeWorkspaceEntry(pgWorkspaceEntryFromDescriptor(descriptor, {
      me,
      sessionNpub,
      verifiedAt: new Date().toISOString(),
    }));
    if (!workspace) throw new Error('Verified workspace descriptor could not be stored');
    const existingWorkspace = findExistingPgWorkspace(this.knownWorkspaces, workspace);
    workspace = preservePgSelfIndexState(workspace, existingWorkspace);
    workspace = preserveSparsePgWorkspaceProfile(workspace, existingWorkspace);
    if (options.clearLocalForget === true) this.clearPgWorkspaceForgotten?.(workspace);
    const workspaceBackendUrl = normalizeBackendUrl(workspace.directHttpsUrl || this.backendUrl);
    if (options.select !== false || !this.backendUrl) {
      this.backendUrl = workspaceBackendUrl;
      if (this.backendUrl) setBaseUrl(this.backendUrl);
    }
    this.addKnownHost({
      url: workspaceBackendUrl,
      label: workspace.towerName || workspace.directHttpsUrl || workspaceBackendUrl,
      serviceNpub: workspace.towerServiceNpub || workspace.serviceNpub,
      towerName: workspace.towerName,
      towerDescription: workspace.towerDescription,
    });
    this.mergeKnownWorkspaces([workspace]);
    if (options.select !== false) {
      this.selectedWorkspaceKey = workspace.workspaceKey || '';
      this.currentWorkspaceOwnerNpub = workspace.workspaceOwnerNpub;
      this.ownerNpub = workspace.workspaceOwnerNpub;
      this.superbasedTokenInput = '';
    }
    await this.saveSettings();
    if (options.publishSelfIndex !== false && typeof this.publishPgWorkspaceSelfIndex === 'function') {
      const shouldPublishSelfIndex = typeof this.shouldQueuePgWorkspaceSelfIndexPublish === 'function'
        ? this.shouldQueuePgWorkspaceSelfIndexPublish(workspace)
        : true;
      if (shouldPublishSelfIndex && typeof this.markPgWorkspaceSelfIndexPending === 'function') {
        workspace = await this.markPgWorkspaceSelfIndexPending(workspace) || workspace;
      }
      if (shouldPublishSelfIndex && typeof this.schedulePgWorkspaceSelfIndexPublish === 'function') {
        this.schedulePgWorkspaceSelfIndexPublish(workspace);
      } else if (shouldPublishSelfIndex) {
        Promise.resolve()
          .then(() => this.publishPgWorkspaceSelfIndex(workspace))
          .catch(() => {});
      }
    }
    return workspace;
  },

  async connectWithPgDescriptor(descriptorInput, { closeModal = true, selectWorkspaceOptions = {} } = {}) {
    const { descriptor, me } = await this.verifyPgDescriptor(descriptorInput);
    const workspace = await this.rememberVerifiedPgWorkspace(descriptor, me, { clearLocalForget: true });
    if (closeModal) this.showConnectModal = false;
    await this.selectWorkspace(workspace.workspaceKey || workspace.workspaceOwnerNpub, {
      pgVerified: true,
      ...selectWorkspaceOptions,
    });
    return workspace;
  },

  async connectSelectPgWorkspace(workspaceEntry) {
    const workspaceId = pgWorkspaceIdFromEntry(workspaceEntry);
    if (!workspaceId) return;
    this.connectWorkspacesError = null;
    this.connectWorkspacesBusy = true;
    try {
      const baseUrl = normalizeBackendUrl(workspaceEntry.directHttpsUrl || this.connectHostUrl || this.backendUrl);
      const descriptorPath = workspaceEntry.links?.descriptor || null;
      const descriptor = await getTowerPgWorkspaceDescriptor(workspaceId, {
        baseUrl,
        appNpub: workspaceEntry.appNpub || FLIGHT_DECK_PG_APP_NPUB,
        path: descriptorPath,
      });
      const { descriptor: verified, me } = await this.verifyPgDescriptor({
        ...descriptor,
        tower_base_url: descriptor.tower_base_url || baseUrl,
      }, { baseUrl });
      const workspace = await this.rememberVerifiedPgWorkspace(verified, me, { clearLocalForget: true });
      this.showConnectModal = false;
      await this.selectWorkspace(workspace.workspaceKey || workspace.workspaceOwnerNpub, { pgVerified: true });
    } catch (error) {
      this.connectWorkspacesError = `Failed to connect to ${pgWorkspaceLabel(workspaceEntry)}: ${pgErrorMessage(error)}`;
    } finally {
      this.connectWorkspacesBusy = false;
    }
  },

  async connectCreateWorkspace() {
    if (isTowerPgBackendMode()) {
      // The personal login is the creator; workspace/service signing keys are not.
      const creatorNpub = trimText(this.session?.npub);
      if (!creatorNpub) { this.connectWorkspacesError = 'Sign in first'; return; }
      const name = String(this.connectNewWorkspaceName || '').trim();
      if (!name) { this.connectWorkspacesError = 'Workspace name is required'; return; }
      const baseUrl = normalizeBackendUrl(this.connectHostUrl || this.backendUrl);
      if (!baseUrl) {
        this.connectWorkspacesError = 'Connect to a Tower PG host before creating a workspace.';
        return;
      }
      this.connectCreatingWorkspace = true;
      this.connectWorkspacesError = null;
      this.updateConnectPgBootstrapProgress({
        active: true,
        phase: 'workspace',
        label: 'Creating workspace...',
        completed: 0,
        total: 1 + this.connectPgBootstrapCounts().scopes + this.connectPgBootstrapCounts().channels,
        error: '',
      });
      try {
        const result = await createTowerPgAdminWorkspace(this, {
          creator_npub: creatorNpub,
          workspace_name: name,
          workspace_description: String(this.connectNewWorkspaceDescription || '').trim(),
          app_npub: FLIGHT_DECK_PG_APP_NPUB,
        }, { baseUrl, appNpub: FLIGHT_DECK_PG_APP_NPUB });
        if (!result?.descriptor) throw new Error('Tower did not return a workspace descriptor');
        const descriptor = parsePgWorkspaceDescriptor({
          ...result.descriptor,
          tower_base_url: result.descriptor.tower_base_url || baseUrl,
        });
        // Starter-space commands materialize their acknowledgements in Dexie.
        // Select the verified workspace first so those writes use its database
        // and TowerSyncService rather than an unopened or previous partition.
        const workspace = await this.connectWithPgDescriptor(JSON.stringify(result.descriptor), {
          closeModal: false,
          selectWorkspaceOptions: { openWorkspaceHome: true },
        });
        if (this.workspaceSelectionError) throw new Error(this.workspaceSelectionError);
        this.updateConnectPgBootstrapProgress({
          phase: 'spaces',
          label: 'Workspace created. Preparing starter spaces...',
          completed: 1,
          total: 1 + this.connectPgBootstrapCounts().scopes + this.connectPgBootstrapCounts().channels,
        });
        await this.createConnectPgBootstrapSpaces(descriptor.workspaceId, {
          baseUrl,
          appNpub: descriptor.appNpub || FLIGHT_DECK_PG_APP_NPUB,
          completed: 1,
          total: 1 + this.connectPgBootstrapCounts().scopes + this.connectPgBootstrapCounts().channels,
        });
        this.updateConnectPgBootstrapProgress({
          phase: 'verify',
          label: 'Opening workspace...',
          completed: 1 + this.connectPgBootstrapCounts().scopes + this.connectPgBootstrapCounts().channels,
          total: 1 + this.connectPgBootstrapCounts().scopes + this.connectPgBootstrapCounts().channels,
        });
        this.showConnectModal = false;
        this.connectNewWorkspaceName = '';
        this.connectNewWorkspaceDescription = '';
        this.resetConnectPgBootstrapState();
        return workspace;
      } catch (error) {
        this.connectWorkspacesError = pgErrorMessage(error, 'Failed to create Flight Deck PG workspace');
        this.updateConnectPgBootstrapProgress({
          active: true,
          phase: 'error',
          label: 'Workspace setup failed.',
          error: this.connectWorkspacesError,
        });
      } finally {
        this.connectCreatingWorkspace = false;
      }
      return;
    }
    const memberNpub = this.session?.npub;
    if (!memberNpub) { this.connectWorkspacesError = 'Sign in first'; return; }
    const name = String(this.connectNewWorkspaceName || '').trim();
    if (!name) { this.connectWorkspacesError = 'Workspace name is required'; return; }
    this.connectCreatingWorkspace = true;
    this.connectWorkspacesError = null;
    try {
      const workspaceIdentity = createGroupIdentity();
      const defaultGroupIdentity = createGroupIdentity();
      const adminGroupIdentity = createGroupIdentity();
      const privateGroupIdentity = createGroupIdentity();
      const wrappedWorkspaceNsec = await personalEncryptForNpub(memberNpub, workspaceIdentity.nsec);
      const defaultGroupMemberKeys = await buildWrappedMemberKeys(defaultGroupIdentity, [memberNpub], memberNpub);
      const adminGroupMemberKeys = await buildWrappedMemberKeys(adminGroupIdentity, [memberNpub], memberNpub);
      const privateGroupMemberKeys = await buildWrappedMemberKeys(privateGroupIdentity, [memberNpub], memberNpub);
      const response = await createWorkspace({
        workspace_owner_npub: workspaceIdentity.npub, name,
        description: String(this.connectNewWorkspaceDescription || '').trim(),
        wrapped_workspace_nsec: wrappedWorkspaceNsec, wrapped_by_npub: memberNpub,
        default_group_npub: defaultGroupIdentity.npub, default_group_name: `${name} Shared`,
        default_group_member_keys: defaultGroupMemberKeys,
        admin_group_npub: adminGroupIdentity.npub, admin_group_name: 'Workspace Admins',
        admin_group_member_keys: adminGroupMemberKeys,
        private_group_npub: privateGroupIdentity.npub, private_group_name: 'Private',
        private_group_member_keys: privateGroupMemberKeys,
      });
      const workspace = normalizeWorkspaceEntry({
        ...response, serviceNpub: this.connectHostServiceNpub, appNpub: APP_NPUB,
        connectionToken: buildSuperBasedConnectionToken({
          directHttpsUrl: this.connectHostUrl,
          serviceNpub: this.connectHostServiceNpub,
          towerName: this.connectHostTowerName,
          towerDescription: this.connectHostTowerDescription,
          workspaceOwnerNpub: response.workspace_owner_npub, appNpub: APP_NPUB,
        }),
      });
      this.mergeKnownWorkspaces([workspace]);
      this.showConnectModal = false;
      await this.selectWorkspace(workspace.workspaceKey || workspace.workspaceOwnerNpub);
    } catch (error) {
      this.connectWorkspacesError = error?.message || 'Failed to create workspace';
    } finally {
      this.connectCreatingWorkspace = false;
    }
  },

  async connectWithToken() {
    const token = String(this.connectTokenInput || '').trim();
    if (!token) return;
    if (isTowerPgBackendMode()) {
      if (!looksLikeJsonObject(token)) {
        this.connectWorkspacesError = 'This Flight Deck build only accepts Tower PG workspace descriptors, not legacy connection tokens.';
        return;
      }
      try {
        await this.connectWithPgDescriptor(token);
      } catch (error) {
        this.connectWorkspacesError = pgErrorMessage(error);
      }
      return;
    }
    this.superbasedTokenInput = token;
    await this.saveConnectionSettings();
    this.showConnectModal = false;
  },

  connectGoBack() {
    this.connectStep = 1;
    this.connectPgOnboardingStep = 1;
    this.connectPgSelectedScopeIndex = 0;
    this.connectWorkspaces = [];
    this.connectWorkspacesError = null;
    this.connectWorkspaceRequestDiagnostics = null;
    this.connectNewWorkspaceName = '';
    this.connectNewWorkspaceDescription = '';
    this.resetConnectPgBootstrapState();
  },

  connectWorkspaceRequestSummary() {
    const diagnostics = this.connectWorkspaceRequestDiagnostics || null;
    const attempts = Array.isArray(diagnostics?.attempts) ? diagnostics.attempts : [];
    if (!attempts.length) return diagnostics?.error || '';
    const segments = attempts.map((attempt, index) => {
      const label = index === 0 ? 'Tower list' : 'retry';
      const filter = attempt.appNpubSent ? `app_npub=${attempt.appNpub}` : 'without app_npub';
      const status = attempt.httpStatus ? `HTTP ${attempt.httpStatus}` : 'no HTTP response';
      const count = attempt.responseShape?.workspacesCount;
      const countText = Number.isFinite(count) ? `, ${count} returned` : '';
      return `${label} ${attempt.method} ${attempt.url} (${filter}, signer ${shortDiagnosticNpub(attempt.signerNpub)}, ${attempt.transportMode || 'https'}, ${status}${countText})`;
    });
    const fetched = Number.isFinite(diagnostics.responseWorkspaceCount)
      ? `; fetched ${diagnostics.responseWorkspaceCount}`
      : '';
    const mapped = Number.isFinite(diagnostics.mappedWorkspaceCount)
      ? `; mapped ${diagnostics.mappedWorkspaceCount}`
      : '';
    const visible = Number.isFinite(diagnostics.visibleWorkspaceCount)
      ? `; visible rows ${diagnostics.visibleWorkspaceCount}`
      : '; visible rows pending';
    const error = diagnostics.error ? `; ${diagnostics.error}` : '';
    return `${segments.join('; ')}${fetched}${mapped}${visible}${error}`;
  },

  // --- known hosts ---

  addKnownHost({ url, label, serviceNpub, towerName, towerDescription }) {
    const cleanUrl = trimUrl(url);
    if (!cleanUrl) return;
    const existing = this.knownHosts.findIndex((h) => h.url === cleanUrl);
    const entry = {
      url: cleanUrl,
      label: trimText(towerName) || trimText(label) || cleanUrl,
      serviceNpub: trimText(serviceNpub),
      towerName: trimText(towerName),
      towerDescription: trimText(towerDescription),
    };
    if (existing >= 0) { this.knownHosts[existing] = entry; } else { this.knownHosts.push(entry); }
  },

  get mergedHostsList() {
    const merged = [];
    const indexByUrl = new Map();
    for (const host of [...buildDefaultKnownHosts(), ...this.knownHosts]) {
      const cleanUrl = trimUrl(host.url);
      if (!cleanUrl) continue;
      const nextHost = {
        ...host,
        url: cleanUrl,
        label: trimText(host.towerName) || trimText(host.label) || cleanUrl,
        serviceNpub: trimText(host.serviceNpub),
        towerName: trimText(host.towerName),
        towerDescription: trimText(host.towerDescription),
      };
      if (indexByUrl.has(cleanUrl)) {
        merged[indexByUrl.get(cleanUrl)] = {
          ...merged[indexByUrl.get(cleanUrl)],
          ...nextHost,
        };
        continue;
      }
      indexByUrl.set(cleanUrl, merged.length);
      merged.push(nextHost);
    }
    return merged;
  },

  get presetConnectHost() {
    const defaultUrl = trimUrl(DEFAULT_SUPERBASED_URL);
    if (defaultUrl) {
      return this.mergedHostsList.find((host) => trimUrl(host.url) === defaultUrl) || null;
    }
    return this.mergedHostsList[0] || null;
  },

  async refreshKnownHostsMetadata() {
    const hosts = this.mergedHostsList;
    let changed = false;

    for (const host of hosts) {
      try {
        const discovery = await fetchTowerDiscovery(host.url, host.label || host.url);
        const existing = this.knownHosts.find((entry) => trimUrl(entry.url) === discovery.url) || null;
        const nextEntry = {
          url: discovery.url,
          label: discovery.label,
          serviceNpub: discovery.serviceNpub,
          towerName: discovery.towerName,
          towerDescription: discovery.towerDescription,
        };
        if (
          !existing
          || existing.label !== nextEntry.label
          || existing.serviceNpub !== nextEntry.serviceNpub
          || existing.towerName !== nextEntry.towerName
          || existing.towerDescription !== nextEntry.towerDescription
        ) {
          this.addKnownHost(nextEntry);
          changed = true;
        }
      } catch {
        // Keep the last known metadata when discovery is unavailable.
      }
    }

    if (changed) {
      await this.persistWorkspaceSettings();
    }
  },

  // --- agent connect ---

  async copyId() {
    if (!this.session?.npub) return;
    try {
      await navigator.clipboard.writeText(this.session.npub);
    } catch {
      this.error = 'Failed to copy ID';
    }
    this.showAvatarMenu = false;
  },

  async copyContext() {
    try {
      await navigator.clipboard.writeText(buildCopyContextText(this));
    } catch {
      this.error = 'Failed to copy context';
    }
    this.showAvatarMenu = false;
  },

  showAgentConnect() {
    this.showAvatarMenu = false;
    this.agentConfigCopied = false;
    this.agentConnectJson = JSON.stringify(buildAgentConnectPackage({
      windowOrigin: typeof window === 'undefined' ? '' : window.location.origin,
      backendUrl: this.currentWorkspace?.directHttpsUrl || this.backendUrl || DEFAULT_SUPERBASED_URL,
      session: this.session,
      workspace: this.currentWorkspace,
    }), null, 2);
    this.showAgentConnectModal = true;
  },

  closeAgentConnect() {
    this.showAgentConnectModal = false;
  },

  async copyAgentConfig() {
    if (!this.agentConnectJson) return;
    try {
      await navigator.clipboard.writeText(this.agentConnectJson);
      this.agentConfigCopied = true;
      setTimeout(() => {
        this.agentConfigCopied = false;
      }, 2000);
    } catch {
      this.error = 'Failed to copy agent package';
    }
  },
};
