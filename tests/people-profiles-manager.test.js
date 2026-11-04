import { describe, expect, it, vi } from 'vitest';
import { peopleProfilesManagerMixin } from '../src/people-profiles-manager.js';

function createStore(overrides = {}) {
  const store = {
    chatProfiles: {},
    addressBookPeople: [],
    groups: [],
    docEditorShares: [],
    docShareQuery: '',
    newGroupMemberQuery: '',
    newGroupMembers: [],
    editGroupMemberQuery: '',
    editGroupMembers: [],
    taskAssigneeQuery: '',
    editingTask: null,
    defaultAgentQuery: '',
    defaultAgentNpub: '',
    identityCard: { open: false, npub: '', x: 0, y: 0, copied: false },
    getShortNpub: (npub) => npub?.slice(0, 8) || '',
    ...overrides,
  };
  const descriptors = Object.getOwnPropertyDescriptors(peopleProfilesManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }
  return store;
}

function bindMethod(methodName, overrides = {}) {
  const store = createStore(overrides);
  const method = store[methodName];
  if (typeof method === 'function') return { fn: method.bind(store), store };
  return { store };
}

// --- profile resolution ---
describe('profile resolution', () => {
  it('getCachedPerson returns matching person', () => {
    const { fn } = bindMethod('getCachedPerson', {
      addressBookPeople: [{ npub: 'npub1a', label: 'Alice' }],
    });
    expect(fn('npub1a')).toEqual({ npub: 'npub1a', label: 'Alice' });
  });

  it('getCachedPerson returns null for no match', () => {
    const { fn } = bindMethod('getCachedPerson', { addressBookPeople: [] });
    expect(fn('npub1x')).toBeNull();
  });

  it('getCachedPerson returns null for empty input', () => {
    const { fn } = bindMethod('getCachedPerson');
    expect(fn('')).toBeNull();
    expect(fn(null)).toBeNull();
  });

  it('getSenderName returns profile name when available', () => {
    const { fn } = bindMethod('getSenderName', {
      chatProfiles: { npub1a: { name: 'Alice', picture: null } },
    });
    expect(fn('npub1a')).toBe('Alice');
  });

  it('getSenderName returns cached label as fallback', () => {
    const { fn } = bindMethod('getSenderName', {
      addressBookPeople: [{ npub: 'npub1a', label: 'Cached Alice' }],
    });
    expect(fn('npub1a')).toBe('Cached Alice');
  });

  it('getSenderName returns short npub as last fallback', () => {
    const { fn } = bindMethod('getSenderName');
    expect(fn('npub1abcdefgh')).toBe('npub1abc');
  });

  it('getSenderName queues profile resolution for full npub fallbacks', () => {
    const resolveChatProfile = vi.fn();
    const { fn } = bindMethod('getSenderName', { resolveChatProfile });
    const npub = 'npub1alice0000000000000000000000000000000000000000000000000000000';
    expect(fn(npub)).toBe('npub1ali');
    expect(resolveChatProfile).toHaveBeenCalledWith(npub);
  });

  it('getSenderName does not queue profile resolution for compact npub fallbacks', () => {
    const resolveChatProfile = vi.fn();
    const { fn } = bindMethod('getSenderName', { resolveChatProfile });
    expect(fn('npub1alic...000000')).toBe('npub1ali');
    expect(resolveChatProfile).not.toHaveBeenCalled();
  });

  it('getSenderName returns Unknown for empty', () => {
    const { fn } = bindMethod('getSenderName');
    expect(fn('')).toBe('Unknown');
    expect(fn(null)).toBe('Unknown');
  });

  it('getSenderIdentity returns nip05 when available', () => {
    const { fn } = bindMethod('getSenderIdentity', {
      chatProfiles: { npub1a: { name: 'Alice', nip05: 'alice@example.com' } },
    });
    expect(fn('npub1a')).toBe('alice@example.com');
  });

  it('getSenderIdentity returns short npub when name exists but no nip05', () => {
    const { fn } = bindMethod('getSenderIdentity', {
      chatProfiles: { npub1a: { name: 'Alice', nip05: null } },
    });
    expect(fn('npub1a')).toBe('npub1a'.slice(0, 8));
  });

  it('getSenderIdentity returns empty for unknown', () => {
    const { fn } = bindMethod('getSenderIdentity');
    expect(fn('npub1unknown')).toBe('');
  });

  it('getSenderSecondaryLabel prefers nip05 and otherwise compacts npubs', () => {
    const { store } = bindMethod('getSenderSecondaryLabel', {
      addressBookPeople: [{
        npub: 'npub1aliceabcdefghijklmnop',
        label: 'Alice',
        nip05: 'alice@example.com',
      }],
    });
    expect(store.getSenderSecondaryLabel('npub1aliceabcdefghijklmnop')).toBe('alice@example.com');
    expect(store.getSenderSecondaryLabel('npub1bobabcdefghijklmnop')).toBe('npub1b...mnop');
  });

  it('getSenderAvatar returns profile picture', () => {
    const { fn } = bindMethod('getSenderAvatar', {
      chatProfiles: { npub1a: { picture: 'https://img.example.com/a.png' } },
    });
    expect(fn('npub1a')).toBe('https://img.example.com/a.png');
  });

  it('getSenderAvatar returns cached avatar_url', () => {
    const { fn } = bindMethod('getSenderAvatar', {
      addressBookPeople: [{ npub: 'npub1a', avatar_url: 'https://cached.example.com/a.png' }],
    });
    expect(fn('npub1a')).toBe('https://cached.example.com/a.png');
  });

  it('getSenderAvatar preserves the Nostr profile URL without an undocumented proxy rewrite', () => {
    const npub = 'npub1alice0000000000000000000000000000000000000000000000000000000';
    const satelliteUrl = 'https://cdn.satellite.earth/avatar.png';
    const { fn } = bindMethod('getSenderAvatar', {
      addressBookPeople: [{ npub, avatar_url: satelliteUrl }],
    });
    expect(fn(npub)).toBe(satelliteUrl);
  });

  it('unwraps previously cached Fountain redirect URLs to their original profile image', () => {
    const npub = 'npub1alice0000000000000000000000000000000000000000000000000000000';
    const satelliteUrl = 'https://cdn.satellite.earth/avatar.png';
    const fountainUrl = `https://images.fountain.fm/profile/${encodeURIComponent(npub)}/large?original=${encodeURIComponent(satelliteUrl)}`;
    const { fn } = bindMethod('getSenderAvatar', {
      addressBookPeople: [{ npub, avatar_url: fountainUrl }],
    });

    expect(fn(npub)).toBe(satelliteUrl);
  });

  it('keeps a reachable avatar visible', () => {
    const { fn } = bindMethod('canRenderAvatarImage');
    expect(fn('https://img.example.com/alice.png')).toBe(true);
  });

  it('falls back after a browser image error without leaking alt text', () => {
    const url = 'https://img.example.com/broken.png';
    const image = { currentSrc: url, src: url, alt: 'Profile picture', hidden: false };
    const { fn, store } = bindMethod('handleAvatarImageError', {
      failedAvatarImageUrls: {},
    });

    fn({ currentTarget: image }, url);

    expect(image.alt).toBe('');
    expect(image.hidden).toBe(true);
    expect(store.canRenderAvatarImage(url)).toBe(false);
  });

  it('allows an avatar to recover when profile refresh resolves a different URL', () => {
    const failedUrl = 'https://img.example.com/broken.png';
    const recoveredUrl = 'https://img.example.com/recovered.png';
    const { fn } = bindMethod('canRenderAvatarImage', {
      failedAvatarImageUrls: { [failedUrl]: true },
    });

    expect(fn(failedUrl)).toBe(false);
    expect(fn(recoveredUrl)).toBe(true);
  });

  it('suppresses only the failed resolved URL from getSenderAvatar', () => {
    const failedUrl = 'https://img.example.com/broken.png';
    const recoveredUrl = 'https://img.example.com/recovered.png';
    const { fn, store } = bindMethod('getSenderAvatar', {
      chatProfiles: { npub1a: { picture: failedUrl } },
      failedAvatarImageUrls: { [failedUrl]: true },
    });

    expect(fn('npub1a')).toBeNull();
    store.chatProfiles.npub1a.picture = recoveredUrl;
    expect(fn('npub1a')).toBe(recoveredUrl);
  });

  it('getSenderAvatar queues profile resolution for full npub avatar misses', () => {
    const resolveChatProfile = vi.fn();
    const { fn } = bindMethod('getSenderAvatar', { resolveChatProfile });
    const npub = 'npub1alice0000000000000000000000000000000000000000000000000000000';
    expect(fn(npub)).toBeNull();
    expect(resolveChatProfile).toHaveBeenCalledWith(npub, { requirePicture: true });
  });

  it('getSenderAvatar does not queue profile resolution when cached avatar exists', () => {
    const resolveChatProfile = vi.fn();
    const { fn } = bindMethod('getSenderAvatar', {
      resolveChatProfile,
      addressBookPeople: [{
        npub: 'npub1alice0000000000000000000000000000000000000000000000000000000',
        avatar_url: 'https://cached.example.com/alice.png',
      }],
    });
    const npub = 'npub1alice0000000000000000000000000000000000000000000000000000000';
    expect(fn(npub)).toBe('https://cached.example.com/alice.png');
    expect(resolveChatProfile).not.toHaveBeenCalled();
  });

  it('getSenderAvatar resolves workspace key npubs to real profile avatars', () => {
    const { fn } = bindMethod('getSenderAvatar', {
      _wsKeyDisplayMap: { npub1workspacekey: 'npub1user' },
      addressBookPeople: [{ npub: 'npub1user', avatar_url: 'https://cached.example.com/user.png' }],
    });
    expect(fn('npub1workspacekey')).toBe('https://cached.example.com/user.png');
  });

  it('getSenderName resolves workspace key npubs to real profile names', () => {
    const { fn } = bindMethod('getSenderName', {
      _wsKeyDisplayMap: { npub1workspacekey: 'npub1user' },
      addressBookPeople: [{ npub: 'npub1user', label: 'Test Operator' }],
    });
    expect(fn('npub1workspacekey')).toBe('Test Operator');
  });

  it('getSenderAvatar returns null for unknown', () => {
    const { fn } = bindMethod('getSenderAvatar');
    expect(fn('npub1x')).toBeNull();
    expect(fn(null)).toBeNull();
  });

  it('getSenderProfile includes cached bio, nip05, avatar, and short npub', () => {
    const { fn } = bindMethod('getSenderProfile', {
      addressBookPeople: [{
        npub: 'npub1abcdefghijklmnopqrstuv2fmy',
        label: 'Alice',
        avatar_url: 'https://cached.example.com/a.png',
        bio: 'Builds careful things.',
        nip05: 'alice@example.com',
      }],
    });
    expect(fn('npub1abcdefghijklmnopqrstuv2fmy')).toEqual({
      npub: 'npub1abcdefghijklmnopqrstuv2fmy',
      name: 'Alice',
      identity: 'alice@example.com',
      avatarUrl: 'https://cached.example.com/a.png',
      bio: 'Builds careful things.',
      shortNpub: 'npub1a...2fmy',
    });
  });

  it('identityCardProfile resolves from current popover state', () => {
    const store = createStore({
      identityCard: { open: true, npub: 'npub1aliceabcdef2fmy', x: 12, y: 18, copied: false },
      addressBookPeople: [{ npub: 'npub1aliceabcdef2fmy', label: 'Alice' }],
    });
    expect(store.identityCardProfile.name).toBe('Alice');
    expect(store.identityCardProfile.shortNpub).toBe('npub1a...2fmy');
  });

  it('resolveChatProfile skips if already loading', () => {
    const { fn, store } = bindMethod('resolveChatProfile', {
      chatProfiles: { npub1a: { loading: true } },
    });
    fn('npub1a');
    // Should not overwrite
    expect(store.chatProfiles.npub1a.loading).toBe(true);
  });

  it('resolveChatProfile skips if already resolved', () => {
    const { fn, store } = bindMethod('resolveChatProfile', {
      chatProfiles: { npub1a: { name: 'Alice', picture: null, loading: false } },
    });
    fn('npub1a');
    expect(store.chatProfiles.npub1a.name).toBe('Alice');
  });

  it('resolveChatProfile revalidates a name-only profile when a picture is required', () => {
    const { fn, store } = bindMethod('resolveChatProfile', {
      chatProfiles: { npub1a: { name: 'Alice', picture: null, loading: false } },
    });
    fn('npub1a', { requirePicture: true });
    expect(store.chatProfiles.npub1a).toMatchObject({
      name: 'Alice',
      picture: null,
      loading: true,
    });
  });

  it('resolveChatProfile sets loading state for new profile', () => {
    const { fn, store } = bindMethod('resolveChatProfile');
    fn('npub1new');
    expect(store.chatProfiles.npub1new.loading).toBe(true);
  });

  it('resolveChatProfile does not retry a recent miss during the cooldown', () => {
    const { fn, store } = bindMethod('resolveChatProfile', {
      chatProfiles: {
        npub1miss: {
          name: null,
          picture: null,
          loading: false,
          profileLookupAttemptedAt: Date.now(),
        },
      },
    });
    fn('npub1miss');
    expect(store.chatProfiles.npub1miss.loading).toBe(false);
  });

  it('resolveChatProfile retries an older miss', () => {
    const { fn, store } = bindMethod('resolveChatProfile', {
      chatProfiles: {
        npub1miss: {
          name: null,
          picture: null,
          loading: false,
          profileLookupAttemptedAt: Date.now() - 120_000,
        },
      },
    });
    fn('npub1miss');
    expect(store.chatProfiles.npub1miss.loading).toBe(true);
  });
});

