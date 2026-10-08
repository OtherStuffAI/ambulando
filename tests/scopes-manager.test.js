import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteTowerPgWorkspaceScope: vi.fn(),
  deleteChannelRuntimeState: vi.fn(),
  createTowerPgScopeChannel: vi.fn(),
  createTowerPgWorkspaceScope: vi.fn(),
  updateTowerPgWorkspaceScope: vi.fn(),
  updateTowerPgDoc: vi.fn(),
  upsertScope: vi.fn(),
  upsertChannel: vi.fn(),
  hydrateTowerPgScopes: vi.fn(),
  mapPgChannelToLocal: vi.fn((channel = {}) => ({
    record_id: channel.id,
    title: channel.name,
    scope_id: channel.scope_id,
    metadata: channel.metadata || {},
    record_state: 'active',
  })),
  mapPgScopeToLocal: vi.fn((scope = {}) => ({
    record_id: scope.id,
    title: scope.name,
    description: scope.description || '',
    record_state: 'active',
    pg_backend: true,
    ...(typeof scope.can_manage === 'boolean' ? { pg_can_manage: scope.can_manage } : {}),
    updated_at: scope.updated_at || '2026-07-27T06:30:00.000Z',
    version: scope.row_version || 1,
  })),
  mapPgDocToLocal: vi.fn((doc = {}) => ({
    record_id: doc.id,
    pg_backend: true,
    scope_id: doc.scope_id,
    pg_channel_id: doc.channel_id,
    title: doc.title,
    version: doc.row_version,
  })),
  isTowerPgBackendMode: vi.fn(() => false),
  resolveTowerPgWorkspaceContext: vi.fn(() => ({
    workspaceId: 'workspace-1',
    baseUrl: 'https://tower.example',
    appNpub: 'flightdeck_pg',
  })),
}));

vi.mock('../src/api.js', () => ({
  deleteTowerPgWorkspaceScope: mocks.deleteTowerPgWorkspaceScope,
  createTowerPgScopeChannel: mocks.createTowerPgScopeChannel,
  createTowerPgWorkspaceScope: mocks.createTowerPgWorkspaceScope,
  updateTowerPgWorkspaceScope: mocks.updateTowerPgWorkspaceScope,
  updateTowerPgDoc: mocks.updateTowerPgDoc,
}));

vi.mock('../src/db.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteChannelRuntimeState: mocks.deleteChannelRuntimeState,
  upsertScope: mocks.upsertScope,
  upsertChannel: mocks.upsertChannel,
}));

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: mocks.isTowerPgBackendMode,
}));

vi.mock('../src/pg-read-hydrator.js', () => ({
  hydrateTowerPgScopes: mocks.hydrateTowerPgScopes,
  mapPgChannelToLocal: mocks.mapPgChannelToLocal,
  mapPgScopeToLocal: mocks.mapPgScopeToLocal,
  mapPgDocToLocal: mocks.mapPgDocToLocal,
  resolveTowerPgWorkspaceContext: mocks.resolveTowerPgWorkspaceContext,
}));

