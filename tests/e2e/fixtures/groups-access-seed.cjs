const { generateSecretKey, getPublicKey, nip19 } = require('nostr-tools');

// Synthetic Groups & Members fixture. Every Tower request is intercepted by the
// calling spec; nothing here reaches or mutates a real workspace.
function syntheticNpub() {
  return nip19.npubEncode(getPublicKey(generateSecretKey()));
}

function buildGroupsAccessFixture() {
  const owner = syntheticNpub();
  const people = [
    { actor_id: 'actor-manager', name: 'Workspace Manager', role: 'owner' },
    { actor_id: 'actor-kato', name: 'Kato', role: 'member' },
    { actor_id: 'actor-holly', name: 'Holly', role: 'member' },
    { actor_id: 'actor-brick', name: 'Brick', role: 'member', kind: 'agent' },
    { actor_id: 'actor-editor-agent', name: 'Editor Agent', role: 'member', kind: 'agent' },
    { actor_id: 'actor-unnamed', name: '', role: 'member' },
  ].map((person) => ({ ...person, npub: syntheticNpub() }));
  const byId = Object.fromEntries(people.map((person) => [person.actor_id, person]));
  const scopes = [
    { record_id: 'scope-beacon', title: 'Beacon' },
    { record_id: 'scope-devops', title: 'Dev Ops' },
    { record_id: 'scope-suite', title: 'Wingman Suite' },
  ];
  const channels = [
    ['ch-dialogue', 'dialogue', 'scope-beacon'],
    ['ch-architecture', 'architecture', 'scope-beacon'],
    ['ch-gateway', 'gateway', 'scope-beacon'],
    ['ch-build', 'Build', 'scope-beacon'],
    ['ch-mini', 'Mini', 'scope-devops'],
    ['ch-servers', 'Servers', 'scope-devops'],
    ['ch-autopilot', 'Autopilot', 'scope-suite'],
    ['ch-flightdeck', 'Flight Deck', 'scope-suite'],
    ['ch-tower', 'Tower', 'scope-suite'],
    ['ch-scratch', 'Scratch Pad', ''],
  ].map(([record_id, title, scope_id]) => ({ record_id, title, scope_id, record_state: 'active' }));
  const groups = [
    { group_id: 'group-admins', name: 'Workspace admins', group_kind: 'workspace_admin', members: ['actor-manager'] },
    { group_id: 'group-agents', name: 'Agents', group_kind: 'custom', members: ['actor-brick', 'actor-editor-agent'] },
    { group_id: 'group-team', name: 'Team', group_kind: 'custom', members: ['actor-manager', 'actor-kato', 'actor-holly'], children: ['group-agents'] },
  ];
  const membersByGroup = Object.fromEntries(groups.map((group) => [group.group_id, group.members]));
  return buildResult(groups.map((group) => {
    const member_npubs = group.members.map((id) => byId[id].npub);
    const childNpubs = (group.children || []).flatMap((childId) => membersByGroup[childId].map((id) => byId[id].npub));
    return {
      group_id: group.group_id,
      group_npub: group.group_id,
      name: group.name,
      group_kind: group.group_kind,
      owner_npub: owner,
      member_npubs,
      child_group_ids: group.children || [],
      effective_member_npubs: [...new Set([...member_npubs, ...childNpubs])],
    };
  }));

  function buildResult(materializedGroups) {
    return { owner, people, scopes, channels, groups: materializedGroups, viewer: people[0] };
  }
}

// Mirrors the tower-usage fixture: stub unrelated sync/hydration so only the
// Groups & Members surface and its intercepted grant requests are exercised.
async function seedGroupsAccess(page, fixture) {
  await page.waitForFunction(() => Boolean(window.Alpine?.store('chat')) && window.Alpine.store('chat').routeSyncPaused === false);
  await page.evaluate(async (fx) => {
    const s = window.Alpine.store('chat');
    s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
    s.stopBackgroundSync(); s.scheduleBackgroundSync = () => {}; s.syncRoute = () => {};
    s.startWorkspaceLiveQueries = () => {}; s.ensureBackgroundSync = () => {}; s.refreshStatusRecentChanges = () => {};
    s.scheduleStorageImageHydration = () => {};
    s.requestTowerSyncFamily = async () => [];
    s.ensureWorkspaceSessionKey = async () => {};
    s.updateWorkspaceBootstrapPrompt = () => false;
    s.ensurePgWorkspaceAvailable = async (workspace) => workspace;
    s.loadLocalWorkspaceCoreData = async () => {};
    s.refreshWorkspaceSettings = async () => {};
    s.refreshLegacyWorkspaceRecovery = async () => {};
    s.persistWorkspaceSettings = async () => {};
    s.resolveChatProfile = () => {};
    s.publishPgOnboardingAnnouncementForGrant = async () => ({ status: 'published' });
    s.schedulePgChannelAccessMaterializationRefresh = () => {};
    const workspaceId = 'groups-access-workspace';
    s.session = { npub: fx.viewer.npub }; s.workspaceDbKey = workspaceId; s.selectedWorkspaceKey = workspaceId;
    s.knownWorkspaces = [{
      workspaceKey: workspaceId, workspaceId, name: 'Synthetic', label: 'Synthetic',
      workspaceOwnerNpub: fx.owner, towerServiceNpub: 'synthetic-tower', workspaceServiceNpub: workspaceId,
      pgBackendMode: true, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'synthetic-groups-app',
      pgMe: {
        actor: { actor_id: fx.viewer.actor_id, npub: fx.viewer.npub },
        membership: { role: 'owner' },
        permissions: ['workspace.manage'],
      },
    }];
    await s.selectWorkspace(workspaceId, { skipPgVerification: true, refresh: false });
    const members = fx.people.map((person) => ({
      actor_id: person.actor_id, npub: person.npub, display_name: person.name || null,
      role: person.role, kind: person.kind || 'human',
    }));
    s.chatProfiles = Object.fromEntries(fx.people.filter((person) => person.name).map((person) => [person.npub, { name: person.name }]));
    s.scopes = fx.scopes;
    s.scopesMap = new Map(fx.scopes.map((scope) => [scope.record_id, scope]));
    s.channels = fx.channels;
    s.groups = fx.groups;
    s.pgWorkspaceMembers = members;
    s.refreshGroups = async () => s.groups;
    s.refreshChannels = async () => s.channels;
    s.refreshChannelGrants = async () => [];
    s.refreshTowerPgWorkspaceMembers = async () => { s.pgWorkspaceMembers = members; return members; };
    s.scheduleGroupsRefresh = () => {};
    s.navSection = 'settings'; s.navCollapsed = false; s.mobileNavOpen = false;
    const pubkey = '1'.repeat(64);
    localStorage.setItem('nostr_secure_auth_recovery_v1', JSON.stringify({ method: 'extension', pubkey, createdAt: Date.now(), expiresAt: Date.now() + 600_000 }));
    window.nostr = { getPublicKey: async () => pubkey, signEvent: async (event) => ({ ...event, pubkey, id: '2'.repeat(64), sig: '3'.repeat(128) }) };
    s.openSettingsTab('sharing');
  }, fixture);
}

module.exports = { buildGroupsAccessFixture, seedGroupsAccess };