// --- people search ---
describe('findPeopleSuggestions', () => {
  it('returns empty for empty query', () => {
    const { fn } = bindMethod('findPeopleSuggestions', {
      addressBookPeople: [{ npub: 'npub1a', label: 'Alice' }],
    });
    expect(fn('')).toEqual([]);
  });

  it('finds by npub substring', () => {
    const { fn } = bindMethod('findPeopleSuggestions', {
      addressBookPeople: [
        { npub: 'npub1alice', label: 'Alice' },
        { npub: 'npub1bob', label: 'Bob' },
      ],
    });
    const results = fn('alice');
    expect(results).toHaveLength(1);
    expect(results[0].npub).toBe('npub1alice');
  });

  it('uses compact cached identity text in people suggestion subtitles', () => {
    const { fn } = bindMethod('findPeopleSuggestions', {
      addressBookPeople: [
        { npub: 'npub1aliceabcdefghijklmnop', label: 'Alice' },
      ],
    });
    const [result] = fn('alice');
    expect(result.subtitle).toBe('npub1a...mnop');
  });

  it('excludes specified npubs', () => {
    const { fn } = bindMethod('findPeopleSuggestions', {
      addressBookPeople: [
        { npub: 'npub1alice', label: 'Alice' },
        { npub: 'npub1bob', label: 'Bob' },
      ],
    });
    const results = fn('npub1', ['npub1alice']);
    expect(results.every((r) => r.npub !== 'npub1alice')).toBe(true);
  });

  it('limits to 8 results', () => {
    const people = Array.from({ length: 15 }, (_, i) => ({
      npub: `npub1person${i}`,
      label: `Person ${i}`,
    }));
    const { fn } = bindMethod('findPeopleSuggestions', { addressBookPeople: people });
    expect(fn('person').length).toBeLessThanOrEqual(8);
  });
});

