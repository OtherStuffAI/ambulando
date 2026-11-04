import {
  isDmChannel,
  normalizeDmParticipants,
} from './dm-scope.js';

function compactNpub(value = '') {
  const text = String(value || '').trim();
  if (text.length <= 16) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function resolveParticipantName(npub, getSenderName) {
  if (!npub) return '';
  if (typeof getSenderName !== 'function') return compactNpub(npub);
  const label = String(getSenderName(npub) || '').trim();
  if (!label || label === npub) return compactNpub(npub);
  return `${label} (${compactNpub(npub)})`;
}

export function resolveChannelParticipants(channel) {
  return normalizeDmParticipants(channel?.participant_npubs);
}

export function resolveChannelLabel(channel, { sessionNpub, getParticipants, getSenderName } = {}) {
  if (!channel) return '';

  const title = String(channel.title || channel.name || '').trim();
  const isDirectMessage = isDmChannel(channel);
  if (title && !isDirectMessage) return title;

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
