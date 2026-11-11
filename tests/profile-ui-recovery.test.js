import { describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
const { getCachedProfile, fetchProfileByNpub, upsertAddressBookPerson, fetchWorkspaceKeyMappings } = vi.hoisted(() => ({
  getCachedProfile: vi.fn(), fetchProfileByNpub: vi.fn(), upsertAddressBookPerson: vi.fn().mockResolvedValue(1), fetchWorkspaceKeyMappings: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getCachedProfile, upsertAddressBookPerson, getAddressBookPeople: vi.fn() }));
vi.mock('../src/api.js', () => ({ fetchWorkspaceKeyMappings }));
vi.mock('../src/profiles.js', () => ({ fetchProfileByNpub }));
import { peopleProfilesManagerMixin } from '../src/people-profiles-manager.js';
const npub = nip19.npubEncode('1'.repeat(64));
function store() {
  return { ...peopleProfilesManagerMixin, _profileWorkspaceGeneration: 0, _wsKeyDisplayMap: {}, workspaceOwnerNpub: 'workspace-a', chatProfiles: {}, addressBookPeople: [], getShortNpub: value => value.slice(0, 10) };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

describe('profile hydration and UI invalidation', () => {
  it('prefers the latest saved label across legacy address-book aliases and retains missing avatar fields', () => {
    const s = store();
    s.addressBookPeople = [
      { npub, label: 'Latest' },
      { npub: '1'.repeat(64), label: 'Older', avatar_url: 'https://example.com/retained.png' },
    ];
    expect(s.getSenderName(npub)).toBe('Latest');
    expect(s.getSenderName('1'.repeat(64))).toBe('Latest');
    expect(s.getSenderAvatar(npub)).toBe('https://example.com/retained.png');
  });

  it('prefers public kind 0 names and falls back on workspace names', () => {
    const s = store();
    s.pgWorkspaceMembers = [{ npub, display_name: 'Workspace name' }];
    s.chatProfiles[npub] = { name: 'Public name' };
    expect(s.getSenderName(npub)).toBe('Public name');
    s.pgWorkspaceMembers = [{ npub, display_name: '' }];
    expect(s.getSenderName(npub)).toBe('Public name');
  });

  it('rejects delayed workspace-key mappings after switching away and back', async () => {
    const mappings = deferred(); fetchWorkspaceKeyMappings.mockReturnValue(mappings.promise);
    const s = store(); const done = s.refreshWorkspaceKeyMappings();
    s._profileWorkspaceGeneration += 2;
    mappings.resolve({ mappings: [{ workspace_user_key_npub: 'old-workspace-key', user_npub: npub }] });
    await done;
    expect(s._wsKeyDisplayMap).toEqual({});
  });

  it('shows persisted data while relay refresh is delayed, and applies recovered names immediately', async () => {
    const relay = deferred(); getCachedProfile.mockResolvedValue({ name: 'Saved', picture: 'https://example.com/a.png' });
    fetchProfileByNpub.mockReturnValue(relay.promise);
    const s = store(); const done = s.resolveChatProfile(npub);
    await vi.waitFor(() => expect(s.getSenderName(npub)).toBe('Saved'));
    expect(s.getSenderAvatar(npub)).toBe('https://example.com/a.png');
    relay.resolve({ name: 'Recovered' }); await done;
    expect(s.getSenderName('1'.repeat(64))).toBe('Recovered');
    expect(s.getSenderAvatar(npub)).toBe('https://example.com/a.png');
  });

  it('retains good in-memory names through failed lookups and delayed empty hydration', async () => {
    getCachedProfile.mockResolvedValue(null); fetchProfileByNpub.mockRejectedValue(new Error('worker failure'));
    const s = store(); s.chatProfiles[npub] = { name: 'Known', picture: 'https://example.com/a.png' };
    await s.resolveChatProfile(npub, { force: true });
    expect(s.getSenderName(npub)).toBe('Known');
    expect(s.getSenderAvatar(npub)).toBe('https://example.com/a.png');
  });

  it('rejects late hydration and relay callbacks after a workspace switch, including switch-away-and-back', async () => {
    const hydration = deferred(); const relay = deferred(); getCachedProfile.mockReturnValue(hydration.promise); fetchProfileByNpub.mockReturnValue(relay.promise);
    const s = store(); const done = s.resolveChatProfile(npub);
    s._profileWorkspaceGeneration += 2; s.chatProfiles = {}; s._wsKeyDisplayMap = {};
    hydration.resolve({ name: 'Old hydration' }); relay.resolve({ name: 'Old relay' }); await done;
    expect(s.chatProfiles).toEqual({});
  });

  it('retries stale known data after a minute even when a failed relay returned cached data', async () => {
    getCachedProfile.mockResolvedValue({ name: 'Known' }); fetchProfileByNpub.mockResolvedValue({ name: 'Known' });
    const s = store(); await s.resolveChatProfile(npub);
    s.chatProfiles[npub].profileLookupAttemptedAt -= 61_000;
    fetchProfileByNpub.mockResolvedValue({ name: 'Recovered' });
    await s.resolveChatProfile(npub);
    expect(s.getSenderName(npub)).toBe('Recovered');
  });
});

it('hydrates exact DM identity despite a delegated alias and reacts to late kind 0 updates', async () => {
  const s = store();
  const alias = nip19.npubEncode('2'.repeat(64));
  s._wsKeyDisplayMap = { [npub]: alias };
  s.chatProfiles[alias] = { name: 'Different identity' };
  getCachedProfile.mockResolvedValue({ display_name: 'Cached person', name: 'handle' });
  const relay = deferred(); fetchProfileByNpub.mockReturnValue(relay.promise);
  expect(s.getExactSenderName(npub)).toBe('Unknown person');
  await vi.waitFor(() => expect(s.getExactSenderName(npub)).toBe('Cached person'));
  relay.resolve({ display_name: 'Updated person', name: 'updated-handle' });
  await vi.waitFor(() => expect(s.getExactSenderName(npub)).toBe('Updated person'));
  expect(s._wsKeyDisplayMap[npub]).toBe(alias);
  expect(s.getSenderName(npub)).toBe('Different identity');
});
it('rejects persisted key labels while accepting a later usable name', () => {
  const s = store(); s.resolveChatProfile = vi.fn();
  s.pgWorkspaceMembers = [{ npub, display_name: npub }];
  s.addressBookPeople = [{ npub, label: 'npub1old…key' }];
  s.chatProfiles[npub] = { name: 'f'.repeat(64) };
  expect(s.getSenderName(npub)).toBe('Unknown person');
  expect(s.getExactSenderName(npub)).toBe('Unknown person');
  s.addressBookPeople = [{ npub, label: 'Recovered name' }];
  expect(s.getExactSenderName(npub)).toBe('Recovered name');
});

it('updates DM and sender labels when another tab replaces the cached name', () => {
  const s = store(); s.resolveChatProfile = vi.fn();
  s.chatProfiles[npub] = { name: 'Earlier name' };
  s.addressBookPeople = [{ npub, label: 'Earlier name' }];
  expect(s.getExactSenderName(npub)).toBe('Earlier name');
  s.addressBookPeople = [{ npub, label: 'Updated in another tab' }];
  expect(s.getExactSenderName(npub)).toBe('Updated in another tab');
  expect(s.getSenderName(npub)).toBe('Updated in another tab');
});
