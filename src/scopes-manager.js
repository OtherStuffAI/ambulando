/**
 * Scope management methods extracted from app.js.
 *
 * Pure utility functions are exported individually for direct testing.
 * The scopesManagerMixin object contains methods that use `this` (the Alpine store)
 * and should be spread into the store definition.
 */

import {
  getScopesByOwner,
  deleteChannelRuntimeState,
  upsertScope,
  upsertTask,
  upsertDocument,
  upsertDirectory,
  upsertChannel,
  upsertFlow,
  upsertApproval,
  upsertReport,
} from './db.js';
import {
  createTowerPgScopeChannel,
  createTowerPgWorkspaceScope,
  deleteTowerPgWorkspaceScope,
  updateTowerPgWorkspaceScope,
  queueTowerPendingWrite,
  updateTowerPgDocumentMetadata,
} from './tower-command-intents.js';
import { isDmScope } from './dm-scope.js';
import { writeAgentChatConfig } from './agent-direct-chat.js';
import {
  outboundScope,
  resolveScopeChain,
  searchScopes,
  scopeBreadcrumb,
  scopeDepth,
  normalizeScopeLevel,
} from './translators/scopes.js';
import { outboundDocument, outboundDirectory } from './translators/docs.js';
import { outboundChannel } from './translators/chat.js';
import { outboundTask } from './translators/tasks.js';
import { outboundFlow } from './translators/flows.js';
import { outboundApproval } from './translators/approvals.js';
import { outboundReport } from './translators/reports.js';
import { recordFamilyHash } from './translators/chat.js';
import {
  buildScopeShares,
  buildScopeTags,
  defaultScopeGroupIds,
  deriveScopeHierarchy,
  normalizeGroupIds,
} from './scope-delivery.js';
import {
  toRaw,
  sameListBySignature,
} from './utils/state-helpers.js';
import {
  buildScopedPolicyRepairPatch,
  normalizeScopePolicyGroupIds,
  sameScopePolicyGroupIds,
  shouldRefreshScopedPolicy,
} from './scope-policy-helpers.js';
import {
  getRecordWriteFieldsForStore,
  getPreferredRecordWriteGroupForStore,
} from './preferred-write-group.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import {
  mapPgChannelToLocal,
  mapPgScopeToLocal,
  mapPgDocToLocal,
  resolveTowerPgWorkspaceContext,
} from './pg-read-hydrator.js';
import { getPgChannelScopeId } from './pg-record-context.js';
import { addPgEditLeaseToSaveBody } from './pg-edit-session.js';
import {
  SCOPE_TEMPLATES,
  getScopeTemplate,
  renderScopeTemplate,
} from './scope-templates.js';

// ---------------------------------------------------------------------------
// Pure utility functions (no `this` dependency)
// ---------------------------------------------------------------------------

export function getAvailableParents(scopes, level) {
  const targetDepth = scopeDepth(level);
  if (targetDepth <= 1) return [];
  const parentDepth = targetDepth - 1;
  return scopes.filter(s => scopeDepth(s.level) === parentDepth && s.record_state !== 'deleted');
}

export function readScopeAssignment(record = null) {
  return {
    scope_id: record?.scope_id ?? null,
    scope_l1_id: record?.scope_l1_id ?? null,
    scope_l2_id: record?.scope_l2_id ?? null,
    scope_l3_id: record?.scope_l3_id ?? null,
    scope_l4_id: record?.scope_l4_id ?? null,
    scope_l5_id: record?.scope_l5_id ?? null,
  };
}

export function sameScopeAssignment(left = null, right = null) {
  const a = readScopeAssignment(left);
  const b = readScopeAssignment(right);
  return a.scope_id === b.scope_id
    && a.scope_l1_id === b.scope_l1_id
    && a.scope_l2_id === b.scope_l2_id
    && a.scope_l3_id === b.scope_l3_id
    && a.scope_l4_id === b.scope_l4_id
    && a.scope_l5_id === b.scope_l5_id;
}

function sameNormalizedGroupIds(left = [], right = []) {
  const a = normalizeGroupIds(left);
  const b = normalizeGroupIds(right);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

const SCOPE_REPAIR_FAMILY_OPTIONS = Object.freeze([
  { id: 'tasks', label: 'Tasks' },
  { id: 'documents', label: 'Documents' },
  { id: 'directories', label: 'Folders' },
  { id: 'flows', label: 'Flows' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'channels', label: 'Channels' },
  { id: 'reports', label: 'Reports' },
]);

const PG_SCOPE_WIZARD_STEPS = Object.freeze([1, 2, 3]);
const PG_CHANNEL_CAPACITIES = new Set(['viewer', 'contributor', 'manager', 'agent']);
const PG_CHANNEL_CAPACITY_PERMISSIONS = Object.freeze({
  agent: Object.freeze([
    'channel.read',
    'channel.write',
    'task.read',
    'task.create',
    'comment.create',
    'doc.read',
    'doc.write',
    'file.read',
    'file.write',
    'audio_note.read',
    'audio_note.write',
  ]),
});

function createScopeWizardId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizePgChannelCapacity(capacity) {
  const value = String(capacity || '').trim();
  return PG_CHANNEL_CAPACITIES.has(value) ? value : 'viewer';
}

function accessLevelForPgChannelCapacity(capacity) {
  const value = normalizePgChannelCapacity(capacity);
  if (value === 'viewer') return 'view';
  if (value === 'contributor') return 'contribute';
  if (value === 'manager') return 'manage';
  return '';
}

function normalizeScopeWizardAccessRow(row = {}) {
  const principalType = String(row.principal_type || row.principalType || '').trim();
  const principalId = String(row.principal_id || row.principalId || '').trim();
  if (!['actor', 'group'].includes(principalType) || !principalId) return null;
  return {
    id: String(row.id || '').trim() || createScopeWizardId('scope-access-row'),
    principal_type: principalType,
    principal_id: principalId,
    capacity: normalizePgChannelCapacity(row.capacity || row.access_level || row.accessLevel),
  };
}

function cloneScopeWizardAccessRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeScopeWizardAccessRow)
    .filter(Boolean)
    .map((row) => ({ ...row, id: createScopeWizardId('scope-access-row') }));
}

function buildPgChannelGrantPayloads(rows = []) {
  const byPrincipal = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeScopeWizardAccessRow(row);
    if (!normalized) continue;
    byPrincipal.set(`${normalized.principal_type}:${normalized.principal_id}`, normalized);
  }
  return [...byPrincipal.values()].map((row) => {
    const accessLevel = accessLevelForPgChannelCapacity(row.capacity);
    if (accessLevel) {
      return {
        principal_type: row.principal_type,
        principal_id: row.principal_id,
        access_level: accessLevel,
      };
    }
    return {
      principal_type: row.principal_type,
      principal_id: row.principal_id,
      permissions: [...(PG_CHANNEL_CAPACITY_PERMISSIONS[row.capacity] || PG_CHANNEL_CAPACITY_PERMISSIONS.agent)],
    };
  });
}

function createScopeWizardChannelDraft(input = {}, defaultAccessRows = []) {
  const title = String(input.title || input.name || '').trim();
  return {
    id: String(input.id || '').trim() || createScopeWizardId('scope-channel'),
    name: title,
    description: String(input.description || '').trim(),
    basePrompt: String(input.basePrompt || input.base_prompt || '').trim(),
    accessPrincipalDraft: '',
    accessRows: cloneScopeWizardAccessRows(
      Array.isArray(input.accessRows) && input.accessRows.length > 0
        ? input.accessRows
        : defaultAccessRows,
    ),
  };
}

