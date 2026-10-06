import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  alpineStartMock,
  alpineStoreMock,
} = vi.hoisted(() => ({
  alpineStartMock: vi.fn(),
  alpineStoreMock: vi.fn(),
}));

vi.mock('alpinejs', () => ({
  default: {
    store: alpineStoreMock,
    start: alpineStartMock,
  },
}));

beforeEach(() => {
  alpineStartMock.mockClear();
  alpineStoreMock.mockClear();
});

async function createStore() {
  vi.resetModules();
  const { initApp } = await import('../src/app.js');
  initApp();
  const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
  expect(store).toBeTruthy();
  return store;
}

describe('channel mention lookup', () => {
  it('reuses the local document mention index while a user types a query', async () => {
    const store = await createStore();
    const { clearRuntimeData, deleteWorkspaceDb, openWorkspaceDb, upsertDocument } = await import('../src/db.js');
    const workspaceKey = 'mention-document-index-typing';
    const ownerNpub = 'npub-owner';
    openWorkspaceDb(workspaceKey);
    await clearRuntimeData();

    try {
      await upsertDocument({
        record_id: 'doc-1',
        owner_npub: ownerNpub,
        title: 'Typing Performance Evidence',
        record_state: 'active',
        updated_at: '2026-08-04T00:00:00.000Z',
      });
      store.ownerNpub = ownerNpub;

      const first = await store.refreshMentionDocumentIndex();
      expect(first.map((document) => document.record_id)).toEqual(['doc-1']);

      await clearRuntimeData();
      const second = await store.refreshMentionDocumentIndex();
      expect(second).toBe(first);
      expect(second.map((document) => document.record_id)).toEqual(['doc-1']);
    } finally {
      await deleteWorkspaceDb(workspaceKey);
    }
  });

  it('returns all active channels for the channel prefix', async () => {
    const store = await createStore();
    store.channels = Array.from({ length: 12 }, (_, index) => ({
      record_id: `channel-${index + 1}`,
      title: `Channel ${index + 1}`,
      record_state: 'active',
    })).concat({
      record_id: 'channel-deleted',
      title: 'Deleted channel',
      record_state: 'deleted',
    });
    store.getChannelLabel = (channel) => channel.title;

    const results = store.searchMentions('channel:');

    expect(results).toHaveLength(12);
    expect(results.every((result) => result.type === 'channel')).toBe(true);
    expect(results.map((result) => result.label)).toContain('Channel 12');
    expect(results.map((result) => result.label)).not.toContain('Deleted channel');
  });

  it('matches channel names in the general mention lookup', async () => {
    const store = await createStore();
    store.channels = [
      { record_id: 'channel-ops', title: 'Operations', record_state: 'active' },
      { record_id: 'channel-sales', title: 'Sales', record_state: 'active' },
    ];
    store.getChannelLabel = (channel) => channel.title;

    expect(store.searchMentions('oper')).toEqual([{
      type: 'channel',
      id: 'channel-ops',
      label: 'Operations',
      sublabel: 'Channel',
    }]);
  });

  it('does not rescan message metadata for every mention typeahead character', async () => {
    const store = await createStore();
    let metadataReads = 0;
    store.selectedChannelId = 'channel-1';
    store.channels = [{ record_id: 'channel-1', record_state: 'active' }];
    store.addressBookPeople = [{ npub: 'npub-testagent', label: 'Test Agent' }];
    store.messages = Array.from({ length: 2_000 }, (_, index) => ({
      record_id: `message-${index}`,
      get metadata() {
        metadataReads += 1;
        return { mentions: [{ npub: 'npub-testagent', label: 'Test Agent' }] };
      },
    }));
    store.getSenderName = () => 'Test Agent';
    store.getChannelParticipants = () => [];

    expect(store.searchMentions('r')).toEqual([
      expect.objectContaining({ id: 'npub-testagent', label: 'Test Agent' }),
    ]);
    expect(metadataReads).toBeGreaterThan(0);
    metadataReads = 0;

    for (const query of ['ri', 'ric', 'testagent']) {
      store.searchMentions(query);
    }
    expect(metadataReads).toBe(0);
  });

  it('finds people from workspace members and workroom participants', async () => {
    const store = await createStore();
    store.groups = [];
    store.pgWorkspaceMembers = [
      { actor_id: 'actor-testagent', npub: 'npub-testagent', display_name: 'Test Agent', kind: 'agent' },
      { actor_id: 'actor-integrator', npub: 'npub-agent', display_name: 'Integrator Agent', kind: 'agent' },
    ];
    store.workroomParticipants = [{ actor_npub: 'npub-agent', label: 'Integrator Agent', role: 'integration' }];
    store.addressBookPeople = [];
    store.getSenderName = (npub) => ({ 'npub-testagent': 'Test Agent', 'npub-agent': 'Integrator Agent' }[npub] || npub);

    expect(store.searchMentions('testagent')).toEqual([{
      type: 'agent',
      id: 'npub-testagent',
      label: 'Test Agent',
      sublabel: 'Agent',
    }]);
    expect(store.searchMentions('integrator')).toEqual([{
      type: 'agent',
      id: 'npub-agent',
      label: 'Integrator Agent',
      sublabel: 'Agent',
    }]);
  });

  it('preserves a selected Tower-human actor as a canonical person mention', async () => {
    const store = await createStore();
    const testagentNpub = 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266';
    store.channels = [{ record_id: 'channel-testagent', title: 'Test Agent', record_state: 'active' }];
    store.pgWorkspaceMembers = [{ npub: testagentNpub, display_name: 'Test Agent', kind: 'human' }];
    store.workroomParticipants = [];
    store.addressBookPeople = [];
    store.groups = [];
    store.getSenderName = () => 'Test Agent';
    store.getChannelLabel = (channel) => channel.title;

    const results = store.searchMentions('Test Agent');
    expect(results[0]).toEqual({
      type: 'person', id: testagentNpub, label: 'Test Agent', sublabel: 'User',
    });

    const target = {
      value: '@Test Agent', selectionStart: '@Test Agent'.length, dataset: { chatComposer: 'message' },
      dispatchEvent: vi.fn(), setSelectionRange: vi.fn(), focus: vi.fn(),
    };
    store._mentionTargetEl = target;
    store._mentionStartPos = 0;
    store._mentionEndPos = target.selectionStart;
    store.selectedAgentMentionsByComposer = {};
    store.selectMention(results[0]);

    expect(target.value).toBe(`@[Test Agent](mention:person:${testagentNpub}) `);
    expect(store.selectedAgentMentionsByComposer.message).toEqual([
      { type: 'person', npub: testagentNpub, label: 'Test Agent' },
    ]);
    const { canonicalAgentMentionsFromSelection } = await import('../src/agent-direct-chat.js');
    expect(canonicalAgentMentionsFromSelection(
      target.value,
      store.selectedAgentMentionsByComposer.message,
    )).toEqual([{ type: 'person', npub: testagentNpub, label: 'Test Agent' }]);
  });

  it('updates lookahead immediately when the People directory member is renamed', async () => {
    const store = await createStore();
    const testagentNpub = 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266';
    store.channels = [{ record_id: 'channel-testagent', title: 'Test Agent', record_state: 'active' }];
    store.pgWorkspaceMembers = [{ actor_id: 'actor-testagent', npub: testagentNpub, display_name: '', kind: 'human' }];
    store.workroomParticipants = [];
    store.addressBookPeople = [];
    store.groups = [];
    store.getSenderName = () => 'Legacy Alias';
    store.getChannelLabel = (channel) => channel.title;

    expect(store.searchMentions('Test Agent')[0].type).toBe('channel');

    store.pgWorkspaceMembers = [{ actor_id: 'actor-testagent', npub: testagentNpub, display_name: 'Test Agent', kind: 'human' }];

    expect(store.searchMentions('Test Agent')[0]).toEqual({
      type: 'person', id: testagentNpub, label: 'Test Agent', sublabel: 'User',
    });
  });

  it('keeps a configured integration agent visible before grants and groups hydrate', async () => {
    const store = await createStore();
    const testagentNpub = 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266';
    store.selectedChannelId = 'channel-features';
    store.channels = [
      {
        record_id: 'channel-features',
        title: 'Features',
        record_state: 'active',
        metadata: {
          workroom_defaults: {
            integration_autopilot_npub: testagentNpub,
            participants: [{ actor_npub: testagentNpub, role: 'integration', label: 'Test Agent' }],
          },
        },
      },
      { record_id: 'channel-testagent-dm', title: 'Test Agent', record_state: 'active' },
    ];
    store.groups = [];
    store.pgWorkspaceMembers = [{ npub: testagentNpub, display_name: 'Test Agent', kind: 'human' }];
    store.workroomParticipants = [];
    store.addressBookPeople = [];
    store.channelGrantsChannelId = 'channel-features';
    store.channelGrants = [];
    store.getSenderName = (npub) => npub;
    store.getChannelLabel = (channel) => channel.title;
    store.getChannelParticipants = () => [];

    expect(store.searchMentions('Test', { visibleOnly: true })).toEqual([
      { type: 'person', id: testagentNpub, label: 'Test Agent', sublabel: 'User' },
      { type: 'channel', id: 'channel-testagent-dm', label: 'Test Agent', sublabel: 'Channel' },
    ]);

    const target = {
      value: '@testagent',
      selectionStart: '@testagent'.length,
      dataset: { chatComposer: 'message' },
      dispatchEvent: vi.fn(),
      setSelectionRange: vi.fn(),
      focus: vi.fn(),
    };
    store._mentionTargetEl = target;
    store._mentionStartPos = 0;
    store._mentionEndPos = target.selectionStart;
    store.selectedAgentMentionsByComposer = {};
    store.selectMention(store.searchMentions('Test', { visibleOnly: true })[0]);

    expect(target.value).toBe(`@[Test Agent](mention:person:${testagentNpub}) `);
    expect(store.selectedAgentMentionsByComposer.message).toEqual([
      { type: 'person', npub: testagentNpub, label: 'Test Agent' },
    ]);
    const { canonicalAgentMentionsFromSelection } = await import('../src/agent-direct-chat.js');
    expect(canonicalAgentMentionsFromSelection(
      target.value,
      store.selectedAgentMentionsByComposer.message,
    )).toEqual([{ type: 'person', npub: testagentNpub, label: 'Test Agent' }]);
  });

  it('keeps a durable workspace agent visible in a default-enabled ordinary channel', async () => {
    const store = await createStore();
    const ownerNpub = 'npub1owner';
    const testagentNpub = 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266';
    store.currentWorkspaceOwnerNpub = ownerNpub;
    store.selectedChannelId = 'channel-autopilot';
    store.channels = [
      {
        record_id: 'channel-autopilot', title: 'Autopilot', record_state: 'active',
        metadata: {},
      },
      {
        record_id: 'channel-testagent-dm', title: `DM: ${testagentNpub}`, kind: 'dm', record_state: 'active',
        participant_npubs: ['npub1operator-a', testagentNpub],
      },
    ];
    store.groups = [{
      group_id: 'group-agents', owner_npub: ownerNpub, name: 'Agents', member_npubs: [testagentNpub],
    }];
    store.pgWorkspaceMembers = [{ npub: testagentNpub, display_name: '', kind: 'human' }];
    store.workroomParticipants = [];
    store.addressBookPeople = [];
    store.channelGrants = [];
    store.channelGrantsChannelId = 'channel-autopilot';
    store.getSenderName = (npub) => npub;
    store.getChannelParticipants = (candidate) => candidate.participant_npubs || [];
    store.getChannelLabel = (candidate) => candidate.title;

    // Tower currently has no display name for this actor, so the npub is the
    // only honest searchable identity until Tower normalizes its actor profile.
    const results = store.searchMentions(testagentNpub, { visibleOnly: true });
    expect(results[0]).toEqual({
      type: 'agent', id: testagentNpub, label: testagentNpub, sublabel: 'Agent',
    });

    const target = {
      value: `@${testagentNpub}`, selectionStart: testagentNpub.length + 1, dataset: { chatComposer: 'message' },
      dispatchEvent: vi.fn(), setSelectionRange: vi.fn(), focus: vi.fn(),
    };
    store._mentionTargetEl = target;
    store._mentionStartPos = 0;
    store._mentionEndPos = target.selectionStart;
    store.selectedAgentMentionsByComposer = {};
    store.selectMention(results[0]);
    expect(target.value).toBe(`@[${testagentNpub}](mention:agent:${testagentNpub}) `);
    expect(store.selectedAgentMentionsByComposer.message).toEqual([
      { type: 'agent', npub: testagentNpub, label: testagentNpub },
    ]);
  });

  it('keeps workspace agents visible when a channel has a legacy persisted false', async () => {
    const store = await createStore();
    const testagentNpub = 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266';
    store.currentWorkspaceOwnerNpub = 'npub1owner';
    store.selectedChannelId = 'channel-disabled';
    store.channels = [{
      record_id: 'channel-disabled', title: 'Disabled', record_state: 'active',
      metadata: { agent_chat: { enabled: false } },
    }];
    store.groups = [{
      group_id: 'group-agents', owner_npub: 'npub1owner', name: 'Agents', member_npubs: [testagentNpub],
    }];
    store.pgWorkspaceMembers = [{ npub: testagentNpub, display_name: 'Test Agent', kind: 'human' }];
    store.workroomParticipants = [];
    store.addressBookPeople = [];
    store.channelGrants = [];
    store.channelGrantsChannelId = 'channel-disabled';
    store.getSenderName = () => 'Test Agent';
    store.getChannelParticipants = () => [];

    expect(store.searchMentions('Test Agent', { visibleOnly: true })).toEqual([{
      type: 'agent', id: testagentNpub, label: 'Test Agent', sublabel: 'Agent',
    }]);
  });

  it('offers only the current workspace actor when stale caches retain its retired npub', async () => {
    const store = await createStore();
    const retired = 'npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d';
    const current = 'npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd';
    store.currentWorkspaceOwnerNpub = 'npub1owner';
    store.selectedChannelId = 'channel-example-agent-dm';
    store.channels = [{
      record_id: 'channel-example-agent-dm',
      title: 'Example Agent',
      kind: 'dm',
      record_state: 'active',
      participant_npubs: ['npub1owner', current],
    }];
    store.pgWorkspaceMembers = [
      { actor_id: 'actor-owner', npub: 'npub1owner', display_name: 'Example User', kind: 'human' },
      { actor_id: 'actor-example-agent', npub: current, display_name: 'Example Agent', kind: 'agent' },
    ];
    store.groups = [{
      group_id: 'group-agents', owner_npub: 'npub1owner', name: 'Agents', member_npubs: [retired, current],
    }];
    store.workroomParticipants = [{ actor_npub: retired, label: 'Example Agent', role: 'integration' }];
    store.addressBookPeople = [{ npub: retired, label: 'Example Agent' }];
    store.messages = [{ metadata: { mentions: [{ type: 'agent', npub: retired, label: 'Example Agent' }] } }];
    store.threadReplies = [];
    store.channelGrants = [{ principal_actor_kind: 'agent', principal_npub: retired, access_level: 'agent' }];
    store.channelGrantsChannelId = 'channel-example-agent-dm';
    store.getSenderName = (npub) => (npub === retired || npub === current ? 'Example Agent' : npub);
    store.getChannelParticipants = (channel) => channel.participant_npubs || [];
    store.getChannelLabel = (channel) => channel.title;

    const results = store.searchMentions('Example Agent', { visibleOnly: true });
    expect(results).toContainEqual({ type: 'agent', id: current, label: 'Example Agent', sublabel: 'Agent' });
    expect(results.some((result) => result.id === retired)).toBe(false);
    expect(store.messages[0].metadata.mentions[0].npub).toBe(retired);
  });

  it('scopes workroom mentions to channel-visible members through assigned groups', async () => {
    const store = await createStore();
    store.selectedChannelId = 'channel-ops';
    store.channels = [{ record_id: 'channel-ops', group_ids: ['group-agents'], record_state: 'active' }];
    store.currentWorkspaceOwnerNpub = 'npub-owner';
    store.groups = [
      { group_id: 'group-agents', owner_npub: 'npub-owner', name: 'Agents', member_npubs: ['npub-testagent'] },
      { group_id: 'group-other', owner_npub: 'npub-owner', name: 'Other', member_npubs: ['npub-sam'] },
    ];
    store.pgWorkspaceMembers = [
      { npub: 'npub-testagent', display_name: 'Test Agent' },
      { npub: 'npub-sam', display_name: 'Sam' },
    ];
    store.addressBookPeople = [];
    store.getSenderName = (npub) => ({ 'npub-testagent': 'Test Agent', 'npub-sam': 'Sam' }[npub] || npub);
    store.getChannelParticipants = () => [];

    expect(store.searchMentions('agent', { visibleOnly: true })).toEqual([{
      type: 'agent', id: 'npub-testagent', label: 'Test Agent', sublabel: 'Agent',
    }]);
    expect(store.searchMentions('sam', { visibleOnly: true })).toEqual([]);
  });

  it('finds locally indexed docs that are not in the visible docs list yet', async () => {
    const store = await createStore();
    store.documents = [];
    store.mentionDocumentIndex = [
      {
        record_id: 'doc-new',
        title: 'New Local Spec',
        record_state: 'active',
        updated_at: '2026-06-23T01:00:00.000Z',
      },
      {
        record_id: 'doc-deleted',
        title: 'Deleted Spec',
        record_state: 'deleted',
        updated_at: '2026-06-23T02:00:00.000Z',
      },
    ];

    expect(store.searchMentions('doc:new local')).toEqual([{
      type: 'doc',
      id: 'doc-new',
      label: 'New Local Spec',
      sublabel: 'Doc',
    }]);
  });

  it('keeps a newly patched doc available for mentions after visible docs are refreshed', async () => {
    const store = await createStore();
    store.documents = [];
    store.mentionDocumentIndex = [];
    store.refreshOpenDocFromLatestDocument = vi.fn();

    store.patchDocumentLocal({
      record_id: 'doc-new',
      title: 'New Local Spec',
      record_state: 'active',
      updated_at: '2026-06-23T01:00:00.000Z',
    });
    store.applyDocuments([]);

    expect(store.searchMentions('doc:new local')).toEqual([{
      type: 'doc',
      id: 'doc-new',
      label: 'New Local Spec',
      sublabel: 'Doc',
    }]);
  });

  it('navigates channel mentions to the selected chat channel', async () => {
    const store = await createStore();
    store.navSection = 'tasks';
    store.mobileNavOpen = true;
    store.startWorkspaceLiveQueries = vi.fn();
    store.selectChannel = vi.fn();

    store.handleMentionNavigate('channel', 'channel-ops');

    expect(store.navSection).toBe('chat');
    expect(store.mobileNavOpen).toBe(false);
    expect(store.startWorkspaceLiveQueries).toHaveBeenCalledTimes(1);
    expect(store.selectChannel).toHaveBeenCalledWith('channel-ops');
  });

  it.each(['person', 'agent'])('opens the identity card for a rendered %s mention using its canonical npub', async (type) => {
    const store = await createStore();
    const npub = `npub1${type}`;
    const link = {
      dataset: { mentionType: type, mentionId: npub },
      getBoundingClientRect: vi.fn(() => ({ left: 120, bottom: 240 })),
    };
    const event = { preventDefault: vi.fn(), clientX: 14, clientY: 18 };
    store.openIdentityCard = vi.fn();
    store.handleMentionNavigate = vi.fn();

    expect(store.handleMentionLinkClick(event, link)).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(store.openIdentityCard).toHaveBeenCalledWith({
      currentTarget: link,
      clientX: 14,
      clientY: 18,
    }, npub);
    expect(store.handleMentionNavigate).not.toHaveBeenCalled();
  });

  it('preserves record navigation for non-actor rendered mentions', async () => {
    const store = await createStore();
    const link = { dataset: { mentionType: 'channel', mentionId: 'channel-ops' } };
    const event = { preventDefault: vi.fn() };
    store.openIdentityCard = vi.fn();
    store.handleMentionNavigate = vi.fn();

    expect(store.handleMentionLinkClick(event, link)).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(store.handleMentionNavigate).toHaveBeenCalledWith('channel', 'channel-ops');
    expect(store.openIdentityCard).not.toHaveBeenCalled();
  });

  it('routes task mentions through deferred task resolution outside chat', async () => {
    const store = await createStore();
    store.navSection = 'docs';
    store.openChatTaskModal = vi.fn(async () => true);

    store.handleMentionNavigate('task', 'task-42');

    expect(store.openChatTaskModal).toHaveBeenCalledWith('task-42');
  });

  it('does not open the enclosing Deck card when a rendered mention pill is clicked', async () => {
    const store = await createStore();
    const mentionLink = { className: 'mention-link' };
    const target = {
      closest: vi.fn((selector) => selector.includes('.mention-link') ? mentionLink : null),
    };

    expect(store.shouldOpenDeckCard({ target })).toBe(false);
    expect(target.closest).toHaveBeenCalledWith('.mention-link, [data-deck-card-action]');
    expect(store.shouldOpenDeckCard({ target: { closest: () => null } })).toBe(true);
    expect(store.shouldOpenDeckCard()).toBe(true);
  });

  it('does not open the enclosing Deck card from a nested card action', async () => {
    const store = await createStore();
    const action = { dataset: { deckCardAction: '' } };
    const target = {
      closest: vi.fn((selector) => selector.includes('[data-deck-card-action]') ? action : null),
    };

    expect(store.shouldOpenDeckCard({ target })).toBe(false);
    expect(target.closest).toHaveBeenCalledWith('.mention-link, [data-deck-card-action]');
  });

  it('dispatches copied chat references through linked-thread resolution', async () => {
    const store = await createStore();
    store.openLinkedThread = vi.fn().mockResolvedValue(true);
    await store.handleMentionNavigate('chat', 'channel-ops#msg-1');
    expect(store.openLinkedThread).toHaveBeenCalledWith('channel-ops#msg-1');
    await store.handleMentionNavigate('message', 'source-message');
    expect(store.openLinkedThread).toHaveBeenCalledWith('source-message');
  });

  it('navigates copied folder and report references', async () => {
    const store = await createStore();
    store.navigateToFolder = vi.fn();
    store.startWorkspaceLiveQueries = vi.fn();
    store.openReportModalById = vi.fn();
    store.syncRoute = vi.fn();
    store.mobileNavOpen = true;

    store.handleMentionNavigate('directory', 'folder-1');
    store.handleMentionNavigate('report', 'report-1');

    expect(store.navigateToFolder).toHaveBeenCalledWith('folder-1');
    expect(store.navSection).toBe('reports');
    expect(store.mobileNavOpen).toBe(false);
    expect(store.startWorkspaceLiveQueries).toHaveBeenCalledTimes(1);
    expect(store.openReportModalById).toHaveBeenCalledWith('report-1');
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });
});

