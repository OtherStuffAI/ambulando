import { recordFamilyHash as chatFamilyHash } from './translators/chat.js';
import { recordFamilyHash as reportFamilyHash } from './translators/reports.js';
import { recordFamilyHash as taskFamilyHash } from './translators/tasks.js';
import { recordFamilyHash as scheduleFamilyHash } from './translators/schedules.js';
import { recordFamilyHash as settingsFamilyHash } from './translators/settings.js';
import { recordFamilyHash as flowFamilyHash } from './translators/flows.js';
import { recordFamilyHash as approvalFamilyHash } from './translators/approvals.js';
import { recordFamilyHash as personFamilyHash } from './translators/persons.js';
import { recordFamilyHash as organisationFamilyHash } from './translators/organisations.js';
import { recordFamilyHash as opportunityFamilyHash } from './translators/opportunities.js';
import { recordFamilyHash as reactionFamilyHash } from './translators/reactions.js';
import { recordFamilyHash as wappFamilyHash } from './translators/wapps.js';

export const SYNC_FAMILY_OPTIONS = Object.freeze([
  { id: 'settings', label: 'Workspace settings', hash: settingsFamilyHash('settings'), table: 'workspace_settings' },
  { id: 'channel', label: 'Channels', hash: chatFamilyHash('channel'), table: 'channels' },
  { id: 'chat_message', label: 'Chat messages', hash: chatFamilyHash('chat_message'), table: 'chat_messages' },
  { id: 'directory', label: 'Directories', hash: chatFamilyHash('directory'), table: 'directories' },
  { id: 'document', label: 'Documents', hash: chatFamilyHash('document'), table: 'documents' },
  { id: 'report', label: 'Reports', hash: reportFamilyHash('report'), table: 'reports' },
  { id: 'wapp', label: 'WApps', hash: wappFamilyHash('wapp'), table: 'wapps' },
  { id: 'task', label: 'Tasks', hash: taskFamilyHash('task'), table: 'tasks' },
  { id: 'schedule', label: 'Schedules', hash: scheduleFamilyHash('schedule'), table: 'schedules' },
  { id: 'comment', label: 'Comments', hash: chatFamilyHash('comment'), table: 'comments' },
  { id: 'reaction', label: 'Reactions', hash: reactionFamilyHash('reaction'), table: 'reactions' },
  { id: 'audio_note', label: 'Audio notes', hash: chatFamilyHash('audio_note'), table: 'audio_notes' },
  { id: 'scope', label: 'Scopes', hash: chatFamilyHash('scope'), table: 'scopes' },
  { id: 'flow', label: 'Flows', hash: flowFamilyHash('flow'), table: 'flows' },
  { id: 'approval', label: 'Approvals', hash: approvalFamilyHash('approval'), table: 'approvals' },
  { id: 'person', label: 'People', hash: personFamilyHash('person'), table: 'persons' },
  { id: 'organisation', label: 'Organisations', hash: organisationFamilyHash('organisation'), table: 'organisations' },
  { id: 'opportunity', label: 'Opportunities', hash: opportunityFamilyHash('opportunity'), table: 'opportunities' },
]);

// Canonical Tower PG families travel through record-delta, not encrypted
// record-sync. Keep them in the central registry without adding them to the
// legacy default pull set or published encrypted schema manifests.
export const PG_SYNC_FAMILY_OPTIONS = Object.freeze([
  { id: 'context_component', table: 'context_components', transport: 'tower_pg' },
  { id: 'context_reference', table: 'context_references', transport: 'tower_pg' },
  { id: 'feed_subscription', envelope: 'feed_subscriptions', table: 'feed_subscriptions', transport: 'tower_pg' },
  { id: 'feed_item_state', envelope: 'feed_item_states', table: 'feed_item_states', transport: 'tower_pg' },
  { id: 'autopilot_connection', envelope: 'autopilot_connections', table: 'autopilot_connections', transport: 'tower_pg' },
  { id: 'workspace_agent', envelope: 'workspace_agents', table: 'workspace_agents', transport: 'tower_pg' },
]);

export const PG_SYNC_FAMILY_MAP = Object.freeze(
  Object.fromEntries(PG_SYNC_FAMILY_OPTIONS.map(family => [family.id, family]))
);

export const DEFAULT_SYNC_FAMILY_IDS = Object.freeze(SYNC_FAMILY_OPTIONS.map((family) => family.id));

export const SYNC_FAMILY_MAP = Object.freeze(
  Object.fromEntries(SYNC_FAMILY_OPTIONS.map((family) => [family.id, family]))
);

export const SYNC_FAMILY_BY_HASH = Object.freeze(
  Object.fromEntries(SYNC_FAMILY_OPTIONS.map((family) => [family.hash, family]))
);

export function getSyncFamily(idOrHash) {
  if (!idOrHash) return null;
  return SYNC_FAMILY_MAP[idOrHash] || SYNC_FAMILY_BY_HASH[idOrHash] || PG_SYNC_FAMILY_MAP[idOrHash] || null;
}

export function getSyncFamilyHash(id) {
  return getSyncFamily(id)?.hash ?? null;
}

export function getSyncFamilyHashes(ids = []) {
  return [...new Set(ids.map((id) => getSyncFamilyHash(id)).filter(Boolean))];
}

export function getSyncStateKeyForFamily(idOrHash) {
  const family = getSyncFamily(idOrHash);
  return family?.hash ? `sync_since:${family.hash}` : null;
}