describe('findGroupMemberSuggestions', () => {
  it('returns empty for empty query', () => {
    const { fn } = bindMethod('findGroupMemberSuggestions');
    expect(fn('')).toEqual([]);
  });

  it('excludes selected members', () => {
    const { fn } = bindMethod('findGroupMemberSuggestions', {
      addressBookPeople: [
        { npub: 'npub1a', label: 'Alice' },
        { npub: 'npub1b', label: 'Bob' },
      ],
    });
    const results = fn('npub1', [{ npub: 'npub1a' }]);
    expect(results.every((r) => r.npub !== 'npub1a')).toBe(true);
  });

  it('keeps authoritative Tower actor kind, name, and photo on agent suggestions', () => {
    const { fn } = bindMethod('findGroupMemberSuggestions', {
      addressBookPeople: [{ npub: 'npub1agent', label: 'Old label', avatar_url: 'https://cached.example/agent.png' }],
      pgWorkspaceMembers: [{
        actor_id: 'actor-agent',
        npub: 'npub1agent',
        kind: 'agent',
        display_name: 'Tower Agent',
      }],
    });

    expect(fn('tower', [])).toEqual([expect.objectContaining({
      npub: 'npub1agent',
      actorId: 'actor-agent',
      kind: 'agent',
      label: 'Tower Agent',
      avatarUrl: 'https://cached.example/agent.png',
    })]);
  });
});

