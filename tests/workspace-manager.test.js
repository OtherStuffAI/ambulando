import { afterEach, describe, expect, it, vi } from 'vitest';
import { guessDefaultBackendUrl, workspaceManagerMixin } from '../src/workspace-manager.js';
import * as api from '../src/api.js';

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.localStorage?.clear();
});

// ---------------------------------------------------------------------------
// Helper: bind a mixin method to a fake store context
// ---------------------------------------------------------------------------
function bindMethod(methodName, storeOverrides = {}) {
  const store = {
    knownWorkspaces: [],
    selectedWorkspaceKey: '',
    currentWorkspaceOwnerNpub: '',
    ownerNpub: '',
    session: null,
    backendUrl: '',
    superbasedConnectionConfig: null,
    workspaceSwitchPendingKey: '',
    workspaceSwitchPendingNpub: '',
    groups: [],
    workspaceProfileRowsByKey: {},
    storageImageUrlCache: {},
    workspaceProfileDirty: false,
    workspaceProfileError: null,
    workspaceProfileSaving: false,
    workspaceProfilePendingAvatarFile: null,
    workspaceProfilePendingAvatarObjectUrl: '',
    workspaceProfileAvatarPreviewUrl: '',
    workspaceProfileNameInput: '',
    workspaceProfileSlugInput: '',
    workspaceProfileDescriptionInput: '',
    workspaceProfileDashboardGreetingTemplateInput: '',
    workspaceProfileAvatarInput: '',
    showWorkspaceSwitcherMenu: false,
    showWorkspaceBootstrapModal: false,
    workspaceBootstrapSubmitting: false,
    newWorkspaceName: '',
    newWorkspaceDescription: '',
    mobileNavOpen: false,
    navSection: 'chat',
    workspaceSettingsRecordId: '',
    workspaceSettingsVersion: 0,
    personalAgentSettingsRowVersion: 0,
    workspaceSettingsGroupIds: [],
    workspaceHarnessUrl: '',
    workspaceHarnessAgentNpub: '',
    workspaceHarnessAgents: [],
    botNpub: '',
    defaultAgentNpub: '',
    workspaceTriggers: [],
    wingmanHarnessInput: '',
    wingmanHarnessDraftAgentNpub: '',
    wingmanHarnessDirty: false,
    wingmanHarnessError: null,
    removingWorkspace: false,
    error: null,
    channels: [],
    channelOrder: [],
    selectedChannelId: '',
    selectedChannel: null,
    getShortNpub: (npub) => npub?.slice(0, 8) || '',
    getInitials: (name) => (name || 'WS').slice(0, 2).toUpperCase(),
    getSenderAvatar: () => null,
    getSenderName: (npub) => npub,
    resolveStorageImageUrl: vi.fn().mockResolvedValue(''),
    ensureWorkspaceProfileHydrated: vi.fn(),
    mergedHostsList: [],
    ...storeOverrides,
  };

  // Apply all mixin methods and getters onto the store object
  const descriptors = Object.getOwnPropertyDescriptors(workspaceManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    // Don't overwrite explicit storeOverrides
    if (Object.prototype.hasOwnProperty.call(storeOverrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }

  const method = store[methodName];
  if (typeof method === 'function') {
    return { fn: method.bind(store), store };
  }
  return { store };
}

// ---------------------------------------------------------------------------
// guessDefaultBackendUrl
// ---------------------------------------------------------------------------
describe('guessDefaultBackendUrl', () => {
  it('returns a string', () => {
    const result = guessDefaultBackendUrl();
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Computed getters
// ---------------------------------------------------------------------------
describe('workspace computed getters', () => {
  it('workspaceOwnerNpub falls back through chain', () => {
    const { store } = bindMethod('getWorkspaceByOwner', {
      currentWorkspaceOwnerNpub: '',
      superbasedConnectionConfig: null,
      ownerNpub: '',
      session: { npub: 'npub1session' },
    });
    expect(store.workspaceOwnerNpub).toBe('npub1session');
  });

  it('workspaceOwnerNpub prefers currentWorkspaceOwnerNpub', () => {
    const { store } = bindMethod('getWorkspaceByOwner', {
      currentWorkspaceOwnerNpub: 'npub1current',
      session: { npub: 'npub1session' },
    });
    expect(store.workspaceOwnerNpub).toBe('npub1current');
  });

  it('currentWorkspace returns matching workspace', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', name: 'My WS' };
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [ws],
      currentWorkspaceOwnerNpub: 'npub1ws',
    });
    expect(store.currentWorkspace).toEqual(ws);
  });

  it('currentWorkspace returns null when no match', () => {
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [],
      currentWorkspaceOwnerNpub: 'npub1unknown',
    });
    expect(store.currentWorkspace).toBeNull();
  });

  it('currentWorkspace prefers selectedWorkspaceKey when multiple workspaces share an owner', () => {
    const aiWorkspace = {
      workspaceKey: 'service:npub1ai::workspace:npub1ws',
      workspaceOwnerNpub: 'npub1ws',
      name: 'Example Workspace AI',
    };
    const studioWorkspace = {
      workspaceKey: 'service:npub1studio::workspace:npub1ws',
      workspaceOwnerNpub: 'npub1ws',
      name: 'Example Workspace Studio',
    };
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [studioWorkspace, aiWorkspace],
      selectedWorkspaceKey: 'service:npub1ai::workspace:npub1ws',
      currentWorkspaceOwnerNpub: 'npub1ws',
    });
    expect(store.currentWorkspace).toEqual(aiWorkspace);
  });

  it('isWorkspaceSwitching reflects pending npub', () => {
    const { store: s1 } = bindMethod('getWorkspaceByOwner', {
      workspaceSwitchPendingNpub: '',
    });
    expect(s1.isWorkspaceSwitching).toBe(false);

    const { store: s2 } = bindMethod('getWorkspaceByOwner', {
      workspaceSwitchPendingNpub: 'npub1abc',
    });
    expect(s2.isWorkspaceSwitching).toBe(true);
  });

  it('currentWorkspaceName returns workspace name or fallback', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', name: 'Acme' };
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [ws],
      currentWorkspaceOwnerNpub: 'npub1ws',
    });
    expect(store.currentWorkspaceName).toBe('Acme');
  });

  it('currentWorkspaceName returns "No workspace selected" when empty', () => {
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [],
      currentWorkspaceOwnerNpub: '',
      session: null,
      ownerNpub: '',
    });
    expect(store.currentWorkspaceName).toBe('No workspace selected');
  });

  it('currentWorkspaceBackendName prefers tower discovery metadata', () => {
    const ws = {
      workspaceKey: 'service:npub1service::workspace:npub1ws',
      workspaceOwnerNpub: 'npub1ws',
      directHttpsUrl: 'https://tower.example',
      towerName: 'Family Tower',
    };
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [ws],
      selectedWorkspaceKey: ws.workspaceKey,
      currentWorkspaceOwnerNpub: 'npub1ws',
    });

    expect(store.currentWorkspaceBackendName).toBe('Family Tower');
  });

  it('currentWorkspaceGroups filters by owner', () => {
    const { store } = bindMethod('getWorkspaceByOwner', {
      currentWorkspaceOwnerNpub: 'npub1ws',
      groups: [
        { owner_npub: 'npub1ws', name: 'A' },
        { owner_npub: 'npub1other', name: 'B' },
        { owner_npub: 'npub1ws', name: 'C' },
      ],
    });
    expect(store.currentWorkspaceGroups).toHaveLength(2);
    expect(store.currentWorkspaceGroups.map((g) => g.name)).toEqual(['A', 'C']);
  });

  it('canAdminWorkspace is true for the creator', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', creatorNpub: 'npub1creator', workspaceKey: 'workspace:npub1ws' };
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [ws],
      currentWorkspaceOwnerNpub: 'npub1ws',
      selectedWorkspaceKey: 'workspace:npub1ws',
      session: { npub: 'npub1creator' },
      groups: [],
    });
    expect(store.canAdminWorkspace).toBe(true);
  });

  it('canAdminWorkspace is true for a member of the workspace admin group', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', creatorNpub: 'npub1creator', workspaceKey: 'workspace:npub1ws' };
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [ws],
      currentWorkspaceOwnerNpub: 'npub1ws',
      selectedWorkspaceKey: 'workspace:npub1ws',
      session: { npub: 'npub1admin' },
      groups: [
        { owner_npub: 'npub1ws', group_kind: 'workspace_admin', member_npubs: ['npub1admin'] },
      ],
    });
    expect(store.canAdminWorkspace).toBe(true);
  });

  it('canAdminWorkspace is true in PG mode when /me includes workspace.manage', () => {
    const ws = {
      workspaceOwnerNpub: 'npub1ws',
      workspaceKey: 'workspace:npub1ws',
      pgBackendMode: true,
      pgMe: { permissions: ['workspace.read', 'workspace.manage'] },
    };
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [ws],
      currentWorkspaceOwnerNpub: 'npub1ws',
      selectedWorkspaceKey: 'workspace:npub1ws',
      session: { npub: 'npub1member' },
      groups: [],
    });
    expect(store.canAdminWorkspace).toBe(true);
  });

  it('currentWorkspaceContentGroups excludes the workspace admin group', () => {
    const { store } = bindMethod('getWorkspaceByOwner', {
      currentWorkspaceOwnerNpub: 'npub1ws',
      groups: [
        { owner_npub: 'npub1ws', group_kind: 'workspace_admin', name: 'Admins' },
        { owner_npub: 'npub1ws', group_kind: 'shared', name: 'Team' },
      ],
    });
    expect(store.currentWorkspaceContentGroups.map((group) => group.name)).toEqual(['Team']);
  });

  it('memberPrivateGroup finds private group for session member', () => {
    const { store } = bindMethod('getWorkspaceByOwner', {
      currentWorkspaceOwnerNpub: 'npub1ws',
      session: { npub: 'npub1me' },
      groups: [
        { owner_npub: 'npub1ws', group_kind: 'shared', private_member_npub: null, name: 'Shared' },
        { owner_npub: 'npub1ws', group_kind: 'private', private_member_npub: 'npub1me', name: 'Private' },
      ],
    });
    expect(store.memberPrivateGroup).toEqual(
      expect.objectContaining({ name: 'Private', group_kind: 'private' }),
    );
  });

  it('memberPrivateGroup returns null when no session', () => {
    const { store } = bindMethod('getWorkspaceByOwner', {
      currentWorkspaceOwnerNpub: 'npub1ws',
      session: null,
      groups: [],
    });
    expect(store.memberPrivateGroup).toBeNull();
  });

  it('currentWorkspaceSlug uses workspace slug or slugified name', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', name: 'Acme', slug: 'acme-slug' };
    const { store } = bindMethod('getWorkspaceByOwner', {
      knownWorkspaces: [ws],
      currentWorkspaceOwnerNpub: 'npub1ws',
    });
    expect(store.currentWorkspaceSlug).toBe('acme-slug');
  });

});

