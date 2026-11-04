export const DM_SCOPE_ID = '__dm__';
export const DM_SCOPE_TITLE = 'DMs';
export const DM_SCOPE_KIND = 'dm';
export const DM_CHANNEL_DESCRIPTION_PREFIX = 'dm:';

export function createVirtualDmScope(ownerNpub = '') {
  return {
    record_id: DM_SCOPE_ID,
    owner_npub: ownerNpub || '',
    title: DM_SCOPE_TITLE,
    description: 'Direct message conversations',
    level: 'l1',
    parent_id: null,
    l1_id: DM_SCOPE_ID,
    l2_id: null,
    l3_id: null,
    l4_id: null,
    l5_id: null,
    group_ids: [],
    record_state: 'active',
    system_key: DM_SCOPE_KIND,
    pg_kind: DM_SCOPE_KIND,
    virtual: true,
  };
}

export function isDmScope(scopeOrId) {
  if (!scopeOrId) return false;
  if (typeof scopeOrId === 'string') return scopeOrId === DM_SCOPE_ID;
  const recordId = String(scopeOrId.record_id || '').trim();
  const systemKey = String(scopeOrId.system_key || '').trim().toLowerCase();
  const pgKind = String(scopeOrId.pg_kind || scopeOrId.kind || '').trim().toLowerCase();
  const title = String(scopeOrId.title || '').trim().toLowerCase();
  return recordId === DM_SCOPE_ID
    || systemKey === DM_SCOPE_KIND
    || pgKind === DM_SCOPE_KIND
    || title === DM_SCOPE_TITLE.toLowerCase();
}

export function findDmScope(scopes = []) {
  return (Array.isArray(scopes) ? scopes : [])
    .find((scope) => scope?.record_state !== 'deleted' && isDmScope(scope)) || null;
}

export function resolveDmScope(scopes = [], ownerNpub = '') {
  return findDmScope(scopes) || createVirtualDmScope(ownerNpub);
}

export function resolveDmScopeId(scopes = []) {
  return resolveDmScope(scopes).record_id;
}

export function normalizeDmParticipants(participants = []) {
  return [...new Set((Array.isArray(participants) ? participants : [])
    .map((npub) => String(npub || '').trim())
    .filter(Boolean))]
    .sort();
}

export function dmParticipantKey(participants = []) {
  return normalizeDmParticipants(participants).join('|');
}

export function buildDmChannelDescription(participants = []) {
  const key = dmParticipantKey(participants);
  return key ? `${DM_CHANNEL_DESCRIPTION_PREFIX}${key}` : '';
}

export function parseDmChannelDescription(value = '') {
  const text = String(value || '').trim();
  if (!text.startsWith(DM_CHANNEL_DESCRIPTION_PREFIX)) return '';
  return text.slice(DM_CHANNEL_DESCRIPTION_PREFIX.length).trim();
}

export function isDmChannel(channel) {
  if (!channel) return false;
  const channelType = String(channel.channel_type || channel.type || '').trim().toLowerCase();
  const pgKind = String(channel.pg_kind || channel.kind || '').trim().toLowerCase();
  const scopeId = String(channel.scope_id || channel.scope_l1_id || '').trim();
  const description = String(channel.description || '').trim().toLowerCase();
  const title = String(channel.title || channel.name || '').trim().toLowerCase();
  if (channelType === DM_SCOPE_KIND || pgKind === DM_SCOPE_KIND) return true;
  if (isDmScope(scopeId)) return true;
  if (description.startsWith(DM_CHANNEL_DESCRIPTION_PREFIX)) return true;
  if (title.startsWith('dm:')) return true;
  return normalizeDmParticipants(channel.participant_npubs).length === 2
    && title.includes('dm');
}

export function findExistingDmChannel(channels = [], participants = []) {
  const targetKey = dmParticipantKey(participants);
  if (!targetKey) return null;
  return (Array.isArray(channels) ? channels : [])
    .find((channel) =>
      !['deleted', 'archived'].includes(channel?.record_state)
      && !channel?.archived_at && !channel?.deleted_at
      && isDmChannel(channel)
      && dmParticipantKey(channel.participant_npubs) === targetKey,
    ) || null;
}