describe('findFlowApproverSuggestions', () => {
  it('returns empty for empty query', () => {
    const { fn } = bindMethod('findFlowApproverSuggestions');
    expect(fn('')).toEqual([]);
  });

  it('finds both people and groups while excluding selected tokens', () => {
    const { fn } = bindMethod('findFlowApproverSuggestions', {
      addressBookPeople: [
        { npub: 'npub1alice', label: 'Alice' },
        { npub: 'npub1bob', label: 'Bob' },
      ],
      groups: [
        { group_id: 'g1', name: 'Approvers', member_npubs: ['npub1alice'] },
        { group_id: 'g2', name: 'Stakeholders', member_npubs: ['npub1bob'] },
      ],
    });

    const results = fn('a', ['npub1alice', 'group:g2']);
    expect(results.some((item) => item.type === 'person' && item.token === 'npub1alice')).toBe(false);
    expect(results.some((item) => item.type === 'group' && item.token === 'group:g2')).toBe(false);
    expect(results.some((item) => item.type === 'group' && item.token === 'group:g1')).toBe(true);
  });
});

describe('mapGroupDraftMembers', () => {
  it('maps npubs to member objects', () => {
    const { fn } = bindMethod('mapGroupDraftMembers', {
      chatProfiles: { npub1a: { name: 'Alice' } },
      addressBookPeople: [{ npub: 'npub1a', label: 'Alice' }],
    });
    const result = fn(['npub1a', 'npub1b']);
    expect(result).toHaveLength(2);
    expect(result[0].npub).toBe('npub1a');
    expect(result[0].label).toBe('Alice');
  });

  it('deduplicates and trims', () => {
    const { fn } = bindMethod('mapGroupDraftMembers');
    const result = fn(['npub1a', '  npub1a  ', '', null]);
    expect(result).toHaveLength(1);
  });

  it('restores authoritative actor metadata for an existing agent member', () => {
    const { fn } = bindMethod('mapGroupDraftMembers', {
      pgWorkspaceMembers: [{ actor_id: 'actor-agent', npub: 'npub1agent', kind: 'agent', display_name: 'Agent One' }],
    });

    expect(fn(['npub1agent'])).toEqual([expect.objectContaining({
      actorId: 'actor-agent',
      kind: 'agent',
      label: 'Agent One',
    })]);
  });
});