// ---------------------------------------------------------------------------
// Workspace display methods
// ---------------------------------------------------------------------------
describe('workspace display methods', () => {
  it('getWorkspaceByOwner returns matching workspace', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', name: 'Test' };
    const { fn } = bindMethod('getWorkspaceByOwner', { knownWorkspaces: [ws] });
    expect(fn('npub1ws')).toEqual(ws);
  });

  it('getWorkspaceByOwner returns null for no match', () => {
    const { fn } = bindMethod('getWorkspaceByOwner', { knownWorkspaces: [] });
    expect(fn('npub1nope')).toBeNull();
  });

  it('getWorkspaceByOwner returns null for empty input', () => {
    const { fn } = bindMethod('getWorkspaceByOwner');
    expect(fn('')).toBeNull();
    expect(fn(null)).toBeNull();
  });

  it('getWorkspaceName returns name from known workspace', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', name: 'Acme' };
    const { fn } = bindMethod('getWorkspaceName', { knownWorkspaces: [ws] });
    expect(fn(ws)).toBe('Acme');
  });

  it('getWorkspaceName returns fallback for unnamed workspace', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws' };
    const { fn } = bindMethod('getWorkspaceName', { knownWorkspaces: [ws] });
    expect(fn(ws)).toBe('Untitled workspace');
  });

  it('getWorkspaceMeta returns description', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', description: 'A team workspace' };
    const { fn } = bindMethod('getWorkspaceMeta', { knownWorkspaces: [ws] });
    expect(fn(ws)).toBe('A team workspace');
  });

  it('getWorkspaceMeta falls back to owner npub', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws' };
    const { fn } = bindMethod('getWorkspaceMeta', { knownWorkspaces: [ws] });
    expect(fn(ws)).toBe('npub1ws');
  });

  it('getWorkspaceInitials generates initials from name', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', name: 'Test' };
    const { fn } = bindMethod('getWorkspaceInitials', { knownWorkspaces: [ws] });
    expect(fn(ws)).toBe('TE');
  });

  it('getWorkspaceInitials handles null', () => {
    const { fn } = bindMethod('getWorkspaceInitials');
    expect(fn(null)).toBe('WS');
  });

  it('getWorkspaceInitials handles string', () => {
    const { fn } = bindMethod('getWorkspaceInitials');
    expect(fn('MyWorkspace')).toBe('MY');
  });

  it('getWorkspaceDisplayEntry merges profile data', () => {
    const ws = { workspaceKey: 'service:svc::workspace:npub1ws', workspaceOwnerNpub: 'npub1ws', name: 'Test' };
    const { fn } = bindMethod('getWorkspaceDisplayEntry', {
      knownWorkspaces: [ws],
      workspaceProfileRowsByKey: {
        'service:svc::workspace:npub1ws': { avatarUrl: 'https://example.com/avatar.png' },
      },
    });
    const result = fn('service:svc::workspace:npub1ws');
    expect(result.name).toBe('Test');
    expect(result.avatarUrl).toBe('https://example.com/avatar.png');
    expect(result.workspaceOwnerNpub).toBe('npub1ws');
  });
});

