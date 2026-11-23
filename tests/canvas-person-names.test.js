import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import { canvasPersonNames } from '../src/canvas/person-names.js';
import { cacheProfile, upsertAddressBookPerson } from '../src/db.js';
import { canvasBoardStore } from '../src/canvas/board-page.js';
import { channelsManagerMixin } from '../src/channels-manager.js';
import { wappManagementManagerMixin } from '../src/wapp-management-manager.js';

it('observes exact cached names, late arrival and rename without changing authors or custom labels', async () => {
  const npub = nip19.npubEncode('12'.repeat(32)), other = nip19.npubEncode('13'.repeat(32));
  const state = { ...canvasPersonNames(), ...canvasBoardStore() };
  const version = { id: 'version', author_npub: npub, summary: 'Keep history' };
  try {
    expect(state.personName(npub)).toBe('Unknown person');
    expect(state.personName('npub1malformed')).toBe('Unknown person');
    await cacheProfile(npub, { display_name: 'Ada' });
    await vi.waitFor(() => expect(state.boardVersionAuthor(version)).toBe('Ada'));
    await cacheProfile(npub, { name: 'Ada renamed' });
    await vi.waitFor(() => expect(state.personName(npub)).toBe('Ada renamed'));
    expect(state.personName(other)).toBe('Unknown person');
    await upsertAddressBookPerson({ npub, label: 'My custom label' });
    await vi.waitFor(() => expect(state.personName(npub)).toBe('My custom label'));
    state.releasePersonNames('canvas');
    expect(state.personNames).toEqual({});
    expect(version).toEqual({ id: 'version', author_npub: npub, summary: 'Keep history' });
  } finally { state.stopPersonNames(); }
});

it('uses the exact member resolver for key-like names and WApp labels, preserving custom labels and actor IDs', () => {
  const npub = nip19.npubEncode('14'.repeat(32));
  const member = { actor_id: 'actor', npub, display_name: npub };
  const exact = vi.fn(() => 'Known profile');
  const state = { ...channelsManagerMixin, ...wappManagementManagerMixin, pgWorkspaceMembers: [member], getExactSenderName: exact };
  // Object spread evaluates mixin getters, so use their original descriptor.
  Object.defineProperty(state, 'wappManagementMembers', Object.getOwnPropertyDescriptor(wappManagementManagerMixin, 'wappManagementMembers'));
  expect(state.getPgWorkspaceMemberLabel(member)).toBe('Known profile');
  expect(state.wappMemberName('actor')).toBe('Known profile');
  expect(exact).toHaveBeenCalledWith(npub);
  member.display_name = 'Custom colleague';
  expect(state.wappMemberName('actor')).toBe('Custom colleague');
  expect(state.wappMemberName('missing')).toBe('Unknown actor');
  expect(member.actor_id).toBe('actor');
});

it('validates bounded untrusted editor labels and preserves text without treating it as markup', async () => {
  const { validatedAuthorNames, boardAuthorName } = await import('../src/canvas/board-editor/person-labels.js');
  const npub = nip19.npubEncode('15'.repeat(32));
  const names = validatedAuthorNames({ [npub]: '<b>Ada</b>', npub1broken: 'Wrong', bad: 'No identity' });
  expect(boardAuthorName(npub, names)).toBe('<b>Ada</b>');
  expect(boardAuthorName('npub1broken', names)).toBe('Unknown person');
  expect(validatedAuthorNames({ [npub]: npub })).toEqual({});
  expect(validatedAuthorNames({ [npub]: 'a'.repeat(257) })).toEqual({});
  expect(validatedAuthorNames(null)).toEqual({});
});

it('member and WApp labels observe actual profile replacements without borrowing a delegated identity', async () => {
  const { peopleProfilesManagerMixin } = await import('../src/people-profiles-manager.js');
  const npub = nip19.npubEncode('16'.repeat(32)), other = nip19.npubEncode('17'.repeat(32));
  const member = { actor_id: 'exact-actor', npub, display_name: `${npub.slice(0, 14)}…` };
  const state = { ...peopleProfilesManagerMixin, ...channelsManagerMixin, ...wappManagementManagerMixin,
    pgWorkspaceMembers: [member], addressBookPeople: [], chatProfiles: { [other]: { name: 'Different person' } },
    _wsKeyDisplayMap: { [npub]: other }, resolveChatProfile: vi.fn() };
  Object.defineProperty(state, 'wappManagementMembers', Object.getOwnPropertyDescriptor(wappManagementManagerMixin, 'wappManagementMembers'));
  expect(state.wappMemberName('exact-actor')).toBe('Unknown person');
  state.chatProfiles = { ...state.chatProfiles, [npub]: { display_name: 'Available exact profile' } };
  expect(state.wappMemberName('exact-actor')).toBe('Available exact profile');
  state.chatProfiles = { ...state.chatProfiles, [npub]: { name: 'Renamed exact profile' } };
  expect(state.getPgWorkspaceMemberLabel(member)).toBe('Renamed exact profile');
  member.display_name = 'Custom teammate';
  expect(state.wappMemberName('exact-actor')).toBe('Custom teammate');
  expect(member).toEqual({ actor_id: 'exact-actor', npub, display_name: 'Custom teammate' });
});
