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

  it('keeps explicit workspace names ahead of public metadata and falls back on sparse member rows', () => {
    const s = store();
    s.pgWorkspaceMembers = [{ npub, display_name: 'Workspace name' }];
    s.chatProfiles[npub] = { name: 'Public name' };
    expect(s.getSenderName(npub)).toBe('Workspace name');
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