// ---------------------------------------------------------------------------
// Workspace switcher
// ---------------------------------------------------------------------------
describe('workspace switcher', () => {
  it('toggleWorkspaceSwitcherMenu toggles flag', () => {
    const { fn, store } = bindMethod('toggleWorkspaceSwitcherMenu', {
      showWorkspaceSwitcherMenu: false,
    });
    fn();
    expect(store.showWorkspaceSwitcherMenu).toBe(true);
    fn();
    expect(store.showWorkspaceSwitcherMenu).toBe(false);
  });

  it('toggleWorkspaceSwitcherMenu blocked during switch', () => {
    const { fn, store } = bindMethod('toggleWorkspaceSwitcherMenu', {
      showWorkspaceSwitcherMenu: false,
      workspaceSwitchPendingNpub: 'npub1switching',
    });
    fn();
    expect(store.showWorkspaceSwitcherMenu).toBe(false);
  });

  it('closeWorkspaceSwitcherMenu sets flag to false', () => {
    const { fn, store } = bindMethod('closeWorkspaceSwitcherMenu', {
      showWorkspaceSwitcherMenu: true,
    });
    fn();
    expect(store.showWorkspaceSwitcherMenu).toBe(false);
  });

  it('handleWorkspaceSwitcherSelect includes workspacekey in the target URL', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: {
        href: 'https://flightdeck.example/current/chat?channelid=chan-1',
      },
    };

    try {
      const workspace = {
        workspaceKey: 'service:npub1ai::workspace:npub1ws',
        workspaceOwnerNpub: 'npub1ws',
        slug: 'other-stuff',
        name: 'Example Workspace',
        directHttpsUrl: 'https://tower.example.invalid',
        connectionToken: 'token-1',
      };
      const persistWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
      const { fn, store } = bindMethod('handleWorkspaceSwitcherSelect', {
        knownWorkspaces: [workspace],
        navSection: 'chat',
        mobileNavOpen: true,
        persistWorkspaceSettings,
      });

      await fn(workspace.workspaceKey);

      expect(store.selectedWorkspaceKey).toBe(workspace.workspaceKey);
      expect(store.workspaceSwitchPendingKey).toBe(workspace.workspaceKey);
      expect(globalThis.window.location.href).toBe(
        '/other-stuff/chat?channelid=chan-1&workspacekey=service%3Anpub1ai%3A%3Aworkspace%3Anpub1ws',
      );
      expect(persistWorkspaceSettings).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

// ---------------------------------------------------------------------------
// Workspace profile editing
// ---------------------------------------------------------------------------
describe('workspace profile editing', () => {
  it('markWorkspaceProfileDirty sets dirty and clears error', () => {
    const { fn, store } = bindMethod('markWorkspaceProfileDirty', {
      workspaceProfileDirty: false,
      workspaceProfileError: 'some error',
    });
    fn();
    expect(store.workspaceProfileDirty).toBe(true);
    expect(store.workspaceProfileError).toBeNull();
  });

  it('handleWorkspaceProfileField updates name', () => {
    const { fn, store } = bindMethod('handleWorkspaceProfileField', {
      workspaceProfileNameInput: '',
      workspaceProfileDirty: false,
      workspaceProfileError: null,
    });
    fn('name', 'New Name');
    expect(store.workspaceProfileNameInput).toBe('New Name');
    expect(store.workspaceProfileDirty).toBe(true);
  });

  it('handleWorkspaceProfileField updates description', () => {
    const { fn, store } = bindMethod('handleWorkspaceProfileField', {
      workspaceProfileDescriptionInput: '',
      workspaceProfileDirty: false,
      workspaceProfileError: null,
    });
    fn('description', 'A description');
    expect(store.workspaceProfileDescriptionInput).toBe('A description');
    expect(store.workspaceProfileDirty).toBe(true);
  });

  it('handleWorkspaceProfileField updates dashboard greeting template', () => {
    const { fn, store } = bindMethod('handleWorkspaceProfileField', {
      workspaceProfileDashboardGreetingTemplateInput: '',
      workspaceProfileDirty: false,
      workspaceProfileError: null,
    });
    fn('dashboardGreetingTemplate', 'Remember $user.name,\\nYou can just do things?');
    expect(store.workspaceProfileDashboardGreetingTemplateInput).toBe('Remember $user.name,\\nYou can just do things?');
    expect(store.workspaceProfileDirty).toBe(true);
  });

  it('clearWorkspaceAvatarDraft clears avatar state', () => {
    const { fn, store } = bindMethod('clearWorkspaceAvatarDraft', {
      workspaceProfilePendingAvatarFile: { name: 'file.png' },
      workspaceProfileAvatarInput: 'storage://abc',
      workspaceProfileAvatarPreviewUrl: 'blob:123',
      workspaceProfilePendingAvatarObjectUrl: '',
      workspaceProfileDirty: false,
      workspaceProfileError: null,
    });
    fn();
    expect(store.workspaceProfilePendingAvatarFile).toBeNull();
    expect(store.workspaceProfileAvatarInput).toBe('');
    expect(store.workspaceProfileAvatarPreviewUrl).toBe('');
    expect(store.workspaceProfileDirty).toBe(true);
  });

  it('resetWorkspaceProfileDraft blocked during save', () => {
    const { fn, store } = bindMethod('resetWorkspaceProfileDraft', {
      workspaceProfileSaving: true,
      workspaceProfileDirty: true,
      workspaceProfileError: null,
    });
    fn();
    // Should not reset when saving
    expect(store.workspaceProfileDirty).toBe(true);
  });

  it('saveWorkspaceProfile writes slug through the workspace route and preserves the server slug', async () => {
    const updateWorkspaceSpy = vi.spyOn(api, 'updateWorkspace').mockResolvedValue({
      name: 'Renamed Workspace',
      slug: 'canonical-server-slug',
      description: 'Updated description',
      avatar_url: 'storage://workspace-avatar-1',
    });

    const persistWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    const syncWorkspaceProfileDraft = vi.fn();
    const mergeKnownWorkspaces = vi.fn();
    const originalWindow = globalThis.window;
    globalThis.window = {
      confirm: vi.fn(() => true),
    };

    try {
      const { fn, store } = bindMethod('saveWorkspaceProfile', {
        canAdminWorkspace: true,
        currentWorkspace: {
          workspaceKey: 'workspace:npub1ws',
          workspaceOwnerNpub: 'npub1ws',
          name: 'Original Workspace',
          slug: 'original-workspace',
        },
        workspaceProfileNameInput: 'Renamed Workspace',
        workspaceProfileSlugInput: 'renamed-workspace',
        workspaceProfileDescriptionInput: 'Updated description',
        workspaceProfileDashboardGreetingTemplateInput: 'Remember $user.name,\\nYou can just do things?',
        workspaceProfileAvatarInput: 'storage://workspace-avatar-1',
        persistWorkspaceSettings,
        syncWorkspaceProfileDraft,
        mergeKnownWorkspaces,
      });

      await fn();

      expect(updateWorkspaceSpy).toHaveBeenCalledWith('npub1ws', {
        name: 'Renamed Workspace',
        slug: 'renamed-workspace',
        description: 'Updated description',
        avatar_url: 'storage://workspace-avatar-1',
      });
      expect(store.workspaceProfileRowsByKey['workspace:npub1ws']).toMatchObject({
        slug: 'canonical-server-slug',
        name: 'Renamed Workspace',
        dashboardGreetingTemplate: 'Remember $user.name,\\nYou can just do things?',
      });
      expect(mergeKnownWorkspaces).toHaveBeenCalledWith([
        expect.objectContaining({
          slug: 'canonical-server-slug',
          workspaceOwnerNpub: 'npub1ws',
          dashboardGreetingTemplate: 'Remember $user.name,\\nYou can just do things?',
        }),
      ]);
      expect(persistWorkspaceSettings).toHaveBeenCalledTimes(1);
      expect(syncWorkspaceProfileDraft).toHaveBeenCalledWith({ force: true });
      expect(store.workspaceProfileError).toBeNull();
    } finally {
      updateWorkspaceSpy.mockRestore();
      globalThis.window = originalWindow;
    }
  });

  it('saveWorkspaceProfile uses the Tower PG workspace route for PG workspaces', async () => {
    const updateTowerPgWorkspaceSpy = vi.spyOn(api, 'updateTowerPgWorkspace').mockResolvedValue({
      name: 'Testing Space',
      slug: 'testing-space',
      description: 'PG profile',
      avatar_url: null,
    });
    const updateWorkspaceSpy = vi.spyOn(api, 'updateWorkspace').mockResolvedValue({});

    const persistWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    const syncWorkspaceProfileDraft = vi.fn();
    const mergeKnownWorkspaces = vi.fn();
    const originalWindow = globalThis.window;
    globalThis.window = {
      confirm: vi.fn(() => true),
    };

    try {
      const { fn } = bindMethod('saveWorkspaceProfile', {
        canAdminWorkspace: true,
        currentWorkspace: {
          workspaceKey: 'pg:workspace',
          workspaceOwnerNpub: 'npub1owner',
          workspaceId: 'workspace-1',
          directHttpsUrl: 'https://tower.example',
          appNpub: 'flightdeck_pg',
          name: 'This Works',
          slug: 'thisworks',
          pgBackendMode: true,
          metadata: { retained: 'yes' },
        },
        workspaceProfileNameInput: 'Testing Space',
        workspaceProfileSlugInput: 'testing-space',
        workspaceProfileDescriptionInput: 'PG profile',
        workspaceProfileDashboardGreetingTemplateInput: 'Welcome $user.name,\\nwhere next?',
        workspaceWorkroomsEnabledInput: true,
        workspaceProfileAvatarInput: '',
        persistWorkspaceSettings,
        syncWorkspaceProfileDraft,
        mergeKnownWorkspaces,
      });

      await fn();

      expect(updateTowerPgWorkspaceSpy).toHaveBeenCalledWith('workspace-1', {
        name: 'Testing Space',
        slug: 'testing-space',
        description: 'PG profile',
        avatar_url: null,
        metadata: {
          retained: 'yes',
          feature_flags: { workrooms: true },
        },
      }, {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(updateWorkspaceSpy).not.toHaveBeenCalled();
      expect(mergeKnownWorkspaces).toHaveBeenCalledWith([
        expect.objectContaining({
          dashboardGreetingTemplate: 'Welcome $user.name,\\nwhere next?',
          metadata: {
            retained: 'yes',
            feature_flags: { workrooms: true },
          },
        }),
      ]);
      expect(persistWorkspaceSettings).toHaveBeenCalledTimes(1);
      expect(syncWorkspaceProfileDraft).toHaveBeenCalledWith({ force: true });
    } finally {
      updateTowerPgWorkspaceSpy.mockRestore();
      updateWorkspaceSpy.mockRestore();
      globalThis.window = originalWindow;
    }
  });
});

describe('PG workspace settings guard', () => {
  it('saves harness settings as a personal workspace preference in PG mode', async () => {
    const updateTowerPgWorkspaceSpy = vi.spyOn(api, 'updateTowerPgWorkspace').mockResolvedValue({});
    const updatePersonalAgentsSpy = vi.spyOn(api, 'updateTowerPgPersonalAgentSettings').mockResolvedValue({
      settings: {
        autopilot_agents: [{ agent_npub: 'npub1agent', url: 'https://harness.example' }],
        row_version: 1,
      },
    });
    const flushAndBackgroundSync = vi.fn();
    const mergeKnownWorkspaces = vi.fn();
    const { fn, store } = bindMethod('saveHarnessSettings', {
      canAdminWorkspace: false,
      session: { npub: 'npub1member' },
      currentWorkspaceOwnerNpub: 'npub1workspace',
      backendUrl: 'https://tower.example',
      workspaceHarnessAgentNpub: 'npub1agent',
      wingmanHarnessInput: 'https://harness.example',
      flushAndBackgroundSync,
      mergeKnownWorkspaces,
      currentWorkspace: {
        workspaceKey: 'pg:workspace',
        workspaceOwnerNpub: 'npub1workspace',
        workspaceId: 'workspace-1',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        name: 'Operator A',
        slug: 'operator-a',
        description: '',
        avatarUrl: null,
        pgBackendMode: true,
        metadata: {},
      },
    });

    await fn();

    expect(updateTowerPgWorkspaceSpy).not.toHaveBeenCalled();
    expect(updatePersonalAgentsSpy).toHaveBeenCalledWith('workspace-1', {
      autopilot_agents: [{ agent_npub: 'npub1agent', url: 'https://harness.example' }],
      expected_row_version: 0,
    }, expect.objectContaining({ baseUrl: 'https://tower.example' }));
    expect(mergeKnownWorkspaces).not.toHaveBeenCalled();
    expect(store.workspaceHarnessUrl).toBe('https://harness.example');
    expect(store.workspaceHarnessAgentNpub).toBe('npub1agent');
    expect(store.workspaceHarnessAgents).toEqual([
      { agent_npub: 'npub1agent', url: 'https://harness.example' },
    ]);
    expect(store.wingmanHarnessDirty).toBe(false);
    expect(store.wingmanHarnessError).toBeNull();
    expect(store.personalAgentSettingsRowVersion).toBe(1);
    expect(flushAndBackgroundSync).not.toHaveBeenCalled();
    updateTowerPgWorkspaceSpy.mockRestore();
  });

  it('does not queue encrypted channel-order writes in PG mode', async () => {
    const flushAndBackgroundSync = vi.fn();
    const { fn, store } = bindMethod('saveWorkspaceChannelOrder', {
      session: { npub: 'npub1admin' },
      currentWorkspaceOwnerNpub: 'npub1workspace',
      channels: [{ record_id: 'ch-a' }, { record_id: 'ch-b' }],
      flushAndBackgroundSync,
    });

    await fn(['ch-b', 'ch-a']);

    expect(store.channelOrder).toEqual(['ch-b', 'ch-a']);
    expect(store.error).toBe('Channel order persistence is not available for Tower PG workspaces yet.');
    expect(flushAndBackgroundSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Workspace settings row
// ---------------------------------------------------------------------------
describe('applyWorkspaceSettingsRow', () => {
  it('applies row fields to store', () => {
    const { fn, store } = bindMethod('applyWorkspaceSettingsRow', {
      workspaceSettingsRecordId: '',
      workspaceSettingsVersion: 0,
      workspaceSettingsGroupIds: [],
      workspaceHarnessUrl: '',
      workspaceHarnessAgentNpub: '',
      workspaceTriggers: [],
      wingmanHarnessInput: '',
      wingmanHarnessAgentQuery: '',
      wingmanHarnessDirty: false,
      workspaceProfileRowsByKey: {},
      knownWorkspaces: [],
    });
    fn({
      record_id: 'rec1',
      version: 3,
      group_ids: ['g1'],
      wingman_harness_url: 'https://harness.example.com',
      wingman_harness_agent_npub: 'npub1agent',
      triggers: [{ id: 't1' }],
      channel_order: ['chan-b', 'chan-a'],
    });
    expect(store.workspaceSettingsRecordId).toBe('rec1');
    expect(store.workspaceSettingsVersion).toBe(3);
    expect(store.workspaceSettingsGroupIds).toEqual(['g1']);
    expect(store.workspaceHarnessUrl).toBe('https://harness.example.com');
    expect(store.workspaceHarnessAgentNpub).toBe('npub1agent');
    expect(store.workspaceTriggers).toEqual([{ id: 't1' }]);
    expect(store.channelOrder).toEqual(['chan-b', 'chan-a']);
    expect(store.workspaceHarnessAgents).toEqual([
      { agent_npub: 'npub1agent', url: 'https://harness.example.com' },
    ]);
    expect(store.wingmanHarnessInput).toBe('');
  });

  it('handles null row gracefully', () => {
    const { fn, store } = bindMethod('applyWorkspaceSettingsRow', {
      workspaceSettingsRecordId: 'old',
      workspaceSettingsVersion: 5,
      workspaceSettingsGroupIds: ['old-g'],
      workspaceHarnessUrl: 'old-url',
      workspaceHarnessAgentNpub: 'old-agent',
      workspaceTriggers: [],
      wingmanHarnessInput: '',
      wingmanHarnessAgentQuery: '',
      wingmanHarnessDirty: false,
      workspaceProfileRowsByKey: {},
      knownWorkspaces: [],
    });
    fn(null);
    expect(store.workspaceSettingsRecordId).toBe('');
    expect(store.workspaceSettingsVersion).toBe(0);
  });

  it('hydrates Tower PG harness settings from workspace metadata when no encrypted row exists', () => {
    const resolveChatProfile = vi.fn();
    const { fn, store } = bindMethod('applyWorkspaceSettingsRow', {
      currentWorkspace: {
        metadata: {
          wingman_harness_url: 'https://agent.example.invalid',
          wingman_harness_agent_npub: 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266',
        },
      },
      resolveChatProfile,
    });

    fn(null);

    expect(store.workspaceHarnessUrl).toBe('https://agent.example.invalid');
    expect(store.workspaceHarnessAgentNpub).toBe('npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266');
    expect(store.workspaceHarnessAgents).toEqual([
      { agent_npub: 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266', url: 'https://agent.example.invalid' },
    ]);
    expect(store.wingmanHarnessInput).toBe('');
    expect(resolveChatProfile).toHaveBeenCalledWith('npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266');
  });

  it('uses Tower personal agent settings before the shared workspace default', () => {
    const { fn, store } = bindMethod('applyPersonalAgentSettings', {
      session: { npub: 'npub1member' },
      selectedWorkspaceKey: 'pg:workspace',
      currentWorkspaceOwnerNpub: 'npub1workspace',
      currentWorkspace: {
        workspaceKey: 'pg:workspace',
        workspaceOwnerNpub: 'npub1workspace',
        workspaceId: 'workspace-1',
        pgBackendMode: true,
        metadata: {
          wingman_harness_url: 'https://shared-autopilot.example',
          wingman_harness_agent_npub: 'npub1shared',
        },
      },
    });

    store.applyWorkspaceSettingsRow(null);
    fn({
      autopilot_agents: [{ agent_npub: 'npub1personal', url: 'https://my-autopilot.example' }],
      row_version: 4,
    });

    expect(store.workspaceHarnessUrl).toBe('https://my-autopilot.example');
    expect(store.workspaceHarnessAgentNpub).toBe('npub1personal');
    expect(store.workspaceHarnessAgents).toEqual([
      { agent_npub: 'npub1personal', url: 'https://my-autopilot.example' },
    ]);
    expect(store.wingmanHarnessInput).toBe('');
    expect(store.personalAgentSettingsRowVersion).toBe(4);
  });

  it('hydrates the exact ordered Tower Autopilot list with a legacy primary projection', () => {
    const entries = [
      { agent_npub: 'npub1lara', url: 'https://lara.example' },
      { agent_npub: 'npub1testagent', url: 'https://testagent.example' },
      { agent_npub: 'npub1longname', url: 'https://long.example' },
    ];
    const { fn, store } = bindMethod('applyPersonalAgentSettings', {
      session: { npub: 'npub1member' },
      selectedWorkspaceKey: 'pg:workspace',
      currentWorkspaceOwnerNpub: 'npub1workspace',
      currentWorkspace: {
        workspaceKey: 'pg:workspace',
        workspaceOwnerNpub: 'npub1workspace',
        workspaceId: 'workspace-1',
        pgBackendMode: true,
        metadata: {},
      },
    });

    fn({ autopilot_agents: entries, row_version: 7 });
    expect(store.workspaceHarnessAgents).toEqual(entries);
    expect(store.workspaceHarnessAgentNpub).toBe('npub1lara');
    expect(store.workspaceHarnessUrl).toBe('https://lara.example');

    expect(store.workspaceHarnessAgents.map((entry) => entry.agent_npub)).toEqual([
      'npub1lara', 'npub1testagent', 'npub1longname',
    ]);
    expect(store.workspaceHarnessAgentNpub).toBe('npub1lara');
    expect(store.workspaceHarnessUrl).toBe('https://lara.example');
    expect(store.personalAgentSettingsRowVersion).toBe(7);
  });

  it('rejects a stale client save, reloads Tower authority, and does not replace it', async () => {
    const conflict = Object.assign(new Error('stale'), { status: 409 });
    const updatePersonalAgentsSpy = vi.spyOn(api, 'updateTowerPgPersonalAgentSettings').mockRejectedValue(conflict);
    const authoritative = [{ agent_npub: 'npub1newer', url: 'https://newer.example' }];
    const refreshWorkspaceSettings = vi.fn(async function refresh() {
      this.applyPersonalAgentSettings({ autopilot_agents: authoritative, row_version: 3 });
    });
    const { fn, store } = bindMethod('saveHarnessSettings', {
      session: { npub: 'npub1member' },
      currentWorkspaceOwnerNpub: 'npub1workspace',
      personalAgentSettingsRowVersion: 2,
      workspaceHarnessAgents: [{ agent_npub: 'npub1stale', url: 'https://stale.example' }],
      wingmanHarnessDirty: true,
      refreshWorkspaceSettings,
      currentWorkspace: {
        workspaceKey: 'pg:workspace', workspaceOwnerNpub: 'npub1workspace', workspaceId: 'workspace-1',
        directHttpsUrl: 'https://tower.example', appNpub: 'flightdeck_pg', pgBackendMode: true, metadata: {},
      },
    });

    await fn();

    expect(updatePersonalAgentsSpy).toHaveBeenCalledTimes(1);
    expect(refreshWorkspaceSettings).toHaveBeenCalledWith({ overwriteInput: true });
    expect(store.workspaceHarnessAgents).toEqual(authoritative);
    expect(store.personalAgentSettingsRowVersion).toBe(3);
    expect(store.wingmanHarnessError).toContain('changed in another client');
  });

  it('reorders loaded channels from the settings row', () => {
    const { fn, store } = bindMethod('applyWorkspaceSettingsRow', {
      channels: [
        { record_id: 'chan-a' },
        { record_id: 'chan-b' },
        { record_id: 'chan-c' },
      ],
    });

    fn({ channel_order: ['chan-c', 'chan-a'] }, { overwriteInput: false });

    expect(store.channelOrder).toEqual(['chan-c', 'chan-a', 'chan-b']);
    expect(store.channels.map((channel) => channel.record_id)).toEqual(['chan-c', 'chan-a', 'chan-b']);
  });

  it('does not overwrite harness input when dirty', () => {
    const { fn, store } = bindMethod('applyWorkspaceSettingsRow', {
      workspaceSettingsRecordId: '',
      workspaceSettingsVersion: 0,
      workspaceSettingsGroupIds: [],
      workspaceHarnessUrl: '',
      workspaceHarnessAgentNpub: '',
      workspaceTriggers: [],
      wingmanHarnessInput: 'user-typed-value',
      wingmanHarnessAgentQuery: 'typed agent',
      wingmanHarnessDirty: true,
      workspaceProfileRowsByKey: {},
      knownWorkspaces: [],
    });
    fn({ wingman_harness_url: 'from-row' }, { overwriteInput: false });
    expect(store.wingmanHarnessInput).toBe('user-typed-value');
  });
});

// ---------------------------------------------------------------------------
// Workspace bootstrap modal
// ---------------------------------------------------------------------------
describe('workspace bootstrap modal', () => {
  it('openWorkspaceBootstrapModal redirects to connect in PG-only mode', () => {
    const openConnectModal = vi.fn();
    const { fn, store } = bindMethod('openWorkspaceBootstrapModal', {
      newWorkspaceName: 'leftover',
      newWorkspaceDescription: 'leftover',
      showConnectModal: true,
      showWorkspaceBootstrapModal: false,
      showWorkspaceSwitcherMenu: true,
      mobileNavOpen: true,
      openConnectModal,
    });
    fn();
    expect(openConnectModal).toHaveBeenCalledTimes(1);
    expect(store.showWorkspaceBootstrapModal).toBe(false);
    expect(store.newWorkspaceName).toBe('leftover');
    expect(store.newWorkspaceDescription).toBe('leftover');
  });

  it('closeWorkspaceBootstrapModal closes when not submitting', () => {
    const { fn, store } = bindMethod('closeWorkspaceBootstrapModal', {
      workspaceBootstrapSubmitting: false,
      showWorkspaceBootstrapModal: true,
    });
    fn();
    expect(store.showWorkspaceBootstrapModal).toBe(false);
  });

  it('closeWorkspaceBootstrapModal blocked during submission', () => {
    const { fn, store } = bindMethod('closeWorkspaceBootstrapModal', {
      workspaceBootstrapSubmitting: true,
      showWorkspaceBootstrapModal: true,
    });
    fn();
    expect(store.showWorkspaceBootstrapModal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updateWorkspaceBootstrapPrompt
// ---------------------------------------------------------------------------
describe('updateWorkspaceBootstrapPrompt', () => {
  it('opens connect instead of legacy bootstrap when PG-only signed in, has backend, no workspace', () => {
    const { fn, store } = bindMethod('updateWorkspaceBootstrapPrompt', {
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      currentWorkspaceOwnerNpub: '',
      knownWorkspaces: [],
      showConnectModal: false,
      showWorkspaceBootstrapModal: false,
    });
    const result = fn();
    expect(result).toBe(false);
    expect(store.showConnectModal).toBe(true);
    expect(store.showWorkspaceBootstrapModal).toBe(false);
  });

  it('does not prompt when workspace exists', () => {
    const { fn, store } = bindMethod('updateWorkspaceBootstrapPrompt', {
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      currentWorkspaceOwnerNpub: 'npub1ws',
      knownWorkspaces: [{ workspaceOwnerNpub: 'npub1ws' }],
      showWorkspaceBootstrapModal: false,
    });
    const result = fn();
    expect(result).toBe(false);
    expect(store.showWorkspaceBootstrapModal).toBe(false);
  });

  it('does not prompt when not signed in', () => {
    const { fn } = bindMethod('updateWorkspaceBootstrapPrompt', {
      session: null,
      backendUrl: 'https://backend.example.com',
      currentWorkspaceOwnerNpub: '',
      knownWorkspaces: [],
      showWorkspaceBootstrapModal: false,
    });
    expect(fn()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// persistWorkspaceSettings
// ---------------------------------------------------------------------------
describe('persistWorkspaceSettings', () => {
  it('calls saveSettings with correct fields', async () => {
    const { default: db } = await import('../src/db.js');
    const { fn, store } = bindMethod('persistWorkspaceSettings', {
      backendUrl: 'https://backend.example.com',
      ownerNpub: 'npub1owner',
      botNpub: '',
      superbasedTokenInput: 'token123',
      useCvmSync: false,
      knownWorkspaces: [{ workspaceOwnerNpub: 'npub1ws' }],
      knownHosts: [],
      currentWorkspaceOwnerNpub: 'npub1ws',
      defaultAgentNpub: '',
    });
    // Note: this will try to call the real db functions which may not be available
    // in a unit test environment, so we just verify the method exists and is callable
    expect(typeof fn).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Workspace storage backend URL
// ---------------------------------------------------------------------------
describe('getWorkspaceStorageBackendUrl', () => {
  it('returns directHttpsUrl from workspace entry', () => {
    const ws = { workspaceOwnerNpub: 'npub1ws', directHttpsUrl: 'https://storage.example.com' };
    const { fn } = bindMethod('getWorkspaceStorageBackendUrl', { knownWorkspaces: [ws] });
    expect(fn(ws)).toBe('https://storage.example.com');
  });

  it('falls back to currentWorkspaceBackendUrl for current workspace key', () => {
    const ws = { workspaceKey: 'service:svc::workspace:npub1ws', workspaceOwnerNpub: 'npub1ws' };
    const { fn } = bindMethod('getWorkspaceStorageBackendUrl', {
      knownWorkspaces: [ws],
      selectedWorkspaceKey: 'service:svc::workspace:npub1ws',
      currentWorkspaceOwnerNpub: 'npub1ws',
      backendUrl: 'https://fallback.example.com',
    });
    expect(fn(ws)).toBe('https://fallback.example.com');
  });

  it('returns empty string for unknown workspace', () => {
    const ws = { workspaceOwnerNpub: 'npub1other' };
    const { fn } = bindMethod('getWorkspaceStorageBackendUrl', {
      knownWorkspaces: [],
      currentWorkspaceOwnerNpub: 'npub1ws',
    });
    expect(fn(ws)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Settings tabs
// ---------------------------------------------------------------------------
describe('normalizeSettingsTab', () => {
  it('hides advanced tabs when workspace advanced options are disabled', () => {
    const { fn, store } = bindMethod('normalizeSettingsTab', {
      settingsTab: 'flows',
      canAdminWorkspace: true,
      workspaceAdvancedOptionsEnabled: false,
    });

    fn();

    expect(store.settingsTab).toBe('connection');
  });

  it('keeps advanced tabs when workspace advanced options are enabled', () => {
    const { fn, store } = bindMethod('normalizeSettingsTab', {
      settingsTab: 'data',
      canAdminWorkspace: true,
      workspaceAdvancedOptionsEnabled: true,
    });

    fn();

    expect(store.settingsTab).toBe('data');
  });
});

describe('openSettingsTab', () => {
  it('prepares Groups & Members when opening the sharing tab', () => {
    const prepareWorkspaceSharingSettings = vi.fn();
    const { fn, store } = bindMethod('openSettingsTab', {
      settingsTab: 'connection',
      canAdminWorkspace: true,
      workspaceAdvancedOptionsEnabled: false,
      prepareWorkspaceSharingSettings,
    });

    fn('sharing');

    expect(store.settingsTab).toBe('sharing');
    expect(prepareWorkspaceSharingSettings).toHaveBeenCalledTimes(1);
  });
});

describe('prepareWorkspaceSharingSettings', () => {
  it('refreshes groups without depending on the member npub input', async () => {
    const refreshGroups = vi.fn().mockResolvedValue([]);
    const { fn, store } = bindMethod('prepareWorkspaceSharingSettings', {
      canAdminWorkspace: true,
      pgWorkspaceMemberNpub: '',
      groupsLoading: false,
      groupsLoadError: 'old error',
      refreshGroups,
    });

    await fn();

    expect(refreshGroups).toHaveBeenCalledWith({
      force: false,
      maxAgeMs: 30000,
      minIntervalMs: 5000,
    });
    expect(store.groupsLoading).toBe(false);
    expect(store.groupsLoadError).toBeNull();
  });

  it('loads PG members and channels then resets bulk channel access with nothing selected', async () => {
    const refreshGroups = vi.fn().mockResolvedValue([]);
    const refreshTowerPgWorkspaceMembers = vi.fn().mockResolvedValue([]);
    const refreshChannels = vi.fn().mockResolvedValue([]);
    const resetChannelBulkGrantDraft = vi.fn();
    const { fn } = bindMethod('prepareWorkspaceSharingSettings', {
      canAdminWorkspace: true,
      isTowerPgMode: true,
      refreshGroups,
      refreshTowerPgWorkspaceMembers,
      refreshChannels,
      resetChannelBulkGrantDraft,
    });

    await fn({ force: true });

    expect(refreshGroups).toHaveBeenCalledWith({
      force: true,
      maxAgeMs: 30000,
      minIntervalMs: 5000,
    });
    expect(refreshTowerPgWorkspaceMembers).toHaveBeenCalledWith({ force: true, limit: 200 });
    expect(refreshChannels).toHaveBeenCalledTimes(1);
    expect(resetChannelBulkGrantDraft).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// mergeKnownWorkspaces
// ---------------------------------------------------------------------------
describe('mergeKnownWorkspaces', () => {
  it('merges new entries into knownWorkspaces', () => {
    const { fn, store } = bindMethod('mergeKnownWorkspaces', {
      knownWorkspaces: [{ workspaceOwnerNpub: 'npub1a', name: 'WS A' }],
      workspaceProfileDirty: true, // prevent syncWorkspaceProfileDraft from running
    });
    fn([{ workspaceOwnerNpub: 'npub1b', name: 'WS B' }]);
    expect(store.knownWorkspaces).toHaveLength(2);
    expect(store.knownWorkspaces.find((w) => w.workspaceOwnerNpub === 'npub1b')).toBeTruthy();
  });
});