import {
  getAvailableParents,
  readScopeAssignment,
  sameScopeAssignment,
  scopesManagerMixin,
} from '../src/scopes-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTowerPgWorkspaceScope.mockResolvedValue({ scope: { id: 'scope-1' } });
  mocks.updateTowerPgWorkspaceScope.mockResolvedValue({ scope: { id: 'scope-1', name: 'Renamed scope' } });
  mocks.createTowerPgScopeChannel.mockImplementation(async (_workspaceId, scopeId, body) => ({
    channel: {
      id: `channel-${String(body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: body.name,
      scope_id: scopeId,
      metadata: body.metadata || {},
    },
  }));
  mocks.updateTowerPgDoc.mockResolvedValue({ doc: { id: 'doc-1' } });
  mocks.upsertScope.mockResolvedValue(undefined);
  mocks.upsertChannel.mockResolvedValue(undefined);
  mocks.hydrateTowerPgScopes.mockResolvedValue([]);
  mocks.mapPgChannelToLocal.mockImplementation((channel = {}) => ({
    record_id: channel.id,
    title: channel.name,
    scope_id: channel.scope_id,
    metadata: channel.metadata || {},
    record_state: 'active',
  }));
  mocks.mapPgDocToLocal.mockImplementation((doc = {}) => ({
    record_id: doc.id,
    pg_backend: true,
    scope_id: doc.scope_id,
    pg_channel_id: doc.channel_id,
    title: doc.title,
    version: doc.row_version,
  }));
  mocks.isTowerPgBackendMode.mockReturnValue(false);
  mocks.resolveTowerPgWorkspaceContext.mockReturnValue({
    workspaceId: 'workspace-1',
    baseUrl: 'https://tower.example',
    appNpub: 'flightdeck_pg',
  });
});

function createScopeStore(overrides = {}) {
  const store = {
    scopePickerQuery: '',
    showScopePicker: false,
    showChannelScopePicker: false,
    showNewScopeForm: false,
    canAdminWorkspace: true,
    ...overrides,
  };

  const descriptors = Object.getOwnPropertyDescriptors(scopesManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }

  return store;
}

describe('scopes-manager pure utilities', () => {
  it('reconciles the selected chat channel after scopes hydrate', async () => {
    const ensureSelectedChatChannelInScope = vi.fn();
    const store = createScopeStore({
      scopes: [],
      scopesLoaded: false,
      navSection: 'chat',
      normalizeScopeRowGroupRefs: (scope) => scope,
      ensureSelectedChatChannelInScope,
    });

    await store.applyScopes([{ record_id: 'scope-a', title: 'Scope A', level: 'l1' }]);

    expect(store.scopesLoaded).toBe(true);
    expect(ensureSelectedChatChannelInScope).toHaveBeenCalledWith({ syncRoute: false });
  });

  // --- getAvailableParents ---
  describe('getAvailableParents', () => {
    const scopes = [
      { record_id: 's1', level: 'product', title: 'Product A', record_state: 'active' },
      { record_id: 's2', level: 'product', title: 'Product B', record_state: 'deleted' },
      { record_id: 's3', level: 'project', title: 'Project X', record_state: 'active' },
      { record_id: 's4', level: 'project', title: 'Project Y', record_state: 'deleted' },
      { record_id: 's5', level: 'deliverable', title: 'Deliverable 1', record_state: 'active' },
    ];

    it('returns empty array for product level', () => {
      expect(getAvailableParents(scopes, 'product')).toEqual([]);
    });

    it('returns active products for project level', () => {
      const result = getAvailableParents(scopes, 'project');
      expect(result).toHaveLength(1);
      expect(result[0].record_id).toBe('s1');
    });

    it('excludes deleted products from project parents', () => {
      const result = getAvailableParents(scopes, 'project');
      expect(result.every(s => s.record_state !== 'deleted')).toBe(true);
    });

    it('returns active projects for deliverable level', () => {
      const result = getAvailableParents(scopes, 'deliverable');
      expect(result).toHaveLength(1);
      expect(result[0].record_id).toBe('s3');
    });

    it('excludes deleted projects from deliverable parents', () => {
      const result = getAvailableParents(scopes, 'deliverable');
      expect(result.every(s => s.record_state !== 'deleted')).toBe(true);
    });

    it('returns empty array for unknown level', () => {
      expect(getAvailableParents(scopes, 'unknown')).toEqual([]);
    });
  });

  // --- readScopeAssignment / sameScopeAssignment ---
  describe('scope assignment helpers', () => {
    it('normalizes missing scope fields to null', () => {
      expect(readScopeAssignment({})).toEqual({
        scope_id: null,
        scope_l1_id: null,
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
      });
    });

    it('reads scope assignment fields from a scoped record', () => {
      expect(readScopeAssignment({
        scope_id: 'scope-project',
        scope_l1_id: 'scope-product',
        scope_l2_id: 'scope-project',
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
      })).toEqual({
        scope_id: 'scope-project',
        scope_l1_id: 'scope-product',
        scope_l2_id: 'scope-project',
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
      });
    });

    it('detects equal scope assignments even across different record shapes', () => {
      expect(sameScopeAssignment(
        {
          scope_id: 'scope-project',
          scope_l1_id: 'scope-product',
          scope_l2_id: 'scope-project',
          scope_l3_id: null,
          scope_l4_id: null,
          scope_l5_id: null,
        },
        {
          record_id: 'doc-1',
          scope_id: 'scope-project',
          scope_l1_id: 'scope-product',
          scope_l2_id: 'scope-project',
          scope_l3_id: null,
          scope_l4_id: null,
          scope_l5_id: null,
        },
      )).toBe(true);
    });

    it('detects when scope assignments differ', () => {
      expect(sameScopeAssignment(
        { scope_id: 'scope-project', scope_l1_id: 'scope-product', scope_l2_id: 'scope-project' },
        { scope_id: 'scope-deliverable', scope_l1_id: 'scope-product', scope_l2_id: 'scope-project', scope_l3_id: 'scope-deliverable' },
      )).toBe(false);
    });
  });

  describe('scope picker state', () => {
    it('openScopePicker closes the channel scope picker', () => {
      const store = createScopeStore({
        scopePickerQuery: 'draft',
        showChannelScopePicker: true,
        showNewScopeForm: true,
      });

      store.openScopePicker();

      expect(store.scopePickerQuery).toBe('');
      expect(store.showScopePicker).toBe(true);
      expect(store.showChannelScopePicker).toBe(false);
      expect(store.showNewScopeForm).toBe(false);
    });

    it('openChannelScopePicker closes the task scope picker', () => {
      const store = createScopeStore({
        scopePickerQuery: 'draft',
        showScopePicker: true,
        showNewScopeForm: true,
      });

      store.openChannelScopePicker();

      expect(store.scopePickerQuery).toBe('');
      expect(store.showChannelScopePicker).toBe(true);
      expect(store.showScopePicker).toBe(false);
      expect(store.showNewScopeForm).toBe(false);
    });

    it('closeChannelScopePicker clears the shared query', () => {
      const store = createScopeStore({
        scopePickerQuery: 'ops',
        showChannelScopePicker: true,
        showNewScopeForm: true,
      });

      store.closeChannelScopePicker();

      expect(store.scopePickerQuery).toBe('');
      expect(store.showChannelScopePicker).toBe(false);
      expect(store.showNewScopeForm).toBe(false);
    });
  });

  describe('document scope assignment', () => {
    it('flushes pending document edits before moving the selected document scope', async () => {
      const timer = setTimeout(() => {}, 1000);
      const originalDoc = {
        record_id: 'doc-1',
        title: 'Draft',
        content: 'before',
        scope_id: 'scope-old',
        version: 1,
      };
      const savedDoc = {
        ...originalDoc,
        content: 'after',
        version: 2,
      };
      const saveSelectedDocItem = vi.fn(async function saveSelectedDocItem() {
        this.selectedDocument = savedDoc;
        this.documents = [savedDoc];
        return savedDoc;
      });
      const updateDocScope = vi.fn();
      const closeScopePicker = vi.fn();
      const store = createScopeStore({
        session: { npub: 'npub1user' },
        selectedDocType: 'document',
        selectedDocument: originalDoc,
        documents: [originalDoc],
        docsEditorOpen: true,
        docAutosaveState: 'pending',
        docAutosaveTimer: timer,
        saveSelectedDocItem,
        updateDocScope,
        closeScopePicker,
      });

      await store.selectScopeForDoc('scope-new');

      expect(store.docAutosaveTimer).toBeNull();
      expect(saveSelectedDocItem).toHaveBeenCalledWith({ autosave: true });
      expect(updateDocScope).toHaveBeenCalledWith(savedDoc, 'scope-new');
      expect(closeScopePicker).toHaveBeenCalled();
    });

    it('flushes pending document edits and closes the editor for docs context changes', async () => {
      const originalDoc = {
        record_id: 'doc-1',
        title: 'Draft',
        content: 'before',
        scope_id: 'scope-old',
        version: 1,
      };
      const savedDoc = {
        ...originalDoc,
        content: 'after',
        version: 2,
      };
      const saveSelectedDocItem = vi.fn(async function saveSelectedDocItem() {
        this.selectedDocument = savedDoc;
        this.documents = [savedDoc];
        return savedDoc;
      });
      const closeDocEditor = vi.fn();
      const syncRoute = vi.fn();
      const store = createScopeStore({
        selectedDocType: 'document',
        selectedDocument: originalDoc,
        documents: [originalDoc],
        docsEditorOpen: true,
        docAutosaveState: 'pending',
        saveSelectedDocItem,
        closeDocEditor,
        syncRoute,
      });

      const result = await store.resetOpenDocumentForContextChange(originalDoc);

      expect(result).toBe(savedDoc);
      expect(saveSelectedDocItem).toHaveBeenCalledWith({ autosave: true });
      expect(closeDocEditor).toHaveBeenCalledWith({ syncRoute: false });
      expect(syncRoute).toHaveBeenCalled();
    });
  });

  describe('Tower PG scope state', () => {
    it('forces new scopes to the top-level PG model', () => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      const store = createScopeStore({
        scopeAssignableGroups: [{ groupId: 'group-1' }],
        scopesMap: new Map(),
        resolveGroupId(groupId) {
          return groupId || null;
        },
      });

      store.startNewScope('l4', 'legacy-parent');

      expect(store.newScopeLevel).toBe('l1');
      expect(store.newScopeParentId).toBe(null);
      expect(store.showNewScopeForm).toBe(true);
      expect(store.newScopeAssignedGroupIds).toEqual(['group-1']);
    });

    it('creates scopes through the Tower PG API instead of encrypted pending writes', async () => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      const refreshScopes = vi.fn(async () => []);
      const flushAndBackgroundSync = vi.fn(async () => {});
      const store = createScopeStore({
        session: { npub: 'npub1operator-a' },
        newScopeTitle: 'Marketing',
        newScopeDescription: 'Top-level marketing work area',
        newScopeAssignedGroupIds: ['group-1'],
        resolveGroupId(groupId) {
          return groupId || null;
        },
        refreshScopes,
        flushAndBackgroundSync,
      });

      await store.addScope();

      expect(mocks.createTowerPgWorkspaceScope).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
        name: 'Marketing',
        description: 'Top-level marketing work area',
        kind: 'project',
        owner_group_id: 'group-1',
      }), {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(refreshScopes).not.toHaveBeenCalled();
      expect(flushAndBackgroundSync).not.toHaveBeenCalled();
      expect(store.showNewScopeForm).toBe(false);
      expect(store.newScopeLevel).toBe('l1');
      expect(store.newScopeParentId).toBe(null);
    });

    it('creates Product template channels with rendered base prompts after creating a PG scope', async () => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      const refreshScopes = vi.fn(async () => []);
      const store = createScopeStore({
        session: { npub: 'npub1operator-a' },
        channels: [],
        newScopeTitle: 'Product Score',
        newScopeDescription: '',
        newScopeAssignedGroupIds: ['group-1'],
        newScopeTemplateId: 'product',
        newScopeTemplateValues: {
          workingdir: '/home/operator/code/product-score',
        },
        resolveGroupId(groupId) {
          return groupId || null;
        },
        refreshScopes,
      });

      await store.addScope();

      expect(mocks.createTowerPgWorkspaceScope).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
        name: 'Product Score',
        description: 'Product scope for Product Score. Code/work directory: /home/operator/code/product-score.',
        kind: 'project',
        owner_group_id: 'group-1',
      }), {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(mocks.createTowerPgScopeChannel).toHaveBeenCalledTimes(4);
      expect(mocks.createTowerPgScopeChannel).toHaveBeenCalledWith('workspace-1', 'scope-1', expect.objectContaining({
        name: 'Features',
        metadata: {
          agent_chat: {
            enabled: true,
            context_prompt: expect.stringContaining('feature work on the Product Score project'),
            activation: 'mention_then_continue',
          },
        },
        grants: [{
          principal_type: 'group',
          principal_id: 'group-1',
          access_level: 'manage',
        }],
      }), {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(mocks.createTowerPgScopeChannel).toHaveBeenCalledWith('workspace-1', 'scope-1', expect.objectContaining({
        name: 'Implementation',
        metadata: {
          agent_chat: {
            enabled: true,
            context_prompt: expect.stringContaining('Working directory: /home/operator/code/product-score'),
            activation: 'mention_then_continue',
          },
        },
      }), {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(mocks.upsertChannel.mock.calls.map(([channel]) => channel.title)).toEqual([
        'Features', 'Implementation', 'Bugs', 'Refactoring',
      ]);
      expect(store.newScopeTemplateId).toBe('');
      expect(store.newScopeTemplateValues).toEqual({});
      expect(refreshScopes).not.toHaveBeenCalled();
    });

    it('creates a PG scope wizard with channels, default access, and per-channel access', async () => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      const refreshScopes = vi.fn(async () => []);
      const store = createScopeStore({
        session: { npub: 'npub1operator-a' },
        channels: [],
        newScopeTitle: 'Projects',
        newScopeDescription: 'Project work',
        newScopeDefaultAccessRows: [
          { principal_type: 'group', principal_id: 'group-workspace', capacity: 'viewer' },
          { principal_type: 'actor', principal_id: 'actor-operator-a', capacity: 'manager' },
        ],
        newScopeChannelDrafts: [
          {
            id: 'draft-implementation',
            name: 'Implementation',
            description: 'Build work',
            basePrompt: 'Implementation context',
            accessRows: [
              { principal_type: 'group', principal_id: 'group-workspace', capacity: 'viewer' },
              { principal_type: 'actor', principal_id: 'actor-operator-a', capacity: 'manager' },
              { principal_type: 'actor', principal_id: 'actor-testagent', capacity: 'contributor' },
            ],
          },
          {
            id: 'draft-agents',
            name: 'Agents',
            description: '',
            basePrompt: 'Agent work',
            accessRows: [
              { principal_type: 'group', principal_id: 'group-agents', capacity: 'agent' },
            ],
          },
        ],
        resolveGroupId(groupId) {
          return groupId || null;
        },
        refreshScopes,
      });

      await store.addScope();

      expect(mocks.createTowerPgWorkspaceScope).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
        name: 'Projects',
        description: 'Project work',
        kind: 'project',
        owner_group_id: 'group-workspace',
      }), {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(mocks.createTowerPgScopeChannel).toHaveBeenCalledTimes(2);
      expect(mocks.createTowerPgScopeChannel).toHaveBeenCalledWith('workspace-1', 'scope-1', expect.objectContaining({
        name: 'Implementation',
        description: 'Build work',
        metadata: {
          agent_chat: { enabled: true, context_prompt: 'Implementation context', activation: 'mention_then_continue' },
        },
        kind: 'channel',
        grants: [
          { principal_type: 'group', principal_id: 'group-workspace', access_level: 'view' },
          { principal_type: 'actor', principal_id: 'actor-operator-a', access_level: 'manage' },
          { principal_type: 'actor', principal_id: 'actor-testagent', access_level: 'contribute' },
        ],
      }), {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(mocks.createTowerPgScopeChannel).toHaveBeenCalledWith('workspace-1', 'scope-1', expect.objectContaining({
        name: 'Agents',
        description: undefined,
        metadata: {
          agent_chat: { enabled: true, context_prompt: 'Agent work', activation: 'mention_then_continue' },
        },
        kind: 'channel',
        grants: [
          {
            principal_type: 'group',
            principal_id: 'group-agents',
            permissions: expect.arrayContaining(['channel.read', 'task.create', 'doc.write']),
          },
        ],
      }), {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(mocks.upsertChannel.mock.calls.map(([channel]) => channel.title)).toEqual(['Implementation', 'Agents']);
      expect(refreshScopes).not.toHaveBeenCalled();
      expect(store.showNewScopeForm).toBe(false);
    });

    it('keeps the PG scope owner group as a single group selection', () => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      const store = createScopeStore({
        newScopeAssignedGroupIds: ['group-1'],
        resolveGroupId(groupId) {
          return groupId || null;
        },
      });

      store.addNewScopeGroup('group-2');

      expect(store.newScopeAssignedGroupIds).toEqual(['group-2']);
      expect(store.newScopeGroupQuery).toBe('');
    });
  });

  describe('scope edit state', () => {
    it.each([
      { permission: true, canAdminWorkspace: false, expected: true, label: 'explicit true' },
      { permission: false, canAdminWorkspace: true, expected: false, label: 'explicit false' },
      { permission: undefined, canAdminWorkspace: true, expected: true, label: 'absent for a workspace admin' },
      { permission: undefined, canAdminWorkspace: false, expected: false, label: 'absent for a non-admin' },
    ])('handles PG scope manage permission when $label', ({ permission, canAdminWorkspace, expected }) => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      const scope = { record_id: 'scope-1' };
      if (permission !== undefined) scope.pg_can_manage = permission;
      const store = createScopeStore({
        canAdminWorkspace,
        scopesMap: new Map([[scope.record_id, scope]]),
      });

      expect(store.canManageScope(scope)).toBe(expected);
    });

    it('persists an admin PG scope rename when can_manage is absent without inventing permission metadata', async () => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      const scope = { record_id: 'scope-1', title: 'Original scope', description: '', record_state: 'active', updated_at: '2026-07-27T06:00:00.000Z', version: 1 };
      const store = createScopeStore({
        session: { npub: 'npub1owner' },
        scopes: [scope],
        scopesMap: new Map([[scope.record_id, scope]]),
        scopesLoaded: true,
        editingScopeId: scope.record_id,
        editingScopeTitle: '  Renamed scope  ',
        editingScopeDescription: 'Updated',
        editingScopeAssignedGroupIds: [],
        editingScopeGroupQuery: '',
        editingScopeSaving: false,
        editingScopeError: '',
        scopePolicyRepairBusy: false,
        scopePolicyRepairSummary: '',
        normalizeScopeRowGroupRefs: (row) => row,
      });

      await store.saveEditScope();

      expect(mocks.updateTowerPgWorkspaceScope).toHaveBeenCalledWith('workspace-1', 'scope-1', {
        name: 'Renamed scope',
        description: 'Updated',
      }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
      expect(mocks.upsertScope).toHaveBeenCalledWith(expect.objectContaining({ title: 'Renamed scope' }));
      expect(store.editingScopeId).toBeNull();
      expect(store.editingScopeError).toBe('');
    });

    it('keeps the PG rename draft open and reports an older Tower PATCH 404', async () => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      mocks.updateTowerPgWorkspaceScope.mockRejectedValueOnce(new Error('Tower request failed (404)'));
      const scope = { record_id: 'scope-1', title: 'Original scope', record_state: 'active', pg_can_manage: true };
      const store = createScopeStore({
        session: { npub: 'npub1owner' }, scopes: [scope], scopesMap: new Map([[scope.record_id, scope]]),
        editingScopeId: scope.record_id, editingScopeTitle: 'Renamed scope', editingScopeDescription: '',
        editingScopeAssignedGroupIds: [], editingScopeGroupQuery: '', editingScopeSaving: false,
        editingScopeError: '', scopePolicyRepairBusy: false, scopePolicyRepairSummary: '',
      });

      await store.saveEditScope();

      expect(store.scopes[0].title).toBe('Original scope');
      expect(store.editingScopeId).toBe('scope-1');
      expect(store.editingScopeError).toBe('Tower request failed (404)');
    });

    it('rejects blank PG scope names without calling Tower', async () => {
      mocks.isTowerPgBackendMode.mockReturnValue(true);
      const scope = { record_id: 'scope-1', title: 'Original scope', record_state: 'active', pg_can_manage: true };
      const store = createScopeStore({
        session: { npub: 'npub1owner' }, scopes: [scope], scopesMap: new Map([[scope.record_id, scope]]),
        editingScopeId: scope.record_id, editingScopeTitle: '   ', editingScopeDescription: '', editingScopeError: '',
      });

      await store.saveEditScope();

      expect(mocks.updateTowerPgWorkspaceScope).not.toHaveBeenCalled();
      expect(store.editingScopeError).toBe('Scope name is required.');
    });

    it('detects when editing scope groups differ from the stored scope groups', () => {
      const store = createScopeStore({
        editingScope: {
          record_id: 'scope-1',
          group_ids: ['group-a'],
        },
        editingScopeAssignedGroupIds: ['group-a', 'group-b'],
        getScopeShareGroupIds(scope) {
          return scope.group_ids || [];
        },
        resolveGroupId(groupId) {
          return groupId || null;
        },
      });

      expect(store.editingScopeHasGroupChanges).toBe(true);
    });

    it('reapplies current scope group crypto without opening the edit modal', async () => {
      const reencryptScopedRecordsForScope = vi.fn(async () => ({
        total: 2,
        message: 'Re-encrypted 2 scoped records (1 tasks, 1 docs, 0 folders, 0 flows, 0 approvals, 0 channels, 0 reports).',
      }));
      const flushAndBackgroundSync = vi.fn(async () => {});
      const scope = { record_id: 'scope-1', title: 'Websites', group_ids: ['group-a', 'group-b'] };
      const store = createScopeStore({
        scopePolicyRepairBusy: false,
        scopePolicyRepairSummary: 'Old summary',
        scopes: [scope],
        scopesMap: new Map([[scope.record_id, scope]]),
        reencryptScopedRecordsForScope,
        flushAndBackgroundSync,
      });

      await store.reapplyScopeGroupCrypto(scope.record_id);

      expect(reencryptScopedRecordsForScope).toHaveBeenCalledWith(scope, scope);
      expect(flushAndBackgroundSync).toHaveBeenCalledTimes(1);
      expect(store.scopePolicyRepairBusy).toBe(false);
      expect(store.scopePolicyRepairSummary).toBe('Websites: Re-encrypted 2 scoped records (1 tasks, 1 docs, 0 folders, 0 flows, 0 approvals, 0 channels, 0 reports).');
    });

    it('same-scope reapply uses legacy fallback instead of treating current groups as the previous scope policy', async () => {
      const scope = { record_id: 'scope-1', title: 'Websites', group_ids: ['group-new'] };
      const repairScopedDocumentRecord = vi.fn(async () => true);
      const store = createScopeStore({
        scopes: [scope],
        scopesMap: new Map([[scope.record_id, scope]]),
        documents: [{ record_id: 'doc-1', scope_id: 'scope-1', record_state: 'active' }],
        directories: [],
        tasks: [],
        flows: [],
        approvals: [],
        channels: [],
        reports: [],
        repairScopedDocumentRecord,
        repairScopedDirectoryRecord: vi.fn(async () => false),
        repairScopedTaskRecord: vi.fn(async () => false),
        repairScopedFlowRecord: vi.fn(async () => false),
        repairScopedApprovalRecord: vi.fn(async () => false),
        repairScopedChannelRecord: vi.fn(async () => false),
        repairScopedReportRecord: vi.fn(async () => false),
        getScopeShareGroupIds(currentScope) {
          return currentScope.group_ids || [];
        },
      });

      const summary = await store.reencryptScopedRecordsForScope(scope, scope);

      expect(repairScopedDocumentRecord).toHaveBeenCalledWith(
        expect.objectContaining({ record_id: 'doc-1' }),
        [],
        scope,
      );
      expect(summary.documents).toBe(1);
      expect(store.showScopeRepairModal).toBe(true);
      expect(store.scopeRepairSession.phase).toBe('done');
      expect(store.scopeRepairSession.rewrittenRecords).toBe(1);
      expect(store.scopeRepairProgress.find((family) => family.id === 'documents')).toMatchObject({
        status: 'done',
        total: 1,
        rewritten: 1,
      });
    });

    it('resolves unscoped doc scope from the nearest scoped parent folder', () => {
      const scope = { record_id: 'scope-1', title: 'Websites', group_ids: ['group-a'] };
      const parent = { record_id: 'dir-parent', scope_id: 'scope-1', parent_directory_id: null };
      const child = { record_id: 'dir-child', scope_id: null, parent_directory_id: 'dir-parent' };
      const store = createScopeStore({
        scopes: [scope],
        scopesMap: new Map([[scope.record_id, scope]]),
        directories: [parent, child],
      });

      expect(store.resolveLegacyDocScopeId(
        { record_id: 'doc-1', parent_directory_id: 'dir-child', scope_id: null },
        null,
        new Map([[parent.record_id, parent], [child.record_id, child]]),
      )).toBe('scope-1');
    });

    it('builds legacy doc assignment with scope groups as the write policy', () => {
      const scope = { record_id: 'scope-1', title: 'Websites', level: 'l1', group_ids: ['group-a'] };
      const store = createScopeStore({
        scopes: [scope],
        scopesMap: new Map([[scope.record_id, scope]]),
        groups: [{ group_id: 'group-a', name: 'Team' }],
        resolveGroupId(groupId) {
          return groupId || null;
        },
      });

      const patch = store.buildLegacyDocScopeAssignment({
        record_id: 'doc-1',
        shares: [{ type: 'group', key: 'group:group-b', group_id: 'group-b', access: 'read' }],
        group_ids: ['group-b'],
      }, 'scope-1');

      expect(patch).toMatchObject({
        scope_id: 'scope-1',
        scope_policy_group_ids: ['group-a'],
      });
      expect(patch.group_ids).toEqual(['group-a', 'group-b']);
    });
  });
});


describe('PG scope deletion', () => {
  function deletionStore(overrides = {}) {
    mocks.isTowerPgBackendMode.mockReturnValue(true);
    const scope = { record_id: 'scope-1', title: 'Scope', pg_can_manage: true };
    return createScopeStore({
      canAdminWorkspace: false, scopes: [scope], scopesMap: new Map([[scope.record_id, scope]]),
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }, { record_id: 'channel-2', scope_id: 'scope-2' }],
      selectedChannelId: 'channel-1', selectedBoardId: 'scope-1', messages: [{ record_id: 'message-1' }],
      closeThread: vi.fn(), openAllScopesOverview: vi.fn(), syncRoute: vi.fn(), ...overrides,
    });
  }

  it('allows a scope manager and removes archived channels and selected navigation only after Tower success', async () => {
    const store = deletionStore();
    await store.deleteScope('scope-1');
    expect(mocks.deleteTowerPgWorkspaceScope).toHaveBeenCalledWith('workspace-1', 'scope-1', expect.any(Object));
    // The service owns persistence; managers do not clear caches/outbox or
    // assign collections from command responses. Dexie projects the archive.
    expect(mocks.upsertScope).not.toHaveBeenCalled();
    expect(mocks.deleteChannelRuntimeState).not.toHaveBeenCalled();
    expect(store.channels).toHaveLength(2);
    await store.handlePgArchivedTargets([{ family: 'scope', id: 'scope-1' }]);
    expect(store.selectedChannelId).toBeNull();
    expect(store.openAllScopesOverview).toHaveBeenCalledOnce();
  });

  it('leaves records and navigation intact when Tower rejects deletion', async () => {
    mocks.deleteTowerPgWorkspaceScope.mockRejectedValueOnce(new Error('Denied by Tower'));
    const store = deletionStore();
    await store.deleteScope('scope-1');
    expect(store.error).toBe('Denied by Tower');
    expect(store.scopes).toHaveLength(1);
    expect(store.channels).toHaveLength(2);
    expect(store.selectedChannelId).toBe('channel-1');
    expect(mocks.deleteChannelRuntimeState).not.toHaveBeenCalled();
    expect(mocks.upsertScope).not.toHaveBeenCalled();
  });

  it('describes the archive cascade and cancel leaves data intact', async () => {
    const store = deletionStore();
    await store.confirmDeleteScope('scope-1');
    expect(store.scopeDeleteConfirmation).toEqual(expect.objectContaining({
      scopeId: 'scope-1',
      title: 'Scope',
      consequence: expect.stringContaining('scope and all its channels'),
    }));
    expect(mocks.deleteTowerPgWorkspaceScope).not.toHaveBeenCalled();
    store.cancelDeleteScope();
    expect(store.scopeDeleteConfirmation).toBeNull();
    expect(store.scopes).toHaveLength(1);
  });

  it('confirms deletion from the in-app prompt and reports success', async () => {
    const store = deletionStore();
    await store.confirmDeleteScope('scope-1');
    await store.confirmPendingScopeDelete();
    expect(mocks.deleteTowerPgWorkspaceScope).toHaveBeenCalledWith('workspace-1', 'scope-1', expect.any(Object));
    expect(store.scopeDeleteConfirmation).toBeNull();
    expect(store.scopeDeleteNotice).toContain('Archived scope "Scope"');
    expect(store.openAllScopesOverview).not.toHaveBeenCalled();
  });

  it('keeps the in-app prompt visible and reports Tower delete errors', async () => {
    mocks.deleteTowerPgWorkspaceScope.mockRejectedValueOnce(new Error('Denied by Tower'));
    const store = deletionStore();
    await store.confirmDeleteScope('scope-1');
    await store.confirmPendingScopeDelete();
    expect(store.scopeDeleteConfirmation).toEqual(expect.objectContaining({ scopeId: 'scope-1' }));
    expect(store.scopeDeleteError).toBe('Denied by Tower');
    expect(store.scopes).toHaveLength(1);
  });

  it('rejects unauthorized and protected scopes', async () => {
    const store = deletionStore({ canManageScope: () => false });
    await store.deleteScope('scope-1');
    expect(mocks.deleteTowerPgWorkspaceScope).not.toHaveBeenCalled();
    expect(store.error).toContain('permission');
    const admin = deletionStore({ canAdminWorkspace: true });
    for (const scope of [{ record_id: '__dm__' }, { record_id: 'system', pg_kind: 'system' }, { record_id: 'virtual', virtual: true }]) {
      expect(admin.canManageScope(scope)).toBe(false);
    }
  });
});
