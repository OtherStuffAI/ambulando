import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/backend-mode.js', () => ({ isTowerPgBackendMode: vi.fn(() => true) }));

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createTowerPgPersonalWapp: vi.fn(async (_workspaceId, body) => ({
      personal_wapp: {
        id: 'personal-wapp-1',
        owner_actor_id: 'actor-owner',
        owner_actor_npub: 'npub1owner',
        ...body,
        status: 'active',
        row_version: 1,
      },
    })),
    createTowerPgScopeChannel: vi.fn(async (_workspaceId, scopeId, body) => ({
      channel: { id: 'channel-new', scope_id: scopeId, title: body.name, name: body.name, kind: 'channel' },
    })),
    disableTowerPgWappPublishingGrant: vi.fn(async () => ({})),
    putTowerPgWappPublishingGrant: vi.fn(async (_workspaceId, installationId, body) => ({
      grant: { ...body, grant_id: 'grant-1', wapp_installation_id: installationId, grant_version: 1, status: 'active' },
    })),
    revokeTowerPgWappPublishingGrant: vi.fn(async () => ({})),
    rotateTowerPgWappPublishingGrant: vi.fn(async () => ({})),
    updateTowerPgPersonalWapp: vi.fn(async (_workspaceId, id, body) => ({
      personal_wapp: {
        id,
        owner_actor_id: 'actor-owner',
        owner_actor_npub: 'npub1owner',
        ...body,
        status: 'active',
        row_version: 2,
      },
    })),
  };
});

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    upsertChannel: vi.fn(async (row) => row),
    upsertWapp: vi.fn(async (row) => row),
    upsertWappPublishingGrant: vi.fn(async (row) => row),
  };
});

vi.mock('../src/pg-read-hydrator.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hydrateTowerPgChannels: vi.fn(async (store) => store.channels || []),
    hydrateTowerPgPersonalWapps: vi.fn(async (store) => store.wapps || []),
    hydrateTowerPgWappPublishingGrants: vi.fn(async () => []),
    resolveTowerPgWorkspaceContext: vi.fn(() => ({
      workspaceId: 'workspace-1',
      baseUrl: 'https://tower.example',
      appNpub: 'npub1flightdeck',
    })),
  };
});

import {
  createTowerPgPersonalWapp,
  createTowerPgScopeChannel,
  putTowerPgWappPublishingGrant,
  updateTowerPgPersonalWapp,
} from '../src/api.js';
import { upsertWapp } from '../src/db.js';
import {
  hydrateTowerPgPersonalWapps,
  resolveTowerPgWorkspaceContext,
} from '../src/pg-read-hydrator.js';
import {
  extractWappPublishingMetadata,
  findPublishingPersonalWapp,
  normalizeHttpsOrigins,
  normalizePersonalWappLaunchUrl,
  wappPublishingManagerMixin,
} from '../src/wapp-publishing-manager.js';

