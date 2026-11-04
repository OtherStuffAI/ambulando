import { describe, expect, it } from 'vitest';
import { resolveChannelLabel, resolveChannelParticipants } from '../src/channel-labels.js';

describe('channel labels', () => {
  it('prefers the stored title for named channels', () => {
    const label = resolveChannelLabel(
      {
        record_id: 'channel-1',
        title: 'Example Workspace',
        participant_npubs: ['npub_me', 'npub_a', 'npub_b'],
      },
      {
        sessionNpub: 'npub_me',
        getParticipants: (channel) => channel.participant_npubs,
        getSenderName: (npub) => ({ npub_a: 'Alice', npub_b: 'Bob' }[npub] || npub),
      },
    );

    expect(label).toBe('Example Workspace');
  });

  it('uses participant names for DM-labelled channels', () => {
    const label = resolveChannelLabel(
      {
        record_id: 'channel-2',
        title: 'DM: Alice',
        participant_npubs: ['npub_me', 'npub_a'],
      },
      {
        sessionNpub: 'npub_me',
        getParticipants: (channel) => channel.participant_npubs,
        getSenderName: (npub) => ({ npub_a: 'Alice' }[npub] || npub),
      },
    );

    expect(label).toBe('Alice');
  });

  it('uses the other participant name for PG DM channels even when the stored title has an npub', () => {
    const otherNpub = 'npub1alice0000000000000000000000000000000000000000000000000000000';
    const label = resolveChannelLabel(
      {
        record_id: 'channel-3',
        title: `DM: ${otherNpub}`,
        channel_type: 'dm',
        participant_npubs: ['npub_me', otherNpub],
      },
      {
        sessionNpub: 'npub_me',
        getParticipants: (channel) => channel.participant_npubs,
        getSenderName: (npub) => ({ [otherNpub]: 'Alice Example' }[npub] || npub),
      },
    );

    expect(label).toBe('Alice Example');
  });

  it('treats channels in the DM scope as DMs', () => {
    const label = resolveChannelLabel(
      {
        record_id: 'channel-4',
        title: 'Saved title that should not win',
        scope_id: '__dm__',
        participant_npubs: ['npub_me', 'npub_bob'],
      },
      {
        sessionNpub: 'npub_me',
        getParticipants: (channel) => channel.participant_npubs,
        getSenderName: (npub) => ({ npub_bob: 'Bob' }[npub] || npub),
      },
    );

    expect(label).toBe('Bob');
  });

  it('can derive DM participants from the channel description', () => {
    const label = resolveChannelLabel(
      {
        record_id: 'channel-5',
        title: 'DM: npub_charlie',
        description: 'dm:npub_charlie|npub_me',
        participant_npubs: [],
      },
      {
        sessionNpub: 'npub_me',
        getParticipants: (channel) => channel.participant_npubs,
        getSenderName: (npub) => ({ npub_charlie: 'Charlie' }[npub] || npub),
      },
    );

    expect(label).toBe('Direct message · identity unavailable');
  });

  it('resolves raw npub DM titles through the profile cache fallback', () => {
    const otherNpub = 'npub1ujfahuwppkq0xkq7fyzfxzc5qnxxcyuspms8tpr5l222h6xye5fsccv64k';
    const label = resolveChannelLabel(
      {
        record_id: 'channel-6',
        title: `DM: ${otherNpub}`,
        participant_npubs: [],
      },
      {
        sessionNpub: 'npub_me',
        getParticipants: (channel) => channel.participant_npubs,
        getSenderName: (npub) => ({ [otherNpub]: 'Dave' }[npub] || npub),
      },
    );

    expect(label).toBe('Direct message · identity unavailable');
  });

  it('resolves bare raw npub DM titles through the profile cache fallback', () => {
    const otherNpub = 'npub1979aung6qusfx4d55ujs5hz39r5ghp9am3se4d7t4r2knvjqaljqevzcrp';
    const channel = {
      record_id: 'channel-7',
      title: otherNpub,
      scope_id: '__dm__',
      participant_npubs: [],
    };
    const label = resolveChannelLabel(
      channel,
      {
        sessionNpub: 'npub_me',
        getParticipants: (candidate) => resolveChannelParticipants(candidate),
        getSenderName: (npub) => ({ [otherNpub]: 'Frank' }[npub] || npub),
      },
    );

    expect(label).toBe('Direct message · identity unavailable');
    expect(resolveChannelParticipants(channel)).toEqual([]);
  });

  it('compacts raw npub DM labels when no profile name is cached', () => {
    const otherNpub = 'npub1erin00000000000000000000000000000000000000000000000000000000';
    const label = resolveChannelLabel(
      {
        record_id: 'channel-8',
        title: `DM: ${otherNpub}`,
        channel_type: 'dm',
        participant_npubs: ['npub_me', otherNpub],
      },
      {
        sessionNpub: 'npub_me',
        getParticipants: (channel) => channel.participant_npubs,
        getSenderName: (npub) => npub,
      },
    );

    expect(label).toBe('npub1erin0...000000');
  });
});
