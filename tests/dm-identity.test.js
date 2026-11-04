import { it, expect } from 'vitest';
import { findExistingDmChannel } from '../src/dm-scope.js';
import { resolveChannelLabel, resolveChannelParticipants } from '../src/channel-labels.js';
it('requires authoritative exact participants despite stale names, metadata and descriptions', () => {
  const old = { kind: 'dm', title: 'DM: current', participant_npubs: ['me', 'old'], description: 'dm:current|me', metadata: { npub: 'current' } };
  const current = { kind: 'dm', participant_npubs: ['me', 'current'] };
  expect(findExistingDmChannel([old], ['me', 'current'])).toBeNull();
  expect(findExistingDmChannel([old, current], ['current', 'me'])).toBe(current);
  expect(findExistingDmChannel([{ ...current, archived_at: 'today' }], ['me', 'current'])).toBeNull();
  expect(findExistingDmChannel([{ ...current, record_state: 'archived' }], ['me', 'current'])).toBeNull();
  expect(resolveChannelParticipants({ ...old, participant_npubs: [] }, () => ['current'])).toEqual([]);
  const options = { sessionNpub: 'me', getSenderName: () => 'Same name' };
  expect(resolveChannelLabel(old, options)).toBe('Same name');
  expect(resolveChannelLabel(current, options)).toBe('Same name');
  expect(findExistingDmChannel([old, current], ['me', 'current'])).toBe(current);
});