function createStore(overrides = {}) {
  const store = Object.create(wappPublishingManagerMixin);
  Object.assign(store, {
    canAdminWorkspace: true,
    scopes: [{ record_id: 'scope-1', title: 'Sales' }],
    channels: [{ record_id: 'channel-1', scope_id: 'scope-1', title: 'Leads', record_state: 'active' }],
    wapps: [],
    wappPublishingGrants: [{
      grant_id: '',
      app_id: 'app-1',
      wapp_installation_id: 'installation-1',
      publisher_npub: 'npub1publisher',
      owner_npub: 'npub1owner',
      display_name: 'Kindling',
      capabilities: [],
      destinations: [],
      registered_open_origins: [],
      status: 'unconfigured',
    }],
    wappPublishingSelectedInstallationId: 'installation-1',
    wappPublishingCanPost: true,
    wappPublishingDestinationIds: [],
    wappPublishingOriginsText: 'https://kindling.example',
    wappPublishingEditorOpen: true,
    wappPublishingEditorSaving: false,
    wappPublishingEditorError: '',
    wappPublishingAddToMyWapps: false,
    wappPublishingLauncherLaunchUrl: '',
    wappPublishingLauncherDescription: '',
    wappPublishingLauncherIconUrl: '',
    wappPublishingLauncherError: '',
    wappPublishingGrantSaved: false,
    wappPublishingNewChannelOpen: false,
    wappPublishingNewChannelScopeId: '',
    wappPublishingNewChannelName: '',
    wappPublishingNewChannelSaving: false,
    wappPublishingNewChannelError: '',
    currentPgActorId: 'actor-owner',
    currentWorkspace: { pgMe: { actor: { actor_id: 'actor-owner', npub: 'npub1owner' } } },
    currentWorkspaceGroups: [{ group_id: 'group-workspace', name: 'Workspace' }],
    newChannelAccessRows: [],
    refreshTowerPgWorkspaceMembers: vi.fn(async () => []),
    refreshGroups: vi.fn(async () => []),
    resetNewChannelAccessRows() {
      this.newChannelAccessRows = [
        { principal_type: 'group', principal_id: 'group-workspace', capacity: 'viewer' },
        { principal_type: 'actor', principal_id: 'actor-owner', capacity: 'manager' },
      ];
    },
    getScopeBreadcrumb: () => 'Sales',
    getChannelLabel: () => 'Leads',
    ...overrides,
  });
  const inFlight = new Map();
  const service = {
    ensureLoaded(family) {
      if (inFlight.has(family)) return inFlight.get(family);
      const pending = Promise.resolve(family === 'personal-wapps'
          ? hydrateTowerPgPersonalWapps(store)
          : []);
      inFlight.set(family, pending);
      pending.finally(() => inFlight.delete(family));
      return pending;
    },
  };
  store.requestTowerSyncFamily ??= (family) => service.ensureLoaded(family);
  return store;
}