describe('consumeGroupMemberQuery', () => {
  it('returns unchanged for empty query', () => {
    const { fn } = bindMethod('consumeGroupMemberQuery');
    const result = fn('', [{ npub: 'npub1a' }]);
    expect(result.added).toBe(false);
    expect(result.members).toHaveLength(1);
  });

  it('adds valid npub from query', () => {
    const npub = 'npub1' + 'x'.repeat(58);
    const { fn } = bindMethod('consumeGroupMemberQuery');
    const result = fn(npub, []);
    expect(result.added).toBe(true);
    expect(result.members).toHaveLength(1);
    expect(result.members[0].npub).toBe(npub);
  });

  it('does not add duplicate npub', () => {
    const npub = 'npub1' + 'x'.repeat(58);
    const { fn } = bindMethod('consumeGroupMemberQuery');
    const result = fn(npub, [{ npub }]);
    expect(result.added).toBe(false);
  });

  it('falls back to suggestion matching', () => {
    const { fn } = bindMethod('consumeGroupMemberQuery', {
      addressBookPeople: [{ npub: 'npub1alice', label: 'Alice' }],
    });
    const result = fn('alice', []);
    expect(result.added).toBe(true);
    expect(result.members[0].npub).toBe('npub1alice');
  });
});

// --- computed getters ---
describe('computed getters', () => {
  it('defaultAgentLabel returns name when set', () => {
    const store = createStore({
      defaultAgentNpub: 'npub1a',
      chatProfiles: { npub1a: { name: 'Bot' } },
    });
    expect(store.defaultAgentLabel).toBe('Bot');
  });

  it('defaultAgentLabel returns empty when not set', () => {
    const store = createStore({ defaultAgentNpub: '' });
    expect(store.defaultAgentLabel).toBe('');
  });

  it('canDoTaskWithDefaultAgent requires both', () => {
    expect(createStore({ defaultAgentNpub: '', editingTask: null }).canDoTaskWithDefaultAgent).toBe(false);
    expect(createStore({ defaultAgentNpub: 'npub1a', editingTask: null }).canDoTaskWithDefaultAgent).toBe(false);
    expect(createStore({ defaultAgentNpub: 'npub1a', editingTask: { id: 't1' } }).canDoTaskWithDefaultAgent).toBe(true);
  });

  it('groupMemberSuggestions delegates to findGroupMemberSuggestions', () => {
    const store = createStore({
      newGroupMemberQuery: 'alice',
      newGroupMembers: [],
      addressBookPeople: [{ npub: 'npub1alice', label: 'Alice' }],
    });
    expect(store.groupMemberSuggestions.length).toBe(1);
  });

  it('docShareSuggestions returns empty for empty query', () => {
    const store = createStore({ docShareQuery: '' });
    expect(store.docShareSuggestions).toEqual([]);
  });

  it('docShareSuggestions finds people and groups', () => {
    const store = createStore({
      docShareQuery: 'test',
      docEditorShares: [],
      addressBookPeople: [{ npub: 'npub1test', label: 'Test User' }],
      groups: [{ group_id: 'g1', name: 'Test Group', member_npubs: ['npub1a'] }],
    });
    const suggestions = store.docShareSuggestions;
    expect(suggestions.some((s) => s.type === 'person')).toBe(true);
    expect(suggestions.some((s) => s.type === 'group')).toBe(true);
  });

  it('getFlowApproverLabel and subtitle resolve people and groups', () => {
    const store = createStore({
      addressBookPeople: [{ npub: 'npub1alice', label: 'Alice' }],
      groups: [{ group_id: 'g1', name: 'Approvers', member_npubs: ['npub1alice'] }],
    });

    expect(store.getFlowApproverLabel('npub1alice')).toBe('Alice');
    expect(store.getFlowApproverSubtitle('npub1alice')).toBe('npub1alice');
    expect(store.getFlowApproverSubtitle('npub1aliceabcdefghijklmnop')).toBe('npub1a...mnop');
    expect(store.getFlowApproverLabel('group:g1')).toBe('Approvers');
    expect(store.getFlowApproverSubtitle('group:g1')).toBe('1 members');
  });
});

it('DM name lookup cannot alias a different key or use its cached profile', () => {
  const store = createStore({
    _wsKeyDisplayMap: { old: 'current' },
    pgWorkspaceMembers: [{ npub: 'current', display_name: 'Current agent' }],
    chatProfiles: { current: { name: 'Current profile' } },
    addressBookPeople: [{ npub: 'old', label: 'Old label' }],
  });
  expect(store.getExactSenderName('old')).toBe('Old label');
  expect(store.getExactSenderName('current')).toBe('Current agent');
});