function splitChannelNames(text = '') {
  return String(text || '')
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Mixin — methods that reference `this` (the Alpine store)
// ---------------------------------------------------------------------------

export const scopesManagerMixin = {
  canManageScope(scopeOrId) {
    const scope = typeof scopeOrId === 'string' ? this.scopesMap.get(scopeOrId) : scopeOrId;
    if (!scope || scope.record_state === 'deleted' || scope.virtual || scope.system_key || scope.pg_kind === 'system' || isDmScope(scope)) return false;
    if (!isTowerPgBackendMode()) return Boolean(this.canAdminWorkspace);
    if (scope.pg_can_manage === true) return true;
    if (scope.pg_can_manage === false) return false;
    return Boolean(this.canAdminWorkspace);
  },

  get canAccessScopeSettings() {
    return Boolean(this.canAdminWorkspace || (this.isTowerPgMode && (this.scopes || []).length) || (this.scopes || []).some((scope) => this.canManageScope(scope)));
  },

  openScopeManagement() {
    this.navSection = 'settings';
    this.mobileNavOpen = false;
    this.openSettingsTab('scopes');
    this.syncRoute();
  },

  async confirmDeleteScope(scopeId) {
    if (!this.canManageScope(scopeId) || this.deletingScopeId) return;
    const scope = this.scopesMap.get(scopeId);
    if (!scope) return;
    const consequence = isTowerPgBackendMode()
      ? 'This archives the scope and all its channels, including nonempty channels. Stored content is retained in Tower. There is no restore control in Flight Deck.'
      : 'This deletes the scope. Records assigned to it are not deleted.';
    this.scopeDeleteError = '';
    this.scopeDeleteConfirmation = {
      scopeId,
      title: scope.title || 'Untitled scope',
      consequence,
    };
  },

  cancelDeleteScope() {
    if (this.deletingScopeId) return;
    this.scopeDeleteConfirmation = null;
    this.scopeDeleteError = '';
  },

  async confirmPendingScopeDelete() {
    const scopeId = this.scopeDeleteConfirmation?.scopeId;
    if (!scopeId || this.deletingScopeId) return;
    await this.deleteScope(scopeId);
  },

  get scopeTemplateOptions() {
    return SCOPE_TEMPLATES;
  },

  get selectedNewScopeTemplate() {
    return getScopeTemplate(this.newScopeTemplateId);
  },

  get newScopeTemplateFields() {
    const template = this.selectedNewScopeTemplate;
    return (template?.variables || []).filter((variable) => variable?.name && variable.name !== 'title');
  },

  get newScopeWizardSteps() {
    return PG_SCOPE_WIZARD_STEPS;
  },

  get newScopeNamedChannelDrafts() {
    return (Array.isArray(this.newScopeChannelDrafts) ? this.newScopeChannelDrafts : [])
      .filter((channel) => String(channel?.name || '').trim());
  },

  get activeNewScopeChannelDraft() {
    const channels = this.newScopeNamedChannelDrafts;
    if (channels.length === 0) return null;
    const activeId = String(this.newScopeActiveChannelDraftId || '').trim();
    return channels.find((channel) => channel.id === activeId) || channels[0];
  },

  get newScopeCanGoNext() {
    const step = Number(this.newScopeWizardStep || 1);
    if (step === 1) return Boolean(String(this.newScopeTitle || '').trim());
    if (step === 2) return this.newScopeNamedChannelDrafts.length > 0;
    return false;
  },

  get newScopeCanCreateWizard() {
    return Boolean(
      isTowerPgBackendMode()
      && String(this.newScopeTitle || '').trim()
      && this.newScopeNamedChannelDrafts.length > 0
      && !this.newScopeSubmitting
    );
  },

  get scopeWizardAccessPrincipalOptions() {
    const groupOptions = Array.isArray(this.pgChannelGrantGroupOptions)
      ? this.pgChannelGrantGroupOptions
      : (Array.isArray(this.currentWorkspaceGroups) && this.currentWorkspaceGroups.length > 0
        ? this.currentWorkspaceGroups
        : this.groups || []).map((group) => ({
          groupId: group.group_id || group.group_npub || group.id,
          label: group.name || group.title || 'Untitled group',
          subtitle: group.group_kind === 'workspace_admin'
            ? 'Workspace admin group'
            : `${(group.effective_member_npubs || group.member_npubs || []).length} effective members`,
        }));
    const actorOptions = Array.isArray(this.pgChannelGrantActorOptions)
      ? this.pgChannelGrantActorOptions
      : (this.pgWorkspaceMembers || []).map((member) => ({
        actorId: member.actor_id || member.id,
        npub: member.npub,
        label: this.getPgWorkspaceMemberLabel?.(member) || this.getSenderName?.(member.npub) || member.display_name || member.npub || member.actor_id || member.id,
      }));
    const groups = groupOptions
      .filter((group) => group?.groupId)
      .map((group) => ({
        value: `group:${group.groupId}`,
        type: 'group',
        id: group.groupId,
        label: group.label || 'Untitled group',
        subtitle: group.subtitle || '',
      }));
    const people = actorOptions
      .filter((actor) => actor?.actorId)
      .map((actor) => ({
        value: `actor:${actor.actorId}`,
        type: 'actor',
        id: actor.actorId,
        label: actor.label || actor.npub || actor.actorId,
        subtitle: actor.npub || '',
      }));
    return [
      { disabled: true, label: 'Groups' },
      ...groups,
      { disabled: true, label: 'People' },
      ...people,
    ];
  },

  get newScopeDefaultAccessAddOptions() {
    return this.getScopeWizardAccessAddOptions(this.newScopeDefaultAccessRows);
  },

  get activeNewScopeChannelAccessAddOptions() {
    return this.getScopeWizardAccessAddOptions(this.activeNewScopeChannelDraft?.accessRows || []);
  },

  get newScopeDefaultAccessDisabledReason() {
    return this.getScopeWizardAccessDisabledReason(this.newScopeDefaultAccessRows);
  },

  get activeNewScopeChannelAccessDisabledReason() {
    return this.getScopeWizardAccessDisabledReason(this.activeNewScopeChannelDraft?.accessRows || []);
  },

  buildScopeRepairProgressRows(counts = {}) {
    return SCOPE_REPAIR_FAMILY_OPTIONS.map((family) => ({
      id: family.id,
      label: family.label,
      status: 'pending',
      total: Math.max(0, Number(counts?.[family.id] || 0) || 0),
      processed: 0,
      rewritten: 0,
    }));
  },

  initializeScopeRepairProgress(counts = {}) {
    const rows = this.buildScopeRepairProgressRows(counts);
    const totalRecords = rows.reduce((sum, family) => sum + family.total, 0);
    this.scopeRepairProgress = rows;
    this.scopeRepairSession = {
      phase: 'preparing',
      startedAt: Date.now(),
      finishedAt: null,
      currentFamily: null,
      completedFamilies: 0,
      totalFamilies: rows.length,
      processedRecords: 0,
      rewrittenRecords: 0,
      totalRecords,
      error: null,
    };
    this.showScopeRepairModal = true;
  },

  syncScopeRepairSessionFromRows() {
    const rows = Array.isArray(this.scopeRepairProgress) ? this.scopeRepairProgress : [];
    const activeFamily = rows.find((family) => family.status === 'active') || null;
    const completedFamilies = rows.filter((family) => family.status === 'done').length;
    const processedRecords = rows.reduce((sum, family) => sum + (Number(family.processed || 0) || 0), 0);
    const rewrittenRecords = rows.reduce((sum, family) => sum + (Number(family.rewritten || 0) || 0), 0);
    Object.assign(this.scopeRepairSession, {
      currentFamily: activeFamily?.label || null,
      completedFamilies,
      processedRecords,
      rewrittenRecords,
    });
  },

  markScopeRepairProgress(familyId, status, updates = {}) {
    const targetId = String(familyId || '').trim();
    if (!targetId || !Array.isArray(this.scopeRepairProgress) || this.scopeRepairProgress.length === 0) return;
    this.scopeRepairProgress = this.scopeRepairProgress.map((family) => (
      family.id !== targetId
        ? family
        : {
          ...family,
          status,
          processed: updates.processed ?? family.processed ?? 0,
          rewritten: updates.rewritten ?? family.rewritten ?? 0,
        }
    ));
    this.syncScopeRepairSessionFromRows();
  },

  closeScopeRepairModal() {
    if (this.scopeRepairSession?.phase === 'preparing' || this.scopeRepairSession?.phase === 'rewriting') return;
    this.showScopeRepairModal = false;
  },

  scopeRepairProgressLabel() {
    const session = this.scopeRepairSession || {};
    if (session.phase === 'idle') return '';
    if (session.phase === 'preparing') return 'Preparing scope rewrite…';
    if (session.phase === 'rewriting') {
      return session.currentFamily
        ? `Rewriting ${session.currentFamily.toLowerCase()}…`
        : 'Rewriting scoped records…';
    }
    if (session.phase === 'done') return 'Scope rewrite complete.';
    if (session.phase === 'error') return 'Scope rewrite failed.';
    return '';
  },

  scopeRepairProgressPercent() {
    const session = this.scopeRepairSession || {};
    const totalFamilies = Math.max(0, Number(session.totalFamilies || 0) || 0);
    if (session.phase === 'done') return 100;
    if (!totalFamilies) return session.phase === 'preparing' ? 5 : 0;
    const activeFamily = (this.scopeRepairProgress || []).find((family) => family.status === 'active') || null;
    let activeFraction = 0;
    if (activeFamily) {
      const total = Math.max(0, Number(activeFamily.total || 0) || 0);
      const processed = Math.max(0, Number(activeFamily.processed || 0) || 0);
      activeFraction = total > 0 ? Math.min(processed / total, 1) : 0;
    }
    const completedFamilies = Math.max(0, Number(session.completedFamilies || 0) || 0);
    return Math.round(((completedFamilies + activeFraction) / totalFamilies) * 100);
  },

  buildInitialScopeWizardAccessRows() {
    const rows = [];
    const workspaceGroup = this.scopeWizardAccessPrincipalOptions.find((option) =>
      option?.type === 'group'
      && (
        String(option.label || '').trim().toLowerCase() === 'workspace'
        || String(option.id || '').trim().toLowerCase() === 'workspace'
      )
    );
    if (workspaceGroup?.id) {
      rows.push({
        id: createScopeWizardId('scope-access-row'),
        principal_type: 'group',
        principal_id: workspaceGroup.id,
        capacity: 'viewer',
      });
    }
    const actorId = String(
      this.currentWorkspace?.pgMe?.actor?.actor_id
      || this.currentWorkspace?.pgMe?.actor?.id
      || this.currentWorkspace?.pgMe?.actor_id
      || ''
    ).trim();
    if (actorId) {
      rows.push({
        id: createScopeWizardId('scope-access-row'),
        principal_type: 'actor',
        principal_id: actorId,
        capacity: 'manager',
      });
    }
    const fallbackGroups = normalizeGroupIds(this.newScopeAssignedGroupIds)
      .map((groupId) => this.resolveGroupId?.(groupId) || groupId)
      .filter(Boolean);
    if (rows.length === 0 && fallbackGroups[0]) {
      rows.push({
        id: createScopeWizardId('scope-access-row'),
        principal_type: 'group',
        principal_id: fallbackGroups[0],
        capacity: 'manager',
      });
    }
    return rows;
  },

  resetNewScopeWizardDraft({ keepBasics = false } = {}) {
    if (!keepBasics) {
      this.newScopeTitle = '';
      this.newScopeDescription = '';
      this.newScopeTemplateId = '';
      this.newScopeTemplateValues = {};
      this.newScopeTemplateError = '';
    }
    this.newScopeWizardStep = 1;
    this.newScopeWizardAccessLoading = false;
    this.newScopeWizardAccessError = '';
    this.newScopeDefaultAccessPrincipalDraft = '';
    this.newScopeDefaultAccessRows = this.buildInitialScopeWizardAccessRows();
    const firstChannel = createScopeWizardChannelDraft({}, this.newScopeDefaultAccessRows);
    this.newScopeChannelDrafts = [firstChannel];
    this.newScopeChannelNamesText = '';
    this.newScopeActiveChannelDraftId = firstChannel.id;
    this.newScopeActiveChannelAccessPrincipalDraft = '';
  },

  async prepareNewScopeWizardAccessOptions() {
    if (!isTowerPgBackendMode()) return;
    this.newScopeWizardAccessLoading = true;
    this.newScopeWizardAccessError = '';
    try {
      await Promise.all([
        this.refreshTowerPgWorkspaceMembers?.({ force: true, limit: 200 }) ?? Promise.resolve([]),
        this.refreshGroups?.({ force: true, minIntervalMs: 0 }) ?? Promise.resolve([]),
      ]);
      if (!Array.isArray(this.newScopeDefaultAccessRows) || this.newScopeDefaultAccessRows.length === 0) {
        this.newScopeDefaultAccessRows = this.buildInitialScopeWizardAccessRows();
      }
    } catch (error) {
      this.newScopeWizardAccessError = error?.message || 'Failed to load users and groups.';
    } finally {
      this.newScopeWizardAccessLoading = false;
    }
  },

  getScopeWizardAccessAddOptions(rows = []) {
    const selectedPrincipals = new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => this.getScopeWizardAccessPrincipalValue(row))
        .filter(Boolean)
    );
    return this.scopeWizardAccessPrincipalOptions.filter((option) =>
      !option.disabled && !selectedPrincipals.has(option.value)
    );
  },

  getScopeWizardAccessDisabledReason(rows = []) {
    if (!isTowerPgBackendMode()) return '';
    if (this.getScopeWizardAccessAddOptions(rows).length > 0) return '';
    if (this.newScopeWizardAccessLoading) return 'Loading users and groups...';
    if (this.newScopeWizardAccessError) return this.newScopeWizardAccessError;
    return 'All available users and groups already have a permission row.';
  },

  getScopeWizardAccessRowKey(row, index) {
    return row?.id || `${row?.principal_type || 'row'}:${row?.principal_id || index}:${index}`;
  },

  getScopeWizardAccessPrincipalValue(row) {
    return `${row?.principal_type || ''}:${row?.principal_id || ''}`;
  },

  getScopeWizardAccessPrincipalLabel(row) {
    const principalType = String(row?.principal_type || '').trim();
    const principalId = String(row?.principal_id || '').trim();
    if (principalType === 'group') {
      return this.getPgGroupLabel?.(principalId)
        || this.getScopeAssignedGroupLabel?.(principalId)
        || principalId;
    }
    const member = (this.pgWorkspaceMembers || []).find((entry) => entry.actor_id === principalId || entry.id === principalId);
    return member?.npub ? (this.getSenderName?.(member.npub) || member.npub) : principalId;
  },

  getScopeWizardCapacityDescription(capacity) {
    const value = String(capacity || '').trim();
    if (value === 'manager') return 'can view, post, and manage access';
    if (value === 'contributor') return 'can view and post';
    if (value === 'agent') return 'can view and create channel work as an agent';
    if (value === 'viewer') return 'can view only';
    return 'uses custom permissions';
  },

  getScopeWizardCapacityOptions() {
    if (Array.isArray(this.pgChannelGrantCapacityOptions) && this.pgChannelGrantCapacityOptions.length > 0) {
      const hasAgent = this.pgChannelGrantCapacityOptions.some((option) => option.value === 'agent');
      return hasAgent
        ? this.pgChannelGrantCapacityOptions
        : [...this.pgChannelGrantCapacityOptions, { value: 'agent', label: 'Agent' }];
    }
    return [
      { value: 'viewer', label: 'View' },
      { value: 'contributor', label: 'Contribute' },
      { value: 'manager', label: 'Manage' },
      { value: 'agent', label: 'Agent' },
    ];
  },

  setScopeWizardAccessPrincipal(rowsKey, index, value, channelId = '') {
    const [principalType, ...idParts] = String(value || '').split(':');
    const principalId = idParts.join(':');
    if (!['actor', 'group'].includes(principalType) || !principalId) return;
    const rows = rowsKey === 'channel'
      ? [...((this.newScopeChannelDrafts || []).find((channel) => channel.id === channelId)?.accessRows || [])]
      : (Array.isArray(this[rowsKey]) ? [...this[rowsKey]] : []);
    if (!rows[index]) return;
    rows[index] = {
      ...rows[index],
      principal_type: principalType,
      principal_id: principalId,
    };
    this.setScopeWizardAccessRows(rowsKey, rows, channelId);
  },

  setScopeWizardAccessCapacity(rowsKey, index, capacity, channelId = '') {
    const rows = rowsKey === 'channel'
      ? [...((this.newScopeChannelDrafts || []).find((channel) => channel.id === channelId)?.accessRows || [])]
      : (Array.isArray(this[rowsKey]) ? [...this[rowsKey]] : []);
    if (!rows[index]) return;
    rows[index] = { ...rows[index], capacity: normalizePgChannelCapacity(capacity) };
    this.setScopeWizardAccessRows(rowsKey, rows, channelId);
  },

  setScopeWizardAccessRows(rowsKey, rows, channelId = '') {
    if (rowsKey === 'channel') {
      this.newScopeChannelDrafts = (this.newScopeChannelDrafts || []).map((channel) =>
        channel.id === channelId ? { ...channel, accessRows: rows } : channel
      );
      return;
    }
    this[rowsKey] = rows;
  },

  addScopeWizardAccessRow(rowsKey, value = '', channelId = '') {
    const draftKey = rowsKey === 'channel' ? 'newScopeActiveChannelAccessPrincipalDraft' : 'newScopeDefaultAccessPrincipalDraft';
    const currentRows = rowsKey === 'channel'
      ? (this.newScopeChannelDrafts || []).find((channel) => channel.id === channelId)?.accessRows || []
      : this[rowsKey] || [];
    const requestedValue = String(value || this[draftKey] || '').trim();
    const principal = requestedValue
      ? this.getScopeWizardAccessAddOptions(currentRows).find((option) => option.value === requestedValue)
      : this.getScopeWizardAccessAddOptions(currentRows)[0];
    this[draftKey] = '';
    if (!principal) return;
    const nextRows = [
      ...(Array.isArray(currentRows) ? currentRows : []),
      {
        id: createScopeWizardId('scope-access-row'),
        principal_type: principal.type,
        principal_id: principal.id,
        capacity: 'viewer',
      },
    ];
    this.setScopeWizardAccessRows(rowsKey, nextRows, channelId);
  },

  removeScopeWizardAccessRow(rowsKey, index, channelId = '') {
    const currentRows = rowsKey === 'channel'
      ? (this.newScopeChannelDrafts || []).find((channel) => channel.id === channelId)?.accessRows || []
      : this[rowsKey] || [];
    const nextRows = (Array.isArray(currentRows) ? currentRows : [])
      .filter((_, rowIndex) => rowIndex !== index);
    this.setScopeWizardAccessRows(rowsKey, nextRows, channelId);
  },

  addNewScopeDefaultAccessRow(value = '') {
    this.addScopeWizardAccessRow('newScopeDefaultAccessRows', value);
  },

  removeNewScopeDefaultAccessRow(index) {
    this.removeScopeWizardAccessRow('newScopeDefaultAccessRows', index);
  },

  setNewScopeDefaultAccessPrincipal(index, value) {
    this.setScopeWizardAccessPrincipal('newScopeDefaultAccessRows', index, value);
  },

  setNewScopeDefaultAccessCapacity(index, capacity) {
    this.setScopeWizardAccessCapacity('newScopeDefaultAccessRows', index, capacity);
  },

  addActiveNewScopeChannelAccessRow(value = '') {
    const channel = this.activeNewScopeChannelDraft;
    if (!channel) return;
    this.addScopeWizardAccessRow('channel', value, channel.id);
  },

  removeActiveNewScopeChannelAccessRow(index) {
    const channel = this.activeNewScopeChannelDraft;
    if (!channel) return;
    this.removeScopeWizardAccessRow('channel', index, channel.id);
  },

  setActiveNewScopeChannelAccessPrincipal(index, value) {
    const channel = this.activeNewScopeChannelDraft;
    if (!channel) return;
    this.setScopeWizardAccessPrincipal('channel', index, value, channel.id);
  },

  setActiveNewScopeChannelAccessCapacity(index, capacity) {
    const channel = this.activeNewScopeChannelDraft;
    if (!channel) return;
    this.setScopeWizardAccessCapacity('channel', index, capacity, channel.id);
  },

  syncNewScopeChannelDraftsFromNames(text = '') {
    this.newScopeChannelNamesText = text;
    const names = splitChannelNames(text);
    const existingByName = new Map(
      (this.newScopeChannelDrafts || [])
        .filter((channel) => String(channel?.name || '').trim())
        .map((channel) => [String(channel.name).trim().toLowerCase(), channel])
    );
    this.newScopeChannelDrafts = names.map((name) => {
      const existing = existingByName.get(name.toLowerCase());
      return existing ? { ...existing, name } : createScopeWizardChannelDraft({ name }, this.newScopeDefaultAccessRows);
    });
    if (this.newScopeChannelDrafts.length === 0) {
      const empty = createScopeWizardChannelDraft({}, this.newScopeDefaultAccessRows);
      this.newScopeChannelDrafts = [empty];
      this.newScopeActiveChannelDraftId = empty.id;
      return;
    }
    if (!this.newScopeChannelDrafts.some((channel) => channel.id === this.newScopeActiveChannelDraftId)) {
      this.newScopeActiveChannelDraftId = this.newScopeChannelDrafts[0].id;
    }
  },

  applyRenderedTemplateToScopeWizardChannels(renderedTemplate = null) {
    const channels = Array.isArray(renderedTemplate?.channels) ? renderedTemplate.channels : [];
    if (channels.length === 0) return;
    this.newScopeChannelDrafts = channels.map((channel) => createScopeWizardChannelDraft(channel, this.newScopeDefaultAccessRows));
    this.newScopeChannelNamesText = this.newScopeChannelDrafts.map((channel) => channel.name).join('\n');
    this.newScopeActiveChannelDraftId = this.newScopeChannelDrafts[0]?.id || '';
  },

  updateActiveNewScopeChannelDraft(field, value) {
    const key = String(field || '').trim();
    const channel = this.activeNewScopeChannelDraft;
    if (!channel || !['name', 'description', 'basePrompt'].includes(key)) return;
    this.newScopeChannelDrafts = (this.newScopeChannelDrafts || []).map((candidate) =>
      candidate.id === channel.id ? { ...candidate, [key]: value } : candidate
    );
    if (key === 'name') {
      this.newScopeChannelNamesText = this.newScopeNamedChannelDrafts.map((candidate) => candidate.name).join('\n');
    }
  },

  async nextNewScopeWizardStep() {
    const step = Number(this.newScopeWizardStep || 1);
    if (step === 1) {
      const title = String(this.newScopeTitle || '').trim();
      if (!title) return;
      this.newScopeTemplateError = '';
      if (this.newScopeTemplateId) {
        try {
          const renderedTemplate = renderScopeTemplate(this.selectedNewScopeTemplate, {
            ...(this.newScopeTemplateValues || {}),
            title,
          });
          if (!String(this.newScopeDescription || '').trim() && renderedTemplate?.scope?.description) {
            this.newScopeDescription = String(renderedTemplate.scope.description || '').trim();
          }
          this.applyRenderedTemplateToScopeWizardChannels(renderedTemplate);
        } catch (error) {
          this.newScopeTemplateError = error?.message || 'Fill in the template fields before continuing.';
          return;
        }
      }
      this.newScopeWizardStep = 2;
      return;
    }
    if (step === 2) {
      if (this.newScopeNamedChannelDrafts.length === 0) return;
      this.newScopeChannelDrafts = this.newScopeNamedChannelDrafts.map((channel) => ({
        ...channel,
        accessRows: Array.isArray(channel.accessRows) && channel.accessRows.length > 0
          ? channel.accessRows
          : cloneScopeWizardAccessRows(this.newScopeDefaultAccessRows),
      }));
      this.newScopeActiveChannelDraftId = this.newScopeChannelDrafts[0]?.id || '';
      this.newScopeWizardStep = 3;
    }
  },

  previousNewScopeWizardStep() {
    const step = Number(this.newScopeWizardStep || 1);
    this.newScopeWizardStep = Math.max(1, step - 1);
  },

  // --- scope apply / refresh ---

  async applyScopes(scopes = [], options = {}) {
    const normalizedScopes = [];
    for (const scope of (Array.isArray(scopes) ? scopes : [])) {
      const normalized = this.normalizeScopeRowGroupRefs(scope);
      normalizedScopes.push(normalized);
    }
    if (!sameListBySignature(this.scopes, normalizedScopes)) {
      this.scopes = normalizedScopes;
    }
    this.scopesLoaded = true;
    if (!options.preserveNavigation && this.navSection === 'chat') {
      this.ensureSelectedChatChannelInScope?.({ syncRoute: false });
    }
  },

  async loadLocalScopes() {
    const generation = this._workspaceSelectionGeneration;
    const workspaceKey = this.currentWorkspaceKey;
    const ownerNpub = this.workspaceOwnerNpub;
    if (!ownerNpub) return [];
    const scopes = await getScopesByOwner(ownerNpub);
    if (this.currentWorkspaceKey !== workspaceKey || this._workspaceSelectionGeneration !== generation) return [];
    await this.applyScopes(scopes);
    return scopes;
  },

  async refreshScopes() {
    if (isTowerPgBackendMode()) {
      return this.requestTowerSyncFamily?.('scopes') ?? [];
    }
    return this.loadLocalScopes();
  },

  resolveScopeRecord(scopeOrId) {
    if (!scopeOrId) return null;
    if (typeof scopeOrId === 'object' && scopeOrId.record_id) return scopeOrId;
    return this.scopesMap.get(scopeOrId) || null;
  },

  getResolvedScopePolicyGroupIds(scopeOrId) {
    const scope = this.resolveScopeRecord(scopeOrId);
    return normalizeScopePolicyGroupIds(scope?.group_ids || [], (groupId) => this.resolveGroupId(groupId));
  },

  buildScopedPolicyRepairPatch(record, options = {}) {
    const scope = this.resolveScopeRecord(options.scopeId ?? record?.scope_id);
    if (!scope?.record_id) {
      return {
        scope_policy_group_ids: null,
      };
    }
    return buildScopedPolicyRepairPatch({
      record,
      previousScopeGroupIds: options.previousScopeGroupIds || [],
      nextScopeGroupIds: this.getResolvedScopePolicyGroupIds(scope),
      groups: this.groups || [],
      resolveGroupId: (groupId) => this.resolveGroupId(groupId),
      includeBoardGroupId: options.includeBoardGroupId === true,
      fallbackPolicyGroupIds: options.fallbackPolicyGroupIds || [],
    });
  },

  shouldRefreshScopedPolicy(record, scopeOrId, options = {}) {
    return shouldRefreshScopedPolicy(record, this.getResolvedScopePolicyGroupIds(scopeOrId), {
      resolveGroupId: (groupId) => this.resolveGroupId(groupId),
      allowLegacyGroupFallback: options.allowLegacyGroupFallback === true,
    });
  },

  get editingScopeHasGroupChanges() {
    const scope = this.editingScope;
    if (!scope?.record_id) return false;
    return !sameScopePolicyGroupIds(
      this.getScopeShareGroupIds(scope),
      this.editingScopeAssignedGroupIds,
      (groupId) => this.resolveGroupId(groupId),
    );
  },

  // --- scope picker / navigation ---

  get scopePickerResults() {
    return searchScopes(this.scopePickerQuery, this.scopes, this.scopesMap);
  },

  get scopePickerFlat() {
    const r = this.scopePickerResults;
    return [...(r.l1 || []), ...(r.l2 || []), ...(r.l3 || []), ...(r.l4 || []), ...(r.l5 || [])];
  },

  scopePickerFlatFor(query) {
    const r = searchScopes(query, this.scopes, this.scopesMap);
    return [...(r.l1 || []), ...(r.l2 || []), ...(r.l3 || []), ...(r.l4 || []), ...(r.l5 || [])];
  },

  getScopeBreadcrumb(scopeId) {
    return scopeBreadcrumb(scopeId, this.scopesMap);
  },

  getScopeLabel(scopeId) {
    const scope = this.scopesMap.get(scopeId);
    return scope ? scope.title : '';
  },

  getScopeForItem(item) {
    if (!item?.scope_id) return null;
    return this.scopesMap.get(item.scope_id) || null;
  },

  getScopePillLabel(item) {
    return this.getScopeForItem(item)?.title || '';
  },

  getScopePillLevel(item) {
    return this.getScopeForItem(item)?.level || '';
  },

  getScopePillTitle(item) {
    const scope = this.getScopeForItem(item);
    if (!scope) return '';
    const breadcrumb = this.getScopeBreadcrumb(scope.record_id);
    return breadcrumb || scope.title || '';
  },

  buildScopeAssignment(scopeId) {
    if (!scopeId) return readScopeAssignment(null);
    const chain = resolveScopeChain(scopeId, this.scopesMap);
    return {
      scope_id: scopeId,
      scope_l1_id: chain.scope_l1_id,
      scope_l2_id: chain.scope_l2_id,
      scope_l3_id: chain.scope_l3_id,
      scope_l4_id: chain.scope_l4_id,
      scope_l5_id: chain.scope_l5_id,
    };
  },

  getDirectoryDefaultScopeAssignment(directoryOrId = null) {
    if (!directoryOrId) return readScopeAssignment(null);
    const directory = typeof directoryOrId === 'string'
      ? this.directories.find((item) => item.record_id === directoryOrId)
      : directoryOrId;
    return readScopeAssignment(directory);
  },

  hasSameScopeAssignment(left = null, right = null) {
    return sameScopeAssignment(left, right);
  },

  resolveDocScopeTarget(target = null) {
    if (target === 'current-folder') {
      return this.currentFolder
        ? { type: 'directory', item: this.currentFolder }
        : { type: null, item: null };
    }
    if (target?.type === 'bulk-documents') {
      const ids = [...new Set((target.ids || []).filter(Boolean))];
      return ids.length > 0
        ? { type: 'bulk-documents', item: null, ids }
        : { type: null, item: null };
    }
    if (target?.type === 'document' || target?.type === 'directory') {
      return { type: target.type, item: target.item || null };
    }
    if (this.selectedDocument) return { type: 'document', item: this.selectedDocument };
    if (this.currentFolder) return { type: 'directory', item: this.currentFolder };
    if (this.selectedDirectory) return { type: 'directory', item: this.selectedDirectory };
    return { type: null, item: null };
  },

  get activeDocScopeTarget() {
    if (this.docScopeTargetType === 'document') {
      return this.documents.find((item) => item.record_id === this.docScopeTargetId) ?? this.selectedDocument ?? null;
    }
    if (this.docScopeTargetType === 'directory') {
      return this.directories.find((item) => item.record_id === this.docScopeTargetId) ?? null;
    }
    return null;
  },

  get activeDocScopeTargets() {
    if (this.docScopeTargetType !== 'bulk-documents') return [];
    const selectedIds = new Set(this.docScopeTargetIds);
    return this.documents.filter((item) => selectedIds.has(item.record_id) && item.record_state !== 'deleted');
  },

  get activeDocScopeTargetTypeLabel() {
    if (this.docScopeTargetType === 'bulk-documents') return 'Document scope';
    return this.docScopeTargetType === 'directory' ? 'Folder default scope' : 'Document scope';
  },

  get activeDocScopeTargetName() {
    if (this.docScopeTargetType === 'bulk-documents') {
      const count = this.activeDocScopeTargets.length;
      if (count === 0) return '';
      return `${count} document${count === 1 ? '' : 's'} selected`;
    }
    const target = this.activeDocScopeTarget;
    if (!target) return '';
    return target.title || (this.docScopeTargetType === 'directory' ? 'Untitled folder' : 'Untitled document');
  },

  get activeDocScopeModalSelection() {
    if (!this.docScopeModalSelectedId) return null;
    return this.scopesMap.get(this.docScopeModalSelectedId) || null;
  },

  get docScopeModalHasChanges() {
    if (this.docScopeTargetType === 'bulk-documents') {
      return this.activeDocScopeTargets.some((item) => (item.scope_id || null) !== (this.docScopeModalSelectedId || null));
    }
    return (this.docScopeModalSelectedId || null) !== (this.activeDocScopeTarget?.scope_id || null);
  },

  openDocScopeModal(target = null) {
    const resolved = this.resolveDocScopeTarget(target);
    if (!resolved.item && resolved.type !== 'bulk-documents') {
      this.error = 'Select a document or folder first';
      return;
    }
    this.closeScopePicker();
    this.docScopeTargetType = resolved.type;
    this.docScopeTargetId = resolved.item?.record_id || '';
    this.docScopeTargetIds = resolved.ids || [];
    if (resolved.type === 'bulk-documents') {
      const docs = this.documents.filter((item) => (resolved.ids || []).includes(item.record_id) && item.record_state !== 'deleted');
      const firstScopeId = docs[0]?.scope_id || null;
      this.docScopeModalSelectedId = docs.every((item) => (item.scope_id || null) === firstScopeId)
        ? firstScopeId
        : null;
    } else {
      this.docScopeModalSelectedId = resolved.item.scope_id || null;
    }
    this.docScopeModalSubmitting = false;
    this.scopePickerQuery = '';
    this.showDocScopeModal = true;
  },

  closeDocScopeModal() {
    this.showDocScopeModal = false;
    this.docScopeTargetType = '';
    this.docScopeTargetId = '';
    this.docScopeTargetIds = [];
    this.docScopeModalSelectedId = null;
    this.docScopeModalSubmitting = false;
    this.scopePickerQuery = '';
  },

  async saveDocScopeModal() {
    const target = this.activeDocScopeTarget;
    if (this.docScopeModalSubmitting) return;
    if (this.docScopeTargetType === 'bulk-documents' && this.activeDocScopeTargets.length === 0) return;
    if (this.docScopeTargetType !== 'bulk-documents' && !target) return;
    if (!this.docScopeModalSelectedId) {
      this.error = 'Documents and folders must have a scope.';
      return;
    }
    this.docScopeModalSubmitting = true;
    try {
      if (this.docScopeTargetType === 'bulk-documents') {
        if (this.selectedDocument?.record_id && this.docScopeTargetIds.includes(this.selectedDocument.record_id)) {
          await this.flushSelectedDocumentAutosaveBeforeScopeChange(this.selectedDocument);
        }
        for (const item of this.activeDocScopeTargets) {
          await this.updateDocScope(item, this.docScopeModalSelectedId, { sync: false });
        }
        await this.flushAndBackgroundSync();
      } else if (this.docScopeTargetType === 'directory') {
        await this.updateDirectoryScope(target, this.docScopeModalSelectedId);
      } else {
        const doc = await this.flushSelectedDocumentAutosaveBeforeScopeChange(target);
        await this.updateDocScope(doc, this.docScopeModalSelectedId);
      }
      this.closeDocScopeModal();
    } finally {
      this.docScopeModalSubmitting = false;
    }
  },

  openScopePicker() {
    this.scopePickerQuery = '';
    this.showScopePicker = true;
    this.showChannelScopePicker = false;
    this.showNewScopeForm = false;
  },

  closeScopePicker() {
    this.showScopePicker = false;
    this.scopePickerQuery = '';
    this.showNewScopeForm = false;
  },

  openChannelScopePicker() {
    this.scopePickerQuery = '';
    this.showChannelScopePicker = true;
    this.showScopePicker = false;
    this.showNewScopeForm = false;
  },

  closeChannelScopePicker() {
    this.showChannelScopePicker = false;
    this.scopePickerQuery = '';
    this.showNewScopeForm = false;
  },

  // --- scope assignment (task, doc, channel) ---

  async selectScopeForTask(scopeId) {
    if (!this.editingTask || !this.session?.npub || !this.isTaskDetailEditing?.()) return;
    Object.assign(this.editingTask, this.buildTaskBoardAssignment(scopeId, this.editingTask));
    this.closeScopePicker();
    this.handleEditingTaskDraftChanged?.();
  },

  async clearTaskScope() {
    if (!this.editingTask || !this.session?.npub || !this.isTaskDetailEditing?.()) return;
    Object.assign(this.editingTask, {
      scope_id: null,
      scope_l1_id: null,
      scope_l2_id: null,
      scope_l3_id: null,
      scope_l4_id: null,
      scope_l5_id: null,
    });
    this.closeScopePicker();
    this.handleEditingTaskDraftChanged?.();
  },

  async selectScopeForDoc(scopeId) {
    let doc = this.selectedDocument;
    if (!doc || !this.session?.npub) return;
    doc = await this.flushSelectedDocumentAutosaveBeforeScopeChange(doc);
    if (isTowerPgBackendMode()) {
      this.error = 'Moving PG documents between scopes is not available yet.';
      this.closeScopePicker();
      return;
    }
    await this.updateDocScope(doc, scopeId);
    this.closeScopePicker();
  },

  async flushSelectedDocumentAutosaveBeforeScopeChange(doc = null) {
    const targetId = String(doc?.record_id || this.selectedDocument?.record_id || '').trim();
    if (!targetId || this.selectedDocType !== 'document') return doc || this.selectedDocument || null;
    if (this.docAutosaveTimer) {
      clearTimeout(this.docAutosaveTimer);
      this.docAutosaveTimer = null;
    }
    const shouldSave = this.docsEditorOpen
      || this.docAutosaveState === 'pending'
      || this.docAutosaveState === 'saving';
    if (shouldSave && typeof this.saveSelectedDocItem === 'function') {
      const saved = await this.saveSelectedDocItem({ autosave: true });
      if (saved?.record_id === targetId) return saved;
    }
    return this.documents?.find((item) => item?.record_id === targetId) || this.selectedDocument || doc;
  },

  async resetOpenDocumentForContextChange(doc = null, options = {}) {
    const target = doc || this.selectedDocument;
    if (!target?.record_id || this.selectedDocType !== 'document') return null;
    const savedDoc = await this.flushSelectedDocumentAutosaveBeforeScopeChange(target);
    this.closeDocEditor?.({ syncRoute: false });
    if (options.syncRoute !== false) this.syncRoute?.();
    return savedDoc;
  },

  async moveOpenDocumentToScopeBoard(scopeId, doc = null) {
    const targetScopeId = String(scopeId || '').trim();
    if (!targetScopeId || targetScopeId === '__all__' || targetScopeId === '__recent__' || targetScopeId === '__unscoped__') return;
    if (isTowerPgBackendMode()) {
      const savedDoc = await this.flushSelectedDocumentAutosaveBeforeScopeChange(doc || this.selectedDocument);
      if (!savedDoc || savedDoc.scope_id === targetScopeId) return;
      const channel = (this.channels || []).find((entry) => entry?.record_id
        && entry.record_state !== 'deleted'
        && getPgChannelScopeId(entry) === targetScopeId) || null;
      if (!channel?.record_id) {
        this.error = 'Select or create a PG channel in this scope before moving the document.';
        return;
      }
      const metadata = savedDoc.metadata && typeof savedDoc.metadata === 'object' && !Array.isArray(savedDoc.metadata)
        ? { ...savedDoc.metadata }
        : {};
      delete metadata.thread_id;
      const pgMetadata = savedDoc.pg_metadata && typeof savedDoc.pg_metadata === 'object' && !Array.isArray(savedDoc.pg_metadata)
        ? { ...savedDoc.pg_metadata }
        : {};
      delete pgMetadata.thread_id;
      const moving = this.normalizeDocumentRowGroupRefs({
        ...savedDoc,
        ...this.buildScopeAssignment(targetScopeId),
        metadata,
        pg_metadata: pgMetadata,
        pg_channel_id: channel.record_id,
        pg_thread_id: null,
        thread_id: null,
        sync_status: 'pending',
        updated_at: new Date().toISOString(),
      });
      await upsertDocument(moving);
      this.patchDocumentLocal(moving);
      try {
        const context = resolveTowerPgWorkspaceContext(this);
        const body = addPgEditLeaseToSaveBody(this, savedDoc, 'document', {
          row_version: savedDoc.version || undefined,
          title: moving.title || 'Untitled document',
          channel_id: channel.record_id,
          storage_object_id: moving.content_storage_object_id || moving.storage_object_id,
          summary: moving.content || null,
          metadata: moving.pg_metadata || moving.metadata || {},
        });
        const result = await updateTowerPgDocumentMetadata(this, context.workspaceId, moving.record_id, body, {
          baseUrl: context.baseUrl,
          appNpub: context.appNpub,
        });
        const accepted = mapPgDocToLocal(result.doc, { workspaceOwnerNpub: context.workspaceOwnerNpub });
        const canonical = this.normalizeDocumentRowGroupRefs({
          ...accepted,
          content: moving.content,
          content_format: moving.content_format,
          content_blocks: moving.content_blocks,
          content_storage_object_id: moving.content_storage_object_id,
          content_storage_format: moving.content_storage_format,
          content_storage_content_type: moving.content_storage_content_type,
          content_size_bytes: moving.content_size_bytes,
          content_sha256_hex: moving.content_sha256_hex,
          content_storage_status: moving.content_storage_status,
          content_storage_error: moving.content_storage_error,
          references: moving.references,
        });
        await upsertDocument(canonical);
        this.patchDocumentLocal(canonical);
        this.selectedChannelId = channel.record_id;
        this.docAutosaveState = 'saved';
      } catch (error) {
        const failed = { ...moving, sync_status: 'failed', updated_at: new Date().toISOString() };
        await upsertDocument(failed);
        this.patchDocumentLocal(failed);
        this.docAutosaveState = 'error';
        this.error = error?.message || 'Failed to move PG document.';
        throw error;
      }
      return;
    }
    const targetDoc = doc || this.selectedDocument;
    if (!targetDoc || targetDoc.scope_id === targetScopeId) return;
    const savedDoc = await this.flushSelectedDocumentAutosaveBeforeScopeChange(targetDoc);
    if (!savedDoc || savedDoc.scope_id === targetScopeId) return;
    await this.updateDocScope(savedDoc, targetScopeId);
  },

  async clearDocScope() {
    const doc = this.selectedDocument;
    if (!doc || !this.session?.npub) return;
    this.error = 'Documents must have a scope.';
    this.closeScopePicker();
  },

  async updateDocScope(doc, scopeId, options = {}) {
    if (!doc || !this.session?.npub) return;
    if (isTowerPgBackendMode()) {
      this.error = 'Moving PG documents between scopes is not available yet.';
      return;
    }
    if (!scopeId) {
      this.error = 'Documents must have a scope.';
      return;
    }
    this.assertCanMutateLockManagedRecord(doc, recordFamilyHash('document'));
    await this.ensureLockManagedCheckout(doc, recordFamilyHash('document'), { intent: 'scope' });
    const scopeAssignment = this.buildScopeAssignment(scopeId);
    const previousScopeGroupIds = doc.scope_id ? this.getResolvedScopePolicyGroupIds(doc.scope_id) : [];
    const patch = scopeId
      ? this.buildScopedPolicyRepairPatch(doc, {
        scopeId,
        previousScopeGroupIds,
      })
      : {
        shares: this.getStoredDocShares(doc),
        group_ids: this.getShareGroupIds(this.getStoredDocShares(doc)),
        scope_policy_group_ids: null,
      };
    const updated = this.normalizeDocumentRowGroupRefs({
      ...doc,
      ...scopeAssignment,
      ...patch,
    });
    this.patchDocumentLocal(updated);
    await upsertDocument(updated);
    await this._pushDocScopeUpdate(updated, options);
  },

  async _pushDocScopeUpdate(doc, options = {}) {
    const ownerNpub = this.workspaceOwnerNpub;
    const nextVersion = (doc.version ?? 1) + 1;
    const updated = toRaw(this.normalizeDocumentRowGroupRefs({
      ...doc,
      version: nextVersion,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    }));
    await upsertDocument(updated);
    this.patchDocumentLocal(updated);
    const envelope = await this.buildManagedDocumentEnvelope({
      ...updated,
      group_ids: updated.group_ids,
      previous_version: doc.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: typeof this.getPreferredDocWriteGroupRef === 'function'
        ? this.getPreferredDocWriteGroupRef(updated)
        : getPreferredRecordWriteGroupForStore(this, updated),
    }, doc, { intent: 'scope' });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    if (options.sync !== false) {
      await this.flushAndBackgroundSync();
    }
  },

  async selectScopeForDirectory(scopeId) {
    const dir = this.currentFolder;
    if (!dir || !this.session?.npub) return;
    if (isTowerPgBackendMode()) {
      this.error = 'Folders are not available in Tower PG mode.';
      this.closeScopePicker();
      return;
    }
    await this.updateDirectoryScope(dir, scopeId);
    this.closeScopePicker();
  },

  async clearDirectoryScope() {
    const dir = this.currentFolder;
    if (!dir || !this.session?.npub) return;
    this.error = 'Folders must have a scope.';
    this.closeScopePicker();
  },

  async updateDirectoryScope(dir, scopeId) {
    if (!dir || !this.session?.npub) return;
    if (isTowerPgBackendMode()) {
      this.error = 'Folders are not available in Tower PG mode.';
      return;
    }
    if (!scopeId) {
      this.error = 'Folders must have a scope.';
      return;
    }
    this.assertCanMutateLockManagedRecord(dir, recordFamilyHash('directory'));
    await this.ensureLockManagedCheckout(dir, recordFamilyHash('directory'), { intent: 'scope' });
    const scopeAssignment = this.buildScopeAssignment(scopeId);
    const previousScopeGroupIds = dir.scope_id ? this.getResolvedScopePolicyGroupIds(dir.scope_id) : [];
    const patch = scopeId
      ? this.buildScopedPolicyRepairPatch(dir, {
        scopeId,
        previousScopeGroupIds,
      })
      : {
        shares: this.getStoredDocShares(dir),
        group_ids: this.getShareGroupIds(this.getStoredDocShares(dir)),
        scope_policy_group_ids: null,
      };
    const updated = toRaw(this.normalizeDirectoryRowGroupRefs({
      ...dir,
      ...scopeAssignment,
      ...patch,
      version: (dir.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    }));
    await this.queueDirectoryRecord(updated, dir);
    await this.flushAndBackgroundSync();
  },

  async selectScopeForChannel(scopeId) {
    const ch = this.selectedChannel;
    if (!ch || !this.session?.npub) return;
    if (isTowerPgBackendMode()) {
      this.error = 'Moving PG channels between scopes is not available yet.';
      this.closeChannelScopePicker();
      return;
    }
    const chain = resolveScopeChain(scopeId, this.scopesMap);
    const updated = toRaw({
      ...ch,
      scope_id: scopeId,
      scope_l1_id: chain.scope_l1_id,
      scope_l2_id: chain.scope_l2_id,
      scope_l3_id: chain.scope_l3_id,
      scope_l4_id: chain.scope_l4_id,
      scope_l5_id: chain.scope_l5_id,
    });
    await upsertChannel(updated);
    this.channels = this.channels.map(c => c.record_id === updated.record_id ? updated : c);
    this.closeChannelScopePicker();
    await this._pushChannelScopeUpdate(updated);
  },

  async clearChannelScope() {
    const ch = this.selectedChannel;
    if (!ch || !this.session?.npub) return;
    if (isTowerPgBackendMode()) {
      this.error = 'PG channels must stay attached to a scope.';
      this.closeChannelScopePicker();
      return;
    }
    const updated = toRaw({
      ...ch,
      scope_id: null,
      scope_l1_id: null,
      scope_l2_id: null,
      scope_l3_id: null,
      scope_l4_id: null,
      scope_l5_id: null,
    });
    await upsertChannel(updated);
    this.channels = this.channels.map(c => c.record_id === updated.record_id ? updated : c);
    this.closeChannelScopePicker();
    await this._pushChannelScopeUpdate(updated);
  },

  async _pushChannelScopeUpdate(ch) {
    const nextVersion = (ch.version ?? 1) + 1;
    const updated = toRaw({
      ...ch,
      version: nextVersion,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    });
    await upsertChannel(updated);
    this.channels = this.channels.map(c => c.record_id === updated.record_id ? updated : c);
    const writeFields = await getRecordWriteFieldsForStore(this, updated, {
      label: 'Channel scope write',
    });
    const envelope = await outboundChannel({
      ...updated,
      group_ids: writeFields.group_ids,
      previous_version: ch.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    await this.flushAndBackgroundSync();
  },

  // --- directory helpers ---

  getScopeShareGroupIds(scope) {
    return normalizeGroupIds(scope?.group_ids).map((groupId) => this.resolveGroupId(groupId)).filter(Boolean);
  },

  buildScopeDefaultShares(groupIds = []) {
    return buildScopeShares(
      normalizeGroupIds(groupIds).map((groupId) => this.resolveGroupId(groupId)).filter(Boolean),
      this.groups,
    );
  },

  async queueDirectoryRecord(row, previous = null) {
    await upsertDirectory(row);
    this.patchDirectoryLocal(row);
    const envelope = await this.buildManagedDirectoryEnvelope({
      ...row,
      group_ids: row.group_ids,
      version: row.version ?? 1,
      previous_version: previous?.version ?? 0,
      signature_npub: this.signingNpub,
      write_group_ref: typeof this.getPreferredDocWriteGroupRef === 'function'
        ? this.getPreferredDocWriteGroupRef(row)
        : getPreferredRecordWriteGroupForStore(this, row),
    }, previous || row, { intent: 'scope' });
    await queueTowerPendingWrite(this, {
      record_id: row.record_id,
      record_family_hash: recordFamilyHash('directory'),
      envelope,
    });
    return row;
  },

  // --- scope CRUD ---

  async addScope() {
    if (!this.canAdminWorkspace) {
      this.error = 'Only workspace admins can manage scopes.';
      return;
    }
    const title = String(this.newScopeTitle || '').trim();
    if (!title || !this.session?.npub) return;
    if (this.newScopeSubmitting) return;

    if (isTowerPgBackendMode()) {
      const wizardGroupIds = (Array.isArray(this.newScopeDefaultAccessRows) ? this.newScopeDefaultAccessRows : [])
        .filter((row) => row?.principal_type === 'group')
        .map((row) => row.principal_id);
      const groupIds = normalizeGroupIds([
        ...(this.newScopeAssignedGroupIds || []),
        ...wizardGroupIds,
      ])
        .map((groupId) => this.resolveGroupId(groupId))
        .filter(Boolean);
      const { workspaceId, baseUrl, appNpub } = resolveTowerPgWorkspaceContext(this);
      if (!workspaceId || !baseUrl) {
        this.error = 'Flight Deck PG workspace is not connected.';
        return;
      }
      let renderedTemplate = null;
      this.newScopeTemplateError = '';
      if (this.newScopeTemplateId) {
        try {
          renderedTemplate = renderScopeTemplate(this.selectedNewScopeTemplate, {
            ...(this.newScopeTemplateValues || {}),
            title,
          });
        } catch (error) {
          this.newScopeTemplateError = error?.message || 'Fill in the template fields before creating this scope.';
          return;
        }
      }
      this.newScopeSubmitting = true;
      try {
        const scopeDescription = String(this.newScopeDescription || '').trim()
          || String(renderedTemplate?.scope?.description || '').trim();
        const scopeResult = await createTowerPgWorkspaceScope(this, workspaceId, {
          name: title,
          description: scopeDescription,
          kind: 'project',
          owner_group_id: groupIds[0] || null,
          metadata: {
            default_channel_access_rows: cloneScopeWizardAccessRows(this.newScopeDefaultAccessRows)
              .map(({ id, ...row }) => row),
          },
        }, { baseUrl, appNpub });
        const scopeId = String(scopeResult?.scope?.id || scopeResult?.scope?.record_id || '').trim();
        if (scopeResult?.scope) {
          await upsertScope(mapPgScopeToLocal({
            ...scopeResult.scope,
            metadata: {
              ...(scopeResult.scope.metadata || {}),
              default_channel_access_rows: cloneScopeWizardAccessRows(this.newScopeDefaultAccessRows)
                .map(({ id, ...row }) => row),
            },
          }, {
            workspaceOwnerNpub: resolveTowerPgWorkspaceContext(this).workspaceOwnerNpub,
          }));
        }
        const wizardChannelDrafts = this.newScopeNamedChannelDrafts.map((channel) => ({
          name: String(channel.name || '').trim(),
          description: String(channel.description || '').trim(),
          basePrompt: String(channel.basePrompt || '').trim(),
          accessRows: Array.isArray(channel.accessRows) ? channel.accessRows : [],
        }));
        const templateChannelDrafts = (renderedTemplate?.channels || []).map((channel) => ({
          name: String(channel.title || channel.name || '').trim(),
          description: String(channel.description || '').trim(),
          basePrompt: String(channel.basePrompt || '').trim(),
          accessRows: [],
        }));
        const channelDrafts = wizardChannelDrafts.length > 0 ? wizardChannelDrafts : templateChannelDrafts;
        if (channelDrafts.length > 0) {
          if (!scopeId) throw new Error('Tower did not return a scope id for template channel creation.');
          const { workspaceOwnerNpub } = resolveTowerPgWorkspaceContext(this);
          const fallbackGrants = groupIds[0]
            ? [{
              principal_type: 'group',
              principal_id: groupIds[0],
              access_level: 'manage',
            }]
            : [];
          const createdChannels = [];
          for (const channel of channelDrafts) {
            const grants = buildPgChannelGrantPayloads(
              channel.accessRows?.length > 0 ? channel.accessRows : this.newScopeDefaultAccessRows,
            );
            const result = await createTowerPgScopeChannel(this, workspaceId, scopeId, {
              name: channel.name,
              description: String(channel.description || '').trim() || undefined,
              metadata: writeAgentChatConfig({}, {
                enabled: true,
                context_prompt: String(channel.basePrompt || '').trim(),
              }),
              kind: 'channel',
              grants: grants.length > 0 ? grants : fallbackGrants,
            }, { baseUrl, appNpub });
            const channelRow = mapPgChannelToLocal(result.channel, { workspaceOwnerNpub });
            createdChannels.push(channelRow);
            try {
              await upsertChannel(channelRow);
            } catch {
              // Descriptor reconciliation remains authoritative when no local
              // database is available to this isolated caller.
            }
          }
        }
      } finally {
        this.newScopeSubmitting = false;
      }
      this.newScopeTitle = '';
      this.newScopeDescription = '';
      this.newScopeLevel = 'l1';
      this.newScopeParentId = null;
      this.newScopeAssignedGroupIds = [];
      this.newScopeGroupQuery = '';
      this.newScopeTemplateId = '';
      this.newScopeTemplateValues = {};
      this.newScopeTemplateError = '';
      this.showNewScopeForm = false;
      this.resetNewScopeWizardDraft();
      return;
    }

    const now = new Date().toISOString();
    const recordId = crypto.randomUUID();
    const ownerNpub = this.workspaceOwnerNpub;
    const parentId = this.newScopeParentId || null;
    const hierarchy = deriveScopeHierarchy({
      parentId,
      scopesMap: this.scopesMap,
    });
    const level = hierarchy?.level ?? 'l1';
    const groupIds = normalizeGroupIds(this.newScopeAssignedGroupIds)
      .map((groupId) => this.resolveGroupId(groupId))
      .filter(Boolean);
    if (groupIds.length === 0) {
      this.error = 'Add at least one group for the scope.';
      return;
    }

    const localRow = {
      record_id: recordId,
      owner_npub: ownerNpub,
      title,
      description: this.newScopeDescription || '',
      level,
      parent_id: hierarchy.parent_id,
      l1_id: hierarchy.l1_id,
      l2_id: hierarchy.l2_id,
      l3_id: hierarchy.l3_id,
      l4_id: hierarchy.l4_id,
      l5_id: hierarchy.l5_id,
    };
    localRow[`${level}_id`] = recordId;
    Object.assign(localRow, {
      group_ids: groupIds,
      sync_status: 'pending',
      record_state: 'active',
      version: 1,
      created_at: now,
      updated_at: now,
    });

    await upsertScope(localRow);
    this.scopes = [...this.scopes, localRow];
    this.newScopeTitle = '';
    this.newScopeDescription = '';
    this.newScopeLevel = 'l1';
    this.newScopeParentId = null;
    this.newScopeAssignedGroupIds = [];
    this.newScopeGroupQuery = '';
    this.showNewScopeForm = false;

    const writeFields = await getRecordWriteFieldsForStore(this, localRow, {
      label: 'Scope write',
    });
    const envelope = await outboundScope({
      ...localRow,
      group_ids: writeFields.group_ids,
      signature_npub: this.signingNpub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: recordId,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    await this.flushAndBackgroundSync();
    await this.refreshDirectories();
    await this.refreshScopes();
  },

  startNewScope(level = 'l1', parentId = null) {
    if (!this.canAdminWorkspace) {
      this.error = 'Only workspace admins can manage scopes.';
      return;
    }
    const nextLevel = isTowerPgBackendMode() ? 'l1' : level;
    const nextParentId = isTowerPgBackendMode() ? null : parentId;
    this.newScopeLevel = nextLevel;
    this.newScopeParentId = nextParentId;
    this.newScopeTitle = '';
    this.newScopeDescription = '';
    this.newScopeAssignedGroupIds = this.getDefaultScopeGroupIds(nextLevel, nextParentId);
    this.newScopeGroupQuery = '';
    this.newScopeTemplateId = '';
    this.newScopeTemplateValues = {};
    this.newScopeTemplateError = '';
    this.newScopeSubmitting = false;
    if (isTowerPgBackendMode()) {
      this.resetNewScopeWizardDraft();
      void this.prepareNewScopeWizardAccessOptions();
    }
    this.showNewScopeForm = true;
  },

  cancelNewScope() {
    this.showNewScopeForm = false;
    this.newScopeTitle = '';
    this.newScopeDescription = '';
    this.newScopeAssignedGroupIds = [];
    this.newScopeGroupQuery = '';
    this.newScopeTemplateId = '';
    this.newScopeTemplateValues = {};
    this.newScopeTemplateError = '';
    this.newScopeSubmitting = false;
    this.resetNewScopeWizardDraft();
  },

  selectNewScopeTemplate(templateId) {
    this.newScopeTemplateId = String(templateId || '').trim();
    this.newScopeTemplateValues = {};
    this.newScopeTemplateError = '';
    for (const field of this.newScopeTemplateFields) {
      this.newScopeTemplateValues[field.name] = '';
    }
    if (this.newScopeTemplateId) {
      this.newScopeChannelNamesText = '';
    }
  },

  setNewScopeTemplateValue(name, value) {
    const key = String(name || '').trim();
    if (!key) return;
    this.newScopeTemplateValues = {
      ...(this.newScopeTemplateValues || {}),
      [key]: value,
    };
    this.newScopeTemplateError = '';
  },

  startEditScope(scopeId) {
    if (!this.canManageScope(scopeId)) {
      this.error = 'You do not have permission to manage this scope.';
      return;
    }
    const scope = this.scopesMap.get(scopeId);
    if (!scope) return;
    this.editingScopeId = scopeId;
    this.editingScopeTitle = scope.title;
    this.editingScopeDescription = scope.description || '';
    this.editingScopeAssignedGroupIds = this.getScopeShareGroupIds(scope);
    this.editingScopeGroupQuery = '';
    this.editingScopeSaving = false;
    this.editingScopeError = '';
    this.scopePolicyRepairSummary = '';
    this.scopePolicyRepairBusy = false;
    if (this.isTowerPgMode) void this.openScopeAccess?.(scope);
  },

  cancelEditScope() {
    if (this.editingScopeSaving || this.scopeAccessBusy) return;
    this.closeScopeAccess?.();
    this.editingScopeId = null;
    this.editingScopeTitle = '';
    this.editingScopeDescription = '';
    this.editingScopeAssignedGroupIds = [];
    this.editingScopeGroupQuery = '';
    this.editingScopeSaving = false;
    this.editingScopeError = '';
    this.scopePolicyRepairSummary = '';
    this.scopePolicyRepairBusy = false;
  },

  async saveEditScope(options = {}) {
    if (this.editingScopeSaving) return;
    if (!this.canManageScope(this.editingScopeId)) {
      this.editingScopeError = 'You do not have permission to manage this scope.';
      return;
    }
    if (!this.editingScopeId || !this.session?.npub) return;
    const scope = this.scopes.find(s => s.record_id === this.editingScopeId);
    if (!scope) return;
    const nextTitle = String(this.editingScopeTitle || '').trim();
    if (!nextTitle) {
      this.editingScopeError = 'Scope name is required.';
      return;
    }
    this.editingScopeError = '';

    if (isTowerPgBackendMode()) {
      const context = resolveTowerPgWorkspaceContext(this);
      if (!context.workspaceId) {
        this.editingScopeError = 'Flight Deck PG workspace context is unavailable.';
        return;
      }
      this.editingScopeSaving = true;
      try {
        const response = await updateTowerPgWorkspaceScope(this, context.workspaceId, scope.record_id, {
          name: nextTitle,
          description: String(this.editingScopeDescription || '').trim() || null,
        }, { baseUrl: context.baseUrl, appNpub: context.appNpub });
        const updated = {
          ...mapPgScopeToLocal(response?.scope, { workspaceOwnerNpub: context.workspaceOwnerNpub }),
          ...(typeof scope.pg_can_manage === 'boolean' ? { pg_can_manage: scope.pg_can_manage } : {}),
        };
        await upsertScope(updated);
        this.scopes = this.scopes.map((item) => item.record_id === updated.record_id ? updated : item);
        this.editingScopeSaving = false;
        this.cancelEditScope();
      } catch (error) {
        this.editingScopeError = error?.message || 'Failed to rename scope.';
      } finally {
        this.editingScopeSaving = false;
      }
      return;
    }
    const repairScopedRecords = options.repairScopedRecords === true;
    const previousScopeGroupIds = this.getScopeShareGroupIds(scope);

    const nextVersion = (scope.version ?? 1) + 1;
    const updated = toRaw({
      ...scope,
      title: nextTitle,
      description: this.editingScopeDescription,
      group_ids: normalizeGroupIds(this.editingScopeAssignedGroupIds)
        .map((groupId) => this.resolveGroupId(groupId))
        .filter(Boolean),
      version: nextVersion,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    });
    if (updated.group_ids.length === 0) {
      this.error = 'Add at least one group for the scope.';
      return;
    }

    await upsertScope(updated);
    this.scopes = this.scopes.map(s => s.record_id === updated.record_id ? updated : s);
    this.editingScopeId = null;
    this.editingScopeTitle = '';
    this.editingScopeDescription = '';
    this.editingScopeAssignedGroupIds = [];
    this.editingScopeGroupQuery = '';

    const writeFields = await getRecordWriteFieldsForStore(this, updated, {
      label: 'Scope write',
    });
    const envelope = await outboundScope({
      ...updated,
      group_ids: writeFields.group_ids,
      previous_version: scope.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    const groupIdsChanged = !sameScopePolicyGroupIds(
      previousScopeGroupIds,
      updated.group_ids,
      (groupId) => this.resolveGroupId(groupId),
    );
    if (repairScopedRecords && groupIdsChanged) {
      this.scopePolicyRepairBusy = true;
      try {
        const summary = await this.reencryptScopedRecordsForScope(scope, updated);
        this.scopePolicyRepairSummary = summary.message;
      } catch (error) {
        this.error = error?.message || 'Failed to reapply scope group crypto.';
      } finally {
        this.scopePolicyRepairBusy = false;
      }
    } else if (!repairScopedRecords) {
      this.scopePolicyRepairSummary = '';
    }
    await this.flushAndBackgroundSync();
    await this.refreshDirectories();
  },

  async reapplyScopeGroupCrypto(scopeId) {
    if (!this.canAdminWorkspace) {
      this.error = 'Only workspace admins can manage scopes.';
      return;
    }
    const scope = this.resolveScopeRecord(scopeId);
    if (!scope?.record_id || this.scopePolicyRepairBusy) return;

    this.scopePolicyRepairBusy = true;
    this.scopePolicyRepairSummary = '';
    try {
      const summary = await this.reencryptScopedRecordsForScope(scope, scope);
      const scopeLabel = String(scope.title || 'Scope').trim() || 'Scope';
      this.scopePolicyRepairSummary = `${scopeLabel}: ${summary.message}`;
      await this.flushAndBackgroundSync();
    } catch (error) {
      this.error = error?.message || 'Failed to reapply scope group crypto.';
    } finally {
      this.scopePolicyRepairBusy = false;
    }
  },

  hasScopedPolicyRepairChanges(record, patch, options = {}) {
    if (!record || !patch) return false;
    if (!sameNormalizedGroupIds(record.group_ids || [], patch.group_ids || [])) return true;
    if (!sameNormalizedGroupIds(record.scope_policy_group_ids || [], patch.scope_policy_group_ids || [])) return true;
    if (options.includeBoardGroupId === true) {
      if ((record.board_group_id || null) !== (patch.board_group_id || null)) return true;
    }
    return JSON.stringify(record.shares || []) !== JSON.stringify(patch.shares || []);
  },

  async repairScopedTaskRecord(task, previousScopeGroupIds = [], nextScope = null) {
    const patch = this.buildScopedPolicyRepairPatch(task, {
      scopeId: nextScope?.record_id || task.scope_id,
      previousScopeGroupIds,
      includeBoardGroupId: true,
      fallbackPolicyGroupIds: task.group_ids || [],
    });
    if (!this.hasScopedPolicyRepairChanges(task, patch, { includeBoardGroupId: true })) return false;

    const updated = toRaw({
      ...task,
      ...patch,
      version: (task.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    });
    await upsertTask(updated);
    this.tasks = this.tasks.map((entry) => entry.record_id === updated.record_id ? updated : entry);
    if (this.editingTask?.record_id === updated.record_id) {
      this.replaceEditingTaskFromRecord?.(updated, { force: true });
    }
    const writeFields = await getRecordWriteFieldsForStore(this, updated, {
      label: 'Task scope repair write',
    });
    const envelope = await outboundTask({
      ...updated,
      group_ids: writeFields.group_ids,
      previous_version: task.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return true;
  },

  async repairScopedDocumentRecord(item, previousScopeGroupIds = [], nextScope = null) {
    this.assertCanMutateLockManagedRecord(item, recordFamilyHash('document'));
    await this.ensureLockManagedCheckout(item, recordFamilyHash('document'), { intent: 'scope' });
    const patch = this.buildScopedPolicyRepairPatch(item, {
      scopeId: nextScope?.record_id || item.scope_id,
      previousScopeGroupIds,
      fallbackPolicyGroupIds: item.group_ids || [],
    });
    if (!this.hasScopedPolicyRepairChanges(item, patch)) return false;

    const updated = toRaw(this.normalizeDocumentRowGroupRefs({
      ...item,
      ...patch,
      version: (item.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    }));
    await upsertDocument(updated);
    this.patchDocumentLocal(updated);
    const envelope = await this.buildManagedDocumentEnvelope({
      record_id: updated.record_id,
      owner_npub: updated.owner_npub,
      title: updated.title,
      content: updated.content,
      parent_directory_id: updated.parent_directory_id,
      scope_id: updated.scope_id ?? null,
      scope_l1_id: updated.scope_l1_id ?? null,
      scope_l2_id: updated.scope_l2_id ?? null,
      scope_l3_id: updated.scope_l3_id ?? null,
      scope_l4_id: updated.scope_l4_id ?? null,
      scope_l5_id: updated.scope_l5_id ?? null,
      scope_policy_group_ids: updated.scope_policy_group_ids ?? null,
      shares: updated.shares,
      group_ids: updated.group_ids,
      version: updated.version,
      previous_version: item.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: typeof this.getPreferredDocWriteGroupRef === 'function'
        ? this.getPreferredDocWriteGroupRef(updated)
        : getPreferredRecordWriteGroupForStore(this, updated),
    }, item, { intent: 'scope' });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return true;
  },

  async repairScopedDirectoryRecord(item, previousScopeGroupIds = [], nextScope = null) {
    this.assertCanMutateLockManagedRecord(item, recordFamilyHash('directory'));
    await this.ensureLockManagedCheckout(item, recordFamilyHash('directory'), { intent: 'scope' });
    const patch = this.buildScopedPolicyRepairPatch(item, {
      scopeId: nextScope?.record_id || item.scope_id,
      previousScopeGroupIds,
      fallbackPolicyGroupIds: item.group_ids || [],
    });
    if (!this.hasScopedPolicyRepairChanges(item, patch)) return false;

    const updated = toRaw(this.normalizeDirectoryRowGroupRefs({
      ...item,
      ...patch,
      version: (item.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    }));
    await upsertDirectory(updated);
    this.patchDirectoryLocal(updated);
    const envelope = await this.buildManagedDirectoryEnvelope({
      record_id: updated.record_id,
      owner_npub: updated.owner_npub,
      title: updated.title,
      parent_directory_id: updated.parent_directory_id,
      scope_id: updated.scope_id ?? null,
      scope_l1_id: updated.scope_l1_id ?? null,
      scope_l2_id: updated.scope_l2_id ?? null,
      scope_l3_id: updated.scope_l3_id ?? null,
      scope_l4_id: updated.scope_l4_id ?? null,
      scope_l5_id: updated.scope_l5_id ?? null,
      scope_policy_group_ids: updated.scope_policy_group_ids ?? null,
      shares: updated.shares,
      group_ids: updated.group_ids,
      version: updated.version,
      previous_version: item.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: typeof this.getPreferredDocWriteGroupRef === 'function'
        ? this.getPreferredDocWriteGroupRef(updated)
        : getPreferredRecordWriteGroupForStore(this, updated),
    }, item, { intent: 'scope' });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return true;
  },

  resolveLegacyDocScopeId(item, fallbackScopeId = null, directoryMap = new Map()) {
    const existingScopeId = String(item?.scope_id || '').trim();
    if (existingScopeId && this.scopesMap?.has(existingScopeId)) return existingScopeId;
    let parentId = String(item?.parent_directory_id || '').trim() || null;
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = directoryMap.get(parentId)
        || (this.directories || []).find((entry) => entry.record_id === parentId)
        || null;
      const parentScopeId = String(parent?.scope_id || '').trim();
      if (parentScopeId && this.scopesMap?.has(parentScopeId)) return parentScopeId;
      parentId = String(parent?.parent_directory_id || '').trim() || null;
    }
    return fallbackScopeId && this.scopesMap?.has(fallbackScopeId) ? fallbackScopeId : null;
  },

  docDirectoryDepth(directory, directoryMap = new Map(), seen = new Set()) {
    if (!directory?.parent_directory_id || seen.has(directory.record_id)) return 0;
    seen.add(directory.record_id);
    const parent = directoryMap.get(directory.parent_directory_id);
    return parent ? 1 + this.docDirectoryDepth(parent, directoryMap, seen) : 0;
  },

  buildLegacyDocScopeAssignment(item, scopeId) {
    const scope = this.resolveScopeRecord(scopeId);
    if (!scope?.record_id) return null;
    const scopeAssignment = this.buildScopeAssignment(scope.record_id);
    const previousScopeGroupIds = item?.scope_id ? this.getResolvedScopePolicyGroupIds(item.scope_id) : [];
    const patch = this.buildScopedPolicyRepairPatch(item, {
      scopeId: scope.record_id,
      previousScopeGroupIds,
      fallbackPolicyGroupIds: item?.scope_id ? (item.group_ids || []) : [],
    });
    return {
      ...scopeAssignment,
      ...patch,
    };
  },

  async assignScopeToLegacyDocumentRecord(item, scopeId) {
    this.assertCanMutateLockManagedRecord(item, recordFamilyHash('document'));
    await this.ensureLockManagedCheckout(item, recordFamilyHash('document'), { intent: 'scope' });
    const patch = this.buildLegacyDocScopeAssignment(item, scopeId);
    if (!patch?.scope_id) return false;
    const updated = toRaw(this.normalizeDocumentRowGroupRefs({
      ...item,
      ...patch,
      version: (item.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    }));
    await upsertDocument(updated);
    this.patchDocumentLocal(updated);
    if (typeof this.ensureDocGroupKeysLoaded === 'function') {
      const missingGroupRefs = await this.ensureDocGroupKeysLoaded(updated);
      if (missingGroupRefs.length > 0) {
        throw new Error(`Document scope repair is missing group keys: ${missingGroupRefs.join(', ')}`);
      }
    }
    const envelope = await this.buildManagedDocumentEnvelope({
      record_id: updated.record_id,
      owner_npub: updated.owner_npub,
      title: updated.title,
      content: updated.content,
      parent_directory_id: updated.parent_directory_id,
      scope_id: updated.scope_id ?? null,
      scope_l1_id: updated.scope_l1_id ?? null,
      scope_l2_id: updated.scope_l2_id ?? null,
      scope_l3_id: updated.scope_l3_id ?? null,
      scope_l4_id: updated.scope_l4_id ?? null,
      scope_l5_id: updated.scope_l5_id ?? null,
      scope_policy_group_ids: updated.scope_policy_group_ids ?? null,
      shares: updated.shares,
      group_ids: updated.group_ids,
      version: updated.version,
      previous_version: item.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: typeof this.getPreferredDocWriteGroupRef === 'function'
        ? this.getPreferredDocWriteGroupRef(updated)
        : getPreferredRecordWriteGroupForStore(this, updated),
    }, item, { intent: 'scope' });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return updated;
  },

  async assignScopeToLegacyDirectoryRecord(item, scopeId) {
    this.assertCanMutateLockManagedRecord(item, recordFamilyHash('directory'));
    await this.ensureLockManagedCheckout(item, recordFamilyHash('directory'), { intent: 'scope' });
    const patch = this.buildLegacyDocScopeAssignment(item, scopeId);
    if (!patch?.scope_id) return false;
    const updated = toRaw(this.normalizeDirectoryRowGroupRefs({
      ...item,
      ...patch,
      version: (item.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    }));
    await upsertDirectory(updated);
    this.patchDirectoryLocal(updated);
    if (typeof this.ensureDocGroupKeysLoaded === 'function') {
      const missingGroupRefs = await this.ensureDocGroupKeysLoaded(updated);
      if (missingGroupRefs.length > 0) {
        throw new Error(`Folder scope repair is missing group keys: ${missingGroupRefs.join(', ')}`);
      }
    }
    const envelope = await this.buildManagedDirectoryEnvelope({
      record_id: updated.record_id,
      owner_npub: updated.owner_npub,
      title: updated.title,
      parent_directory_id: updated.parent_directory_id,
      scope_id: updated.scope_id ?? null,
      scope_l1_id: updated.scope_l1_id ?? null,
      scope_l2_id: updated.scope_l2_id ?? null,
      scope_l3_id: updated.scope_l3_id ?? null,
      scope_l4_id: updated.scope_l4_id ?? null,
      scope_l5_id: updated.scope_l5_id ?? null,
      scope_policy_group_ids: updated.scope_policy_group_ids ?? null,
      shares: updated.shares,
      group_ids: updated.group_ids,
      version: updated.version,
      previous_version: item.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: typeof this.getPreferredDocWriteGroupRef === 'function'
        ? this.getPreferredDocWriteGroupRef(updated)
        : getPreferredRecordWriteGroupForStore(this, updated),
    }, item, { intent: 'scope' });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return updated;
  },

  async repairLegacyDocScopes(scopeId = null, options = {}) {
    if (this.legacyDocScopeRepairBusy) return null;
    const fallbackScope = scopeId ? this.resolveScopeRecord(scopeId) : null;
    const fallbackScopeId = fallbackScope?.record_id || null;
    const directoryMap = new Map((this.directories || []).map((item) => [item.record_id, item]));
    const directories = [...(this.directories || [])]
      .filter((item) => item?.record_state !== 'deleted' && !item.scope_id)
      .sort((left, right) => this.docDirectoryDepth(left, directoryMap) - this.docDirectoryDepth(right, directoryMap));
    const documents = [...(this.documents || [])]
      .filter((item) => item?.record_state !== 'deleted' && !item.scope_id);
    const summary = {
      directories: 0,
      documents: 0,
      skippedDirectories: 0,
      skippedDocuments: 0,
      total: 0,
      message: '',
    };

    this.legacyDocScopeRepairBusy = true;
    this.legacyDocScopeRepairError = '';
    this.legacyDocScopeRepairNotice = '';
    try {
      for (const directory of directories) {
        const targetScopeId = this.resolveLegacyDocScopeId(directory, fallbackScopeId, directoryMap);
        if (!targetScopeId) {
          summary.skippedDirectories += 1;
          continue;
        }
        const updated = await this.assignScopeToLegacyDirectoryRecord(directory, targetScopeId);
        if (updated) {
          summary.directories += 1;
          directoryMap.set(updated.record_id, updated);
        }
      }

      for (const document of documents) {
        const targetScopeId = this.resolveLegacyDocScopeId(document, fallbackScopeId, directoryMap);
        if (!targetScopeId) {
          summary.skippedDocuments += 1;
          continue;
        }
        const updated = await this.assignScopeToLegacyDocumentRecord(document, targetScopeId);
        if (updated) summary.documents += 1;
      }

      summary.total = summary.directories + summary.documents;
      summary.message = summary.total > 0
        ? `Scoped ${summary.total} legacy doc record${summary.total === 1 ? '' : 's'} (${summary.documents} docs, ${summary.directories} folders).`
        : 'No legacy doc records could be scoped automatically.';
      if (summary.skippedDirectories || summary.skippedDocuments) {
        summary.message += ` Skipped ${summary.skippedDocuments} root doc${summary.skippedDocuments === 1 ? '' : 's'} and ${summary.skippedDirectories} root folder${summary.skippedDirectories === 1 ? '' : 's'} without a deterministic scope.`;
      }
      this.legacyDocScopeRepairNotice = summary.message;
      if (summary.total > 0 && options.sync !== false) {
        await this.flushAndBackgroundSync();
      }
      await this.refreshDirectories();
      await this.refreshDocuments();
      return summary;
    } catch (error) {
      this.legacyDocScopeRepairError = error?.message || 'Failed to scope legacy docs.';
      throw error;
    } finally {
      this.legacyDocScopeRepairBusy = false;
    }
  },

  async repairLegacyDocScopesFromSettings() {
    const scopeId = this.legacyDocScopeRepairScopeId || null;
    await this.repairLegacyDocScopes(scopeId);
  },

  async repairScopedFlowRecord(flow, previousScopeGroupIds = [], nextScope = null) {
    const patch = this.buildScopedPolicyRepairPatch(flow, {
      scopeId: nextScope?.record_id || flow.scope_id,
      previousScopeGroupIds,
      fallbackPolicyGroupIds: flow.group_ids || [],
    });
    if (!this.hasScopedPolicyRepairChanges(flow, patch)) return false;

    const updated = toRaw({
      ...flow,
      ...patch,
      version: (flow.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    });
    await upsertFlow(updated);
    this.flows = this.flows.map((entry) => entry.record_id === updated.record_id ? updated : entry);
    const writeFields = await getRecordWriteFieldsForStore(this, updated, {
      label: 'Flow scope repair write',
    });
    const envelope = await outboundFlow({
      ...updated,
      group_ids: writeFields.group_ids,
      previous_version: flow.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return true;
  },

  async repairScopedApprovalRecord(approval, previousScopeGroupIds = [], nextScope = null) {
    const patch = this.buildScopedPolicyRepairPatch(approval, {
      scopeId: nextScope?.record_id || approval.scope_id,
      previousScopeGroupIds,
      fallbackPolicyGroupIds: approval.group_ids || [],
    });
    if (!this.hasScopedPolicyRepairChanges(approval, patch)) return false;

    const updated = toRaw({
      ...approval,
      ...patch,
      version: (approval.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    });
    await upsertApproval(updated);
    this.approvals = this.approvals.map((entry) => entry.record_id === updated.record_id ? updated : entry);
    const writeFields = await getRecordWriteFieldsForStore(this, updated, {
      label: 'Approval scope repair write',
    });
    const envelope = await outboundApproval({
      ...updated,
      group_ids: writeFields.group_ids,
      previous_version: approval.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return true;
  },

  async repairScopedChannelRecord(channel, nextScope = null) {
    const nextGroupIds = this.getResolvedScopePolicyGroupIds(nextScope?.record_id || channel.scope_id);
    if (sameNormalizedGroupIds(channel.group_ids || [], nextGroupIds)) return false;

    const updated = toRaw({
      ...channel,
      group_ids: nextGroupIds,
      version: (channel.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    });
    await upsertChannel(updated);
    this.channels = this.channels.map((entry) => entry.record_id === updated.record_id ? updated : entry);
    const writeFields = await getRecordWriteFieldsForStore(this, updated, {
      label: 'Channel scope repair write',
    });
    const envelope = await outboundChannel({
      ...updated,
      group_ids: writeFields.group_ids,
      previous_version: channel.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return true;
  },

  async repairScopedReportRecord(report, nextScope = null) {
    const nextGroupIds = this.getResolvedScopePolicyGroupIds(nextScope?.record_id || report.scope_id);
    if (sameNormalizedGroupIds(report.group_ids || [], nextGroupIds)) return false;

    const updated = toRaw({
      ...report,
      group_ids: nextGroupIds,
      version: (report.version ?? 1) + 1,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    });
    await upsertReport(updated);
    this.reports = this.reports.map((entry) => entry.record_id === updated.record_id ? updated : entry);
    if (this.selectedReportId === updated.record_id) {
      await this.applySelectedReport(updated);
    }
    const writeFields = await getRecordWriteFieldsForStore(this, updated, {
      label: 'Report scope repair write',
    });
    const envelope = await outboundReport({
      ...updated,
      group_ids: writeFields.group_ids,
      metadata: updated.metadata,
      data: {
        declaration_type: updated.declaration_type,
        payload: updated.payload,
      },
      previous_version: report.version ?? 1,
      signature_npub: this.signingNpub,
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    return true;
  },

  async reencryptScopedRecordsForScope(previousScope, nextScope) {
    const scopeId = nextScope?.record_id;
    if (!scopeId) return { total: 0, message: 'No scoped records were re-encrypted.' };

    const families = [
      {
        id: 'tasks',
        records: (this.tasks || []).filter((item) => item?.scope_id === scopeId && item.record_state !== 'deleted'),
        repair: (record, previousScopeGroupIdsArg) => this.repairScopedTaskRecord(record, previousScopeGroupIdsArg, nextScope),
      },
      {
        id: 'documents',
        records: (this.documents || []).filter((item) => item?.scope_id === scopeId && item.record_state !== 'deleted'),
        repair: (record, previousScopeGroupIdsArg) => this.repairScopedDocumentRecord(record, previousScopeGroupIdsArg, nextScope),
      },
      {
        id: 'directories',
        records: (this.directories || []).filter((item) => item?.scope_id === scopeId && item.record_state !== 'deleted'),
        repair: (record, previousScopeGroupIdsArg) => this.repairScopedDirectoryRecord(record, previousScopeGroupIdsArg, nextScope),
      },
      {
        id: 'flows',
        records: (this.flows || []).filter((item) => item?.scope_id === scopeId && item.record_state !== 'deleted'),
        repair: (record, previousScopeGroupIdsArg) => this.repairScopedFlowRecord(record, previousScopeGroupIdsArg, nextScope),
      },
      {
        id: 'approvals',
        records: (this.approvals || []).filter((item) => item?.scope_id === scopeId && item.record_state !== 'deleted'),
        repair: (record, previousScopeGroupIdsArg) => this.repairScopedApprovalRecord(record, previousScopeGroupIdsArg, nextScope),
      },
      {
        id: 'channels',
        records: (this.channels || []).filter((item) => item?.scope_id === scopeId && item.record_state !== 'deleted'),
        repair: (record) => this.repairScopedChannelRecord(record, nextScope),
      },
      {
        id: 'reports',
        records: (this.reports || []).filter((item) => item?.scope_id === scopeId && item.record_state !== 'deleted'),
        repair: (record) => this.repairScopedReportRecord(record, nextScope),
      },
    ];
    const counts = Object.fromEntries(families.map((family) => [family.id, family.records.length]));
    this.initializeScopeRepairProgress(counts);
    const previousScopeGroupIds = previousScope?.record_id && previousScope.record_id !== scopeId
      ? this.getScopeShareGroupIds(previousScope)
      : [];
    const summary = {
      tasks: 0,
      documents: 0,
      directories: 0,
      flows: 0,
      approvals: 0,
      channels: 0,
      reports: 0,
    };

    Object.assign(this.scopeRepairSession, { phase: 'rewriting', error: null });

    try {
      for (const family of families) {
        this.markScopeRepairProgress(family.id, 'active', { processed: 0, rewritten: 0 });
        for (let index = 0; index < family.records.length; index += 1) {
          const changed = await family.repair(family.records[index], previousScopeGroupIds);
          if (changed) summary[family.id] += 1;
          this.markScopeRepairProgress(family.id, 'active', {
            processed: index + 1,
            rewritten: summary[family.id],
          });
        }
        this.markScopeRepairProgress(family.id, 'done', {
          processed: family.records.length,
          rewritten: summary[family.id],
        });
      }
      Object.assign(this.scopeRepairSession, {
        phase: 'done',
        finishedAt: Date.now(),
        currentFamily: null,
        error: null,
      });
    } catch (error) {
      const activeFamilyId = this.scopeRepairProgress.find((family) => family.status === 'active')?.id || null;
      if (activeFamilyId) this.markScopeRepairProgress(activeFamilyId, 'error');
      Object.assign(this.scopeRepairSession, {
        phase: 'error',
        finishedAt: Date.now(),
        error: error?.message || 'Failed to reapply scope group crypto.',
      });
      throw error;
    }

    const total = Object.values(summary).reduce((count, value) => count + value, 0);
    return {
      ...summary,
      total,
      message: total > 0
        ? `Re-encrypted ${total} scoped record${total === 1 ? '' : 's'} (${summary.tasks} tasks, ${summary.documents} docs, ${summary.directories} folders, ${summary.flows} flows, ${summary.approvals} approvals, ${summary.channels} channels, ${summary.reports} reports).`
        : 'No scoped records needed re-encryption.',
    };
  },

  async deleteScope(scopeId) {
    if (this.deletingScopeId) return;
    if (!this.canManageScope(scopeId)) {
      this.error = 'You do not have permission to manage this scope.';
      this.scopeDeleteError = this.error;
      return;
    }
    if (isTowerPgBackendMode()) {
      const scope = this.scopes.find(s => s.record_id === scopeId);
      if (!scope) return;
      this.deletingScopeId = scopeId;
      this.error = '';
      this.scopeDeleteError = '';
      this.scopeDeleteNotice = '';
      try {
        const { workspaceId, baseUrl, appNpub } = resolveTowerPgWorkspaceContext(this);
        if (!workspaceId || !baseUrl) throw new Error('Flight Deck PG workspace is not connected');
        if (scope.pg_workspace_id && scope.pg_workspace_id !== workspaceId) throw new Error('This scope belongs to a different workspace.');
        await deleteTowerPgWorkspaceScope(this, workspaceId, scopeId, { baseUrl, appNpub });
        await upsertScope(toRaw({ ...scope, record_state: 'deleted', sync_status: 'synced' }));
        const channelIds = new Set((this.channels || []).filter((channel) => channel.scope_id === scopeId).map((channel) => channel.record_id));
        for (const channelId of channelIds) await deleteChannelRuntimeState(channelId);
        const selectedDeleted = channelIds.has(this.selectedChannelId) || this.pgContextScopeId === scopeId || this.selectedBoardId === scopeId;
        this.scopes = this.scopes.filter((item) => item.record_id !== scopeId);
        this.channels = (this.channels || []).filter((item) => !channelIds.has(item.record_id));
        if (selectedDeleted) {
          this.selectedChannelId = null;
          this.closeThread?.();
          this.messages = [];
          this.openAllScopesOverview?.();
        }
        this.scopeDeleteConfirmation = null;
        this.scopeDeleteNotice = `Archived scope "${scope.title || 'Untitled scope'}" and its channels.`;
        this.syncRoute?.();
      } catch (error) {
        this.error = error?.message || 'Failed to delete scope';
        this.scopeDeleteError = this.error;
      } finally {
        this.deletingScopeId = null;
      }
      return;
    }
    const scope = this.scopes.find(s => s.record_id === scopeId);
    if (!scope || !this.session?.npub) return;

    const nextVersion = (scope.version ?? 1) + 1;
    const updated = toRaw({
      ...scope,
      record_state: 'deleted',
      version: nextVersion,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    });

    await upsertScope(updated);
    this.scopes = this.scopes.filter(s => s.record_id !== scopeId);
    this.scopeDeleteConfirmation = null;
    this.scopeDeleteNotice = `Deleted scope "${scope.title || 'Untitled scope'}".`;

    const writeFields = await getRecordWriteFieldsForStore(this, updated, {
      label: 'Scope delete',
    });
    const envelope = await outboundScope({
      ...updated,
      group_ids: writeFields.group_ids,
      previous_version: scope.version ?? 1,
      signature_npub: this.signingNpub,
      record_state: 'deleted',
      write_group_ref: writeFields.write_group_ref,
    });
    await queueTowerPendingWrite(this, {
      record_id: scopeId,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    await this.flushAndBackgroundSync();
  },

  getAvailableParents(level) {
    return getAvailableParents(this.scopes, level);
  },

  // --- scope form helpers ---

  getDefaultScopeGroupIds(level = this.newScopeLevel, parentId = this.newScopeParentId || null) {
    return defaultScopeGroupIds({
      level,
      parentId,
      scopesMap: this.scopesMap,
      fallbackGroupId: this.memberPrivateGroupRef || this.scopeAssignableGroups[0]?.groupId || null,
    }).map((groupId) => this.resolveGroupId(groupId));
  },

  syncNewScopePermissionDefaults() {
    this.newScopeAssignedGroupIds = this.getDefaultScopeGroupIds(this.newScopeLevel, this.newScopeParentId || null);
    this.newScopeGroupQuery = '';
  },

  handleNewScopeLevelChange(level) {
    if (isTowerPgBackendMode()) {
      this.newScopeLevel = 'l1';
      this.newScopeParentId = null;
      this.syncNewScopePermissionDefaults();
      return;
    }
    this.newScopeLevel = level;
    if (level === 'l1') this.newScopeParentId = null;
    this.syncNewScopePermissionDefaults();
  },

  handleNewScopeParentChange(parentId) {
    if (isTowerPgBackendMode()) {
      this.newScopeLevel = 'l1';
      this.newScopeParentId = null;
      this.syncNewScopePermissionDefaults();
      return;
    }
    this.newScopeParentId = parentId || null;
    this.syncNewScopePermissionDefaults();
  },

  handleNewScopeGroupInput(value) {
    this.newScopeGroupQuery = value;
  },

  addNewScopeGroup(groupId) {
    const nextGroupId = this.resolveGroupId(groupId);
    if (!nextGroupId) return;
    if (isTowerPgBackendMode()) {
      this.newScopeAssignedGroupIds = [nextGroupId];
      this.newScopeGroupQuery = '';
      return;
    }
    this.newScopeAssignedGroupIds = normalizeGroupIds([
      ...this.newScopeAssignedGroupIds,
      nextGroupId,
    ]);
    this.newScopeGroupQuery = '';
  },

  removeNewScopeGroup(groupId) {
    const targetGroupId = this.resolveGroupId(groupId);
    this.newScopeAssignedGroupIds = this.newScopeAssignedGroupIds.filter((value) => this.resolveGroupId(value) !== targetGroupId);
    this.newScopeGroupQuery = '';
  },

  handleEditingScopeGroupInput(value) {
    this.editingScopeGroupQuery = value;
  },

  addEditingScopeGroup(groupId) {
    const nextGroupId = this.resolveGroupId(groupId);
    if (!nextGroupId) return;
    this.editingScopeAssignedGroupIds = normalizeGroupIds([
      ...this.editingScopeAssignedGroupIds,
      nextGroupId,
    ]);
    this.editingScopeGroupQuery = '';
  },

  removeEditingScopeGroup(groupId) {
    const targetGroupId = this.resolveGroupId(groupId);
    this.editingScopeAssignedGroupIds = this.editingScopeAssignedGroupIds.filter((value) => this.resolveGroupId(value) !== targetGroupId);
    this.editingScopeGroupQuery = '';
  },
};