it('does not offer cached agents from another workspace while the current PG roster is empty', async () => {
  const store = await createStore();
  store.selectedWorkspaceKey = 'workspace-b';
  store.pgBackendMode = true;
  store.pgWorkspaceMembers = [];
  store.addressBookPeople = [{ npub: 'npub1oldagent', label: 'Old Agent', kind: 'agent' }];
  store.workspaceHarnessAgents = [{ npub: 'npub1oldagent', name: 'Old Agent' }];
  expect(store.buildMentionPeople().some(row => row.id === 'npub1oldagent')).toBe(false);
});

it('refreshes an already open mention menu when the roster finishes hydrating', async () => {
  const store = await createStore();
  store.mentionActive = true;
  store._mentionTargetEl = { dataset: {} };
  store.mentionQuery = 'Agent';
  store.mentionResults = [];
  store.pgWorkspaceMembers = [{ actor_id: 'agent-current', npub: 'npub1currentagent', kind: 'agent', display_name: 'Current Agent' }];
  store.refreshActiveMentionResults();
  expect(store.mentionResults).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'npub1currentagent', type: 'agent', label: 'Current Agent' })]));
});

it('offers canonical roster agents in the actual channel-visible composer before groups load', async () => {
  const store = await createStore();
  store.pgBackendMode = true;
  store.selectedChannelId = 'cold-channel';
  store.channels = [{ record_id: 'cold-channel', record_state: 'active' }];
  store.pgWorkspaceMembers = [{ actor_id: 'current-agent', npub: 'npub1currentagent', kind: 'agent', display_name: 'Current Agent' }];
  store.groups = [];
  expect(store.searchMentions('Current', { visibleOnly: true })).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'npub1currentagent', type: 'agent' }),
  ]));
});