describe('WApp publishing manager', () => {
  beforeEach(() => vi.clearAllMocks());

  it('consumes Autopilot installation metadata from both top-level and compatibility metadata', () => {
    expect(extractWappPublishingMetadata({
      app_id: 'app-1',
      metadata: { autopilot_wapp: { wapp_installation_id: 'installation-1', publisher_npub: 'npub1publisher', registered_open_origins: ['https://kindling.example'] } },
    })).toMatchObject({
      app_id: 'app-1',
      wapp_installation_id: 'installation-1',
      publisher_npub: 'npub1publisher',
      registered_open_origins: ['https://kindling.example'],
    });
  });

  it('accepts only normalized HTTPS origins without credentials, paths, query, or fragments', () => {
    expect(normalizeHttpsOrigins([
      'https://kindling.example',
      'https://kindling.example/',
      'http://kindling.example',
      'https://user:pass@kindling.example',
      'https://kindling.example/path',
    ])).toEqual(['https://kindling.example']);
  });

  it('accepts only credential-free HTTP(S) launcher URLs', () => {
    expect(normalizePersonalWappLaunchUrl('https://kindling.example/app')).toBe('https://kindling.example/app');
    expect(normalizePersonalWappLaunchUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizePersonalWappLaunchUrl('javascript:alert(1)')).toBe('');
    expect(normalizePersonalWappLaunchUrl('https://user:pass@kindling.example')).toBe('');
  });

  it('requires an explicit destination and sends only selected scope/channel pairs', async () => {
    const store = createStore();
    await store.saveWappPublishingGrant();
    expect(putTowerPgWappPublishingGrant).not.toHaveBeenCalled();
    expect(store.wappPublishingEditorError).toContain('Select at least one channel');

    store.wappPublishingDestinationIds = ['channel-1'];
    await store.saveWappPublishingGrant();
    expect(putTowerPgWappPublishingGrant).toHaveBeenCalledWith(
      'workspace-1',
      'installation-1',
      expect.objectContaining({
        capabilities: ['activity.publish'],
        destinations: [{ scope_id: 'scope-1', channel_id: 'channel-1' }],
        registered_open_origins: ['https://kindling.example'],
      }),
      expect.objectContaining({ baseUrl: 'https://tower.example', appNpub: 'npub1flightdeck' }),
    );
  });

  it('keeps background-only registered installations manageable without a launcher', () => {
    const store = createStore();
    expect(store.wappPublishingInstallations).toEqual([
      expect.objectContaining({ wapp_installation_id: 'installation-1', display_name: 'Kindling' }),
    ]);
    expect(store.wappPublishingInstallations[0].launcher).toBeUndefined();
  });

  it('can grant a background-only installation without creating a launcher assignment', async () => {
    const store = createStore({ wappPublishingGrants: [], wapps: [], currentViewerNpub: 'npub1owner' });
    store.openNewWappPublishingEditor();
    Object.assign(store.wappPublishingDraftInstallation, {
      wapp_installation_id: 'background-installation',
      app_id: 'background-app',
      publisher_npub: 'npub1background',
      owner_npub: 'npub1owner',
      display_name: 'Background Processor',
    });
    store.wappPublishingDestinationIds = ['channel-1'];
    store.wappPublishingOriginsText = '';
    store.wappPublishingAddToMyWapps = false;

    await store.saveWappPublishingGrant();

    expect(putTowerPgWappPublishingGrant).toHaveBeenCalledWith(
      'workspace-1',
      'background-installation',
      expect.objectContaining({ app_id: 'background-app', publisher_npub: 'npub1background' }),
      expect.any(Object),
    );
    expect(store.wapps).toEqual([]);
  });

  it('defaults new installations to My WApps and saves the grant before creating the launcher', async () => {
    const store = createStore({ wappPublishingGrants: [], wapps: [], currentViewerNpub: 'npub1owner' });
    store.openNewWappPublishingEditor();
    expect(store.wappPublishingAddToMyWapps).toBe(true);
    Object.assign(store.wappPublishingDraftInstallation, {
      wapp_installation_id: 'installation-new',
      app_id: 'app-new',
      wapp_id: 'assignment-new',
      publisher_npub: 'npub1publisher',
      owner_npub: 'npub1owner',
      display_name: 'New WApp',
      source_wingman_url: 'https://wingman.example',
    });
    store.wappPublishingDestinationIds = ['channel-1'];
    store.wappPublishingLauncherLaunchUrl = 'https://new.example/app';
    store.wappPublishingLauncherDescription = 'Useful launcher';

    await store.saveWappPublishingGrant();

    expect(putTowerPgWappPublishingGrant.mock.invocationCallOrder[0])
      .toBeLessThan(createTowerPgPersonalWapp.mock.invocationCallOrder[0]);
    expect(createTowerPgPersonalWapp).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
      title: 'New WApp',
      launch_url: 'https://new.example/app',
      description: 'Useful launcher',
      app_id: 'app-new',
      wapp_id: 'assignment-new',
      source_wingman_url: 'https://wingman.example',
      metadata: expect.objectContaining({
        wapp_installation_id: 'installation-new',
        autopilot_wapp: expect.objectContaining({ app_id: 'app-new', wapp_installation_id: 'installation-new' }),
      }),
    }), expect.any(Object));
    expect(upsertWapp).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'personal-wapp-1', app_id: 'app-new' }));
    expect(hydrateTowerPgPersonalWapps).toHaveBeenCalledWith(store);
    expect(store.wapps).toEqual(expect.arrayContaining([expect.objectContaining({ app_id: 'app-new' })]));
    expect(store.wappPublishingEditorOpen).toBe(false);
  });

  it('deduplicates launcher retries by installation metadata first and stable app_id second', async () => {
    const installation = { wapp_installation_id: 'installation-1', app_id: 'app-1', display_name: 'Kindling' };
    const exact = { record_id: 'exact', app_id: 'old-app', metadata: { wapp_installation_id: 'installation-1' }, owner_actor_id: 'actor-owner' };
    const sameApp = { record_id: 'same-app', app_id: 'app-1', owner_actor_id: 'actor-owner' };
    expect(findPublishingPersonalWapp([sameApp, exact], installation, 'actor-owner')).toBe(exact);
    expect(findPublishingPersonalWapp([sameApp], installation, 'actor-owner')).toBe(sameApp);

    const store = createStore({ wapps: [sameApp] });
    store.wappPublishingLauncherLaunchUrl = 'https://kindling.example';
    await store.saveWappPublishingLauncher(installation);
    expect(updateTowerPgPersonalWapp).toHaveBeenCalledWith('workspace-1', 'same-app', expect.objectContaining({ app_id: 'app-1' }), expect.any(Object));
    expect(createTowerPgPersonalWapp).not.toHaveBeenCalled();
  });

  it('keeps a successful grant visible and retries only the failed launcher step', async () => {
    createTowerPgPersonalWapp.mockRejectedValueOnce(new Error('launcher unavailable'));
    const store = createStore({ wappPublishingGrants: [], wapps: [], currentViewerNpub: 'npub1owner' });
    store.openNewWappPublishingEditor();
    Object.assign(store.wappPublishingDraftInstallation, {
      wapp_installation_id: 'installation-new', app_id: 'app-new', publisher_npub: 'npub1publisher', owner_npub: 'npub1owner', display_name: 'New WApp',
    });
    store.wappPublishingDestinationIds = ['channel-1'];
    store.wappPublishingLauncherLaunchUrl = 'https://new.example';

    await store.saveWappPublishingGrant();
    expect(store.wappPublishingGrantSaved).toBe(true);
    expect(store.wappPublishingLauncherError).toContain('Publishing grant saved');
    expect(store.wappPublishingEditorOpen).toBe(true);
    expect(putTowerPgWappPublishingGrant).toHaveBeenCalledTimes(1);

    await store.retryWappPublishingLauncher();
    expect(createTowerPgPersonalWapp).toHaveBeenCalledTimes(2);
    expect(putTowerPgWappPublishingGrant).toHaveBeenCalledTimes(1);
    expect(store.wappPublishingEditorOpen).toBe(false);
  });

  it('rejects missing or unsafe launch URLs before saving a default-on setup', async () => {
    const store = createStore({ wappPublishingGrants: [], wapps: [], currentViewerNpub: 'npub1owner' });
    store.openNewWappPublishingEditor();
    Object.assign(store.wappPublishingDraftInstallation, {
      wapp_installation_id: 'installation-new', app_id: 'app-new', publisher_npub: 'npub1publisher', owner_npub: 'npub1owner', display_name: 'New WApp',
    });
    store.wappPublishingDestinationIds = ['channel-1'];
    for (const launchUrl of ['', 'javascript:alert(1)', 'https://user:pass@example.com']) {
      store.wappPublishingLauncherLaunchUrl = launchUrl;
      await store.saveWappPublishingGrant();
    }
    expect(putTowerPgWappPublishingGrant).not.toHaveBeenCalled();
    expect(store.wappPublishingEditorError).toContain('valid HTTP(S) launch URL');
  });

  it('creates and materializes a channel inline without disturbing the publishing draft', async () => {
    const store = createStore({
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', title: 'Leads', record_state: 'active' }],
      applyChannels(rows) { this.channels = rows; },
    });
    store.wappPublishingDestinationIds = ['channel-1'];
    store.wappPublishingOriginsText = 'https://kindling.example';
    store.wappPublishingNewChannelScopeId = 'scope-1';
    store.wappPublishingNewChannelName = 'WApp Updates';
    store.resetNewChannelAccessRows();

    await store.createWappPublishingChannel();

    expect(createTowerPgScopeChannel).toHaveBeenCalledWith('workspace-1', 'scope-1', expect.objectContaining({
      name: 'WApp Updates',
      kind: 'channel',
      grants: [
        { principal_type: 'group', principal_id: 'group-workspace', access_level: 'view' },
        { principal_type: 'actor', principal_id: 'actor-owner', access_level: 'manage' },
      ],
    }), { baseUrl: 'https://tower.example', appNpub: 'npub1flightdeck' });
    expect(store.wappPublishingDestinationIds).toEqual(['channel-1', 'channel-new']);
    expect(store.wappPublishingOriginsText).toBe('https://kindling.example');
    expect(store.wappPublishingEditorOpen).toBe(true);
    expect(store.channels).toEqual(expect.arrayContaining([expect.objectContaining({ record_id: 'channel-new' })]));
  });

  it('keeps inline channel API errors inside the channel interaction', async () => {
    createTowerPgScopeChannel.mockRejectedValueOnce(new Error('You cannot create a channel here'));
    const store = createStore();
    store.wappPublishingNewChannelScopeId = 'scope-1';
    store.wappPublishingNewChannelName = 'WApp Updates';
    store.resetNewChannelAccessRows();

    await store.createWappPublishingChannel();

    expect(store.wappPublishingNewChannelError).toContain('cannot create');
    expect(store.wappPublishingEditorOpen).toBe(true);
    expect(store.wappPublishingDestinationIds).toEqual([]);
  });
});
