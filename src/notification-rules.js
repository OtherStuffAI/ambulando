import { towerPgNotificationInbox } from './api.js';
import { notificationInboxContext } from './notification-inbox-store.js';

// Workspace-scoped inbox preferences for the signed-in actor. Rules are the
// server's truth (last-writer-wins per key); this module only reads the category
// registry, resolves effective modes for display and writes whole-key updates.
// The `alert` channel is stored by Tower but no sender exists yet, so the UI does
// not offer alert switches here (legacy push toggles stay in the Web Push section).

const WILDCARD = '*';

function validRule(rule) {
  return rule && typeof rule.source_app_id === 'string' && typeof rule.category === 'string' && ['inbox', 'alert'].includes(rule.channel) && ['on', 'off'].includes(rule.mode);
}

/** Flatten the registry into rows; mandatory categories ignore rules and render locked. */
export function buildCategoryRows(registry, rules) {
  const byKey = new Map((rules || []).filter(validRule).map(rule => [`${rule.source_app_id}|${rule.category}|${rule.client_app_id || WILDCARD}|${rule.channel}`, rule]));
  const rows = [];
  for (const source of registry?.sources || []) {
    for (const category of source.categories || []) {
      const explicit = byKey.get(`${source.app_id}|${category.category}|${WILDCARD}|inbox`);
      const mandatory = Boolean(category.mandatory);
      const defaultMode = category.default_inbox === 'off' ? 'off' : 'on';
      rows.push({
        key: `${source.app_id}|${category.category}`,
        source_app_id: source.app_id,
        source_label: String(source.label || source.app_id),
        category: category.category,
        label: String(category.label || category.category).slice(0, 80),
        mandatory,
        inboxOn: mandatory ? true : (explicit?.mode || defaultMode) === 'on',
        explicit: Boolean(explicit),
      });
    }
  }
  return rows;
}

export async function fetchNotificationPreferences(store, { transport = towerPgNotificationInbox } = {}) {
  const context = notificationInboxContext(store);
  const options = { baseUrl: context.baseUrl, appNpub: context.appNpub };
  const [categories, rules] = await Promise.all([transport(context.workspaceId, 'categories', options), transport(context.workspaceId, 'rules', options)]);
  for (const response of [categories, rules]) {
    const workspaceId = response?.identity?.workspace_id;
    if (workspaceId !== undefined && workspaceId !== context.workspaceId) throw new Error('Notification preferences belong to another workspace.');
  }
  return { contextKey: context.key, registry: categories, rules: Array.isArray(rules.rules) ? rules.rules : [] };
}

export async function saveInboxRule(store, row, on, { transport = towerPgNotificationInbox } = {}) {
  if (row.mandatory) throw new Error('This notification is always on.');
  const context = notificationInboxContext(store);
  const rule = { source_app_id: row.source_app_id, category: row.category, client_app_id: WILDCARD, channel: 'inbox', mode: on ? 'on' : 'off' };
  const response = await transport(context.workspaceId, 'rules', { baseUrl: context.baseUrl, appNpub: context.appNpub, method: 'PUT', body: { mutation_id: crypto.randomUUID(), rules: [rule] } });
  if (response?.identity?.workspace_id !== undefined && response.identity.workspace_id !== context.workspaceId) throw new Error('Notification preferences belong to another workspace.');
  return { contextKey: context.key, rules: Array.isArray(response?.rules) ? response.rules : [] };
}
