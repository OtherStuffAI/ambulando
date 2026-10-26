import { towerPgNotificationInbox } from './api.js';
import { notificationInboxContext } from './notification-inbox-store.js';
import { NOTIFICATION_CLIENT_APP_ID, rulesRevisionOf } from './notification-inbox-wire.js';

// Workspace-scoped inbox preferences for the signed-in actor (wire v1.1). Rules are
// compare-and-set per key: every written rule carries the `row_version` of the same key
// from the last read (0 only when that exact key was absent). This app writes only its own
// key (`client_app_id=ambulando`), so changing it never alters what other apps show.
// The `alert` channel is stored by Tower but no sender exists yet, so the UI does not
// offer alert switches here (legacy push toggles stay in the Web Push section).

const WILDCARD = '*';
const MODES = ['on', 'off', 'default'];

function validRule(rule) {
  return rule && typeof rule.source_app_id === 'string' && typeof rule.category === 'string' && ['inbox', 'alert'].includes(rule.channel) && MODES.includes(rule.mode);
}

const ruleKey = (source, category, client, channel = 'inbox') => `${source}|${category}|${client || WILDCARD}|${channel}`;

/** A 409 rules_conflict: nothing was written; the server's current rules and revision are carried for a user retry. */
export class NotificationRulesConflictError extends Error {
  constructor(payload) {
    super('Your notification preferences changed on another device. They have been reloaded; review and try again.');
    this.name = 'NotificationRulesConflictError';
    this.code = 'rules_conflict';
    this.rules = Array.isArray(payload?.rules) ? payload.rules : [];
    this.rulesRevision = rulesRevisionOf(payload);
  }
}

/**
 * Effective inbox mode for (source, category) as client `ambulando` sees it: most specific key wins
 * (src,cat) > (src,*) > (*,cat) > (*,*); at one level this app's own rule beats the `*` client rule;
 * `default` rows are inherited and never decide. Returns null when no rule applies (use the registry default).
 */
export function resolveInboxMode(rules, sourceAppId, category, clientAppId = NOTIFICATION_CLIENT_APP_ID) {
  const byKey = new Map(rules.filter(validRule).map(rule => [ruleKey(rule.source_app_id, rule.category, rule.client_app_id, rule.channel), rule]));
  for (const [source, cat] of [[sourceAppId, category], [sourceAppId, WILDCARD], [WILDCARD, category], [WILDCARD, WILDCARD]]) {
    const candidates = [byKey.get(ruleKey(source, cat, clientAppId)), byKey.get(ruleKey(source, cat, WILDCARD))].filter(rule => rule && rule.mode !== 'default');
    if (candidates.length) return candidates[0].mode; // this app's own key was listed first
  }
  return null;
}

/** Items are created only when the shared (`*` client) rules allow them; app rules only hide. */
function sharedInboxMode(rules, sourceAppId, category) {
  return resolveInboxMode(rules.filter(rule => (rule.client_app_id || WILDCARD) === WILDCARD), sourceAppId, category, WILDCARD);
}

/** Flatten the registry into rows; mandatory categories ignore rules and render locked. */
export function buildCategoryRows(registry, rules) {
  const list = (rules || []).filter(validRule);
  const rows = [];
  for (const source of registry?.sources || []) {
    for (const category of source.categories || []) {
      const mandatory = Boolean(category.mandatory);
      const defaultMode = category.default_inbox === 'off' ? 'off' : 'on';
      // The exact key this app writes. A durable `default` row still has a version the next write must cite.
      const own = list.find(rule => rule.channel === 'inbox' && rule.source_app_id === source.app_id && rule.category === category.category && rule.client_app_id === NOTIFICATION_CLIENT_APP_ID);
      const mode = resolveInboxMode(list, source.app_id, category.category) || defaultMode;
      const sharedOff = !mandatory && (sharedInboxMode(list, source.app_id, category.category) || defaultMode) === 'off';
      rows.push({
        key: `${source.app_id}|${category.category}`,
        source_app_id: source.app_id,
        source_label: String(source.label || source.app_id),
        category: category.category,
        label: String(category.label || category.category).slice(0, 80),
        mandatory,
        inboxOn: mandatory ? true : mode === 'on' && !sharedOff,
        // Turned off for every app: Tower never creates the item, so this app's switch cannot bring it back.
        sharedOff,
        explicit: Boolean(own && own.mode !== 'default'),
        expected_row_version: Number.isSafeInteger(own?.row_version) ? own.row_version : 0,
      });
    }
  }
  return rows;
}

function checkIdentity(response, context) {
  const workspaceId = response?.identity?.workspace_id;
  if (workspaceId !== undefined && workspaceId !== context.workspaceId) throw new Error('Notification preferences belong to another workspace.');
}

export async function fetchNotificationPreferences(store, { transport = towerPgNotificationInbox } = {}) {
  const context = notificationInboxContext(store);
  const options = { baseUrl: context.baseUrl, appNpub: context.appNpub };
  const [categories, rules] = await Promise.all([transport(context.workspaceId, 'categories', options), transport(context.workspaceId, 'rules', options)]);
  for (const response of [categories, rules]) checkIdentity(response, context);
  return { contextKey: context.key, registry: categories, rules: Array.isArray(rules.rules) ? rules.rules : [], rulesRevision: rulesRevisionOf(rules) };
}

/**
 * Write this app's inbox rule with a fresh mutation id and the row's captured version. A stale version is a
 * `NotificationRulesConflictError` (nothing written, current rules attached); the caller adopts them and the
 * user decides whether to retry. `mutation_id_reused` is a rejection, never retried here.
 */
export async function saveInboxRule(store, row, on, { transport = towerPgNotificationInbox } = {}) {
  if (row.mandatory) throw new Error('This notification is always on.');
  if (row.sharedOff) throw new Error('This notification is turned off for every app.');
  const context = notificationInboxContext(store);
  const rule = { source_app_id: row.source_app_id, category: row.category, client_app_id: NOTIFICATION_CLIENT_APP_ID, channel: 'inbox', mode: on ? 'on' : 'off', preview: null, expected_row_version: Number.isSafeInteger(row.expected_row_version) ? row.expected_row_version : 0 };
  let response;
  try {
    response = await transport(context.workspaceId, 'rules', { baseUrl: context.baseUrl, appNpub: context.appNpub, method: 'PUT', body: { mutation_id: crypto.randomUUID(), rules: [rule] } });
  } catch (error) {
    if (error?.status === 409 && (error.payload?.code || error.code) === 'rules_conflict') throw new NotificationRulesConflictError(error.payload);
    throw error;
  }
  checkIdentity(response, context);
  return { contextKey: context.key, rules: Array.isArray(response?.rules) ? response.rules : [], rulesRevision: rulesRevisionOf(response) };
}
