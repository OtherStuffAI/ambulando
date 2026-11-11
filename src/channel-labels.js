import {
  isDmChannel,
  normalizeDmParticipants,
} from './dm-scope.js';

import { readableIdentityLabel } from './profile-identity.js';

function resolveParticipantName(npub, getSenderName) {
  return readableIdentityLabel(getSenderName?.(npub)) || 'Unknown person';
}

export function resolveChannelParticipants(channel) {
  return normalizeDmParticipants(channel?.participant_npubs);
}

export function resolveChannelLabel(channel, { sessionNpub, getParticipants, getSenderName } = {}) {
  if (!channel) return '';

  const title = String(channel.title || channel.name || '').trim();
  const isDirectMessage = isDmChannel(channel);
  if (title && (!isDirectMessage || (!/^dm(?::|$)/i.test(title) && readableIdentityLabel(title)))) return title;

  const participants = resolveChannelParticipants(channel, getParticipants, title);
  const viewerNpub = String(sessionNpub || '').trim();
  if (isDirectMessage && participants.length === 1 && participants[0] === viewerNpub) return 'Note to self';
  const others = participants.filter((npub) => npub !== viewerNpub);
  if (others.length === 1) return resolveParticipantName(others[0], getSenderName);
  if (others.length > 1) {
    return others.map((npub) => resolveParticipantName(npub, getSenderName)).join(', ');
  }
  if (isDirectMessage) {
    return 'Direct message · identity unavailable';
  }
  return title || String(channel.record_id || '').slice(0, 8);
}
