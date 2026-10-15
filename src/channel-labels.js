import {
  DM_CHANNEL_DESCRIPTION_PREFIX,
  isDmChannel,
  normalizeDmParticipants,
  parseDmChannelDescription,
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
  return label;
}

function participantsFromDescription(description = '') {
  const text = String(description || '').trim();
  if (!text.toLowerCase().startsWith(DM_CHANNEL_DESCRIPTION_PREFIX)) return [];
  return normalizeDmParticipants(parseDmChannelDescription(text).split('|'));
}

function participantsFromTitle(title = '') {
  const matches = String(title || '').trim().match(/npub1[0-9a-z]{20,}/ig);
  return matches ? normalizeDmParticipants(matches) : [];
}

export function resolveChannelParticipants(channel, getParticipants, title = null) {
  const channelTitle = title ?? String(channel?.title || channel?.name || '').trim();
  const explicitParticipants = typeof getParticipants === 'function'
    ? getParticipants(channel)
    : channel?.participant_npubs;
  const participants = normalizeDmParticipants(explicitParticipants);
  if (participants.length) return participants;

  const descriptionParticipants = participantsFromDescription(channel?.description);
  if (descriptionParticipants.length) return descriptionParticipants;

  return participantsFromTitle(channelTitle);
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
    const titleLabel = title.replace(/^DM:\s*/i, '').trim();
    if (titleLabel && !/^npub1[0-9a-z]+$/i.test(titleLabel)) return titleLabel;
    return 'Direct message';
  }
  return title || String(channel.record_id || '').slice(0, 8);
}
