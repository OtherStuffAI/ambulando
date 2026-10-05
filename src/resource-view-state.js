export const RESOURCE_VIEW_TYPES = Object.freeze(['thread', 'task', 'document']);

function version(value) {
  const parsed = Number(value || 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function resourceTypeOf(resource) {
  const value = String(resource?.resource_type || resource?.pg_record_type || '').trim();
  return value === 'doc' ? 'document' : value;
}

export function resourceViewStateId(resourceType, resourceId) {
  return `${String(resourceType || '').trim()}:${String(resourceId || '').trim()}`;
}

export function mapTowerResourceViewState(state = {}, options = {}) {
  const resourceType = String(state.resource_type || '').trim();
  const resourceId = String(state.resource_id || '').trim();
  if (!RESOURCE_VIEW_TYPES.includes(resourceType) || !resourceId) return null;
  return {
    record_id: resourceViewStateId(resourceType, resourceId),
    viewer_actor_id: String(state.viewer_actor_id || '').trim() || null,
    resource_type: resourceType,
    resource_id: resourceId,
    scope_id: String(state.scope_id || '').trim() || null,
    channel_id: String(state.channel_id || '').trim() || null,
    activity_version: version(state.activity_version),
    ...(state.attention_policy_version === 1 ? { attention_policy_version: 1, attention_activity_version: version(state.attention_activity_version) } : {}),
    viewed_activity_version: version(state.viewed_activity_version),
    row_version: version(state.row_version),
    updated_at: String(state.updated_at || new Date().toISOString()),
    sync_status: options.syncStatus || 'synced',
  };
}

export function deriveUnreadResources(resources = [], viewStates = []) {
  const viewedByResource = new Map(
    viewStates.map((state) => [resourceViewStateId(state.resource_type, state.resource_id), version(state.viewed_activity_version)]),
  );
  const result = {};
  for (const resource of resources) {
    if (!resource || resource.record_state === 'deleted' || resource.archived_at || resource.deleted_at) continue;
    const resourceType = resourceTypeOf(resource);
    const resourceId = String(resource.resource_id || resource.record_id || '').trim();
    if (!RESOURCE_VIEW_TYPES.includes(resourceType) || !resourceId) continue;
    const activityVersion = version(resource.activity_version);
    const viewedVersion = viewedByResource.get(resourceViewStateId(resourceType, resourceId)) || 0;
    if (activityVersion > viewedVersion) result[resourceViewStateId(resourceType, resourceId)] = true;
  }
  return result;
}

export function deriveUnreadAggregates(resources = [], unreadResources = {}) {
  const channels = {};
  const sections = { chat: false, tasks: false, docs: false };
  for (const resource of resources) {
    const resourceType = resourceTypeOf(resource);
    const resourceId = String(resource?.resource_id || resource?.record_id || '').trim();
    if (!unreadResources[resourceViewStateId(resourceType, resourceId)]) continue;
    const channelId = String(resource.channel_id || resource.pg_channel_id || '').trim();
    if (channelId) channels[channelId] = true;
    if (resourceType === 'thread') sections.chat = true;
    if (resourceType === 'task') sections.tasks = true;
    if (resourceType === 'document') sections.docs = true;
  }
  return { channels, sections, deck: Object.values(sections).some(Boolean) };
}

export async function readCompleteResourceViewStateSnapshot(readPage) {
  const states = [];
  const seenCursors = new Set();
  let cursor = null;
  let baselineCreated = false;
  do {
    const page = await readPage(cursor);
    states.push(...(Array.isArray(page?.states) ? page.states : []));
    baselineCreated = baselineCreated || page?.baseline_created === true;
    const nextCursor = String(page?.next_cursor || '').trim() || null;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error('Tower resource view-state pagination returned a repeated cursor');
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return { states, baseline_created: baselineCreated, next_cursor: null };
}
