// Wire adapter for the shared Tower notification inbox (org.wingman.notification.item v1).
// All server shapes are parsed here so local rows and rendered UI never depend on
// transport field names. Unknown or foreign-identity payloads are rejected, never guessed.
export const NOTIFICATION_ITEM_SCHEMA = 'org.wingman.notification.item';
export const NOTIFICATION_SNAPSHOT_PAGE_LIMIT = 100;
// Pages per bounded job; a snapshot continues across jobs until next_cursor is null.
export const NOTIFICATION_SNAPSHOT_PAGES_PER_JOB = 30;
export const NOTIFICATION_CHANGES_PAGE_LIMIT = 200;
export const NOTIFICATION_COUNT_CAP = 999;
// Presentation filter for the shared inbox (wire v1.1). It selects what this app shows; it is never access authority.
export const NOTIFICATION_CLIENT_APP_ID = 'ambulando';
// Item statuses that remove the row from every local partition.
const REMOVED_STATUSES = new Set(['withdrawn', 'expired', 'revoked']);
const TITLE_MAX = 120;
const BODY_MAX = 280;

// Plain text only: strip control characters and bidi overrides/isolates, then bound the length.
const isStrippedCodePoint = code => code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
const text = (value, max = 256) => (typeof value === 'string' ? Array.from(value).filter(char => !isStrippedCodePoint(char.codePointAt(0))).join('').slice(0, max) : '');
const positiveInt = value => Number.isSafeInteger(value) && value >= 0;

export class NotificationWireError extends Error {
  constructor(message, code = 'invalid_notification_payload') { super(message); this.name = 'NotificationWireError'; this.code = code; }
}

export function isRemovedItem(raw) {
  return Boolean(raw?.removed_at) || REMOVED_STATUSES.has(raw?.status) || raw?.removed === true;
}

/** Validate one item against the active context and flatten it into a local row. */
export function normalizeNotificationItem(raw, context) {
  if (!raw || typeof raw !== 'object') throw new NotificationWireError('Notification item is not an object');
  // A newer item schema/version is tracked by id and sequence and shown as a safe generic card, never a sync failure.
  const unsupported = (raw.schema !== undefined && raw.schema !== NOTIFICATION_ITEM_SCHEMA) || (raw.version !== undefined && raw.version !== 1);
  const id = text(raw.id, 128);
  if (!id || !positiveInt(raw.change_seq) || !Number.isSafeInteger(raw.row_version) || raw.row_version < 1) throw new NotificationWireError('Notification item is missing its identity or versions');
  // Defence in depth: the server already scopes by workspace and recipient.
  if (raw.workspace_id !== context.workspaceId || (raw.recipient_actor_id && raw.recipient_actor_id !== context.actorId)) throw new NotificationWireError('Notification item belongs to another workspace or recipient', 'identity_mismatch');
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  const unavailable = raw.access === 'unavailable';
  const presentation = raw.presentation && typeof raw.presentation === 'object' ? raw.presentation : {};
  const target = raw.action?.type === 'open' && raw.action.target && typeof raw.action.target === 'object' ? raw.action.target : null;
  const occurredAt = text(raw.occurred_at, 40);
  const occurredMs = Date.parse(occurredAt);
  return {
    key: `${context.key}|${id}`,
    context: context.key,
    id,
    workspace_id: context.workspaceId,
    recipient_actor_id: context.actorId,
    change_seq: raw.change_seq,
    row_version: raw.row_version,
    category: text(raw.category, 64) || 'unknown',
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(reason => text(reason, 64)).filter(Boolean).slice(0, 8) : [],
    severity: ['low', 'normal', 'high', 'critical'].includes(raw.severity) ? raw.severity : 'normal',
    status: text(raw.status, 32) || 'active',
    origin: text(raw.origin, 16) || 'live',
    source: { app_id: text(raw.source?.app_id, 64), label: text(raw.source?.label, 64) || 'Notification', kind: text(raw.source?.kind, 32) },
    group: raw.group && typeof raw.group === 'object' ? { key: text(raw.group.key, 256), event_count: positiveInt(raw.group.event_count) ? raw.group.event_count : 1 } : null,
    actor: raw.actor && typeof raw.actor === 'object' ? { actor_id: text(raw.actor.actor_id, 64), display_name: text(raw.actor.display_name, 80), kind: text(raw.actor.kind, 16) } : null,
    subject_kind: text(raw.subject?.kind, 32),
    subject: Object.fromEntries(['scope_id', 'channel_id', 'thread_id', 'task_id', 'doc_id', 'message_id', 'comment_id'].map(key => [key, text(raw.subject?.[key], 128)]).filter(([, value]) => value)),
    activity_version: positiveInt(raw.subject?.activity_version) ? raw.subject.activity_version : null,
    unavailable,
    // Unavailable items carry no routable target and only generic wording.
    unsupported,
    title: unavailable ? 'Item no longer available' : unsupported ? 'New notification (update Ambulando to view details)' : text(presentation.title, TITLE_MAX) || 'New notification',
    body: unavailable || unsupported ? '' : text(presentation.body, BODY_MAX),
    icon: unsupported ? '' : text(presentation.icon, 32),
    target: unavailable || unsupported || !target ? null : Object.fromEntries(Object.entries(target).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, text(value, 128)])),
    occurred_at: occurredAt,
    occurred_ms: Number.isFinite(occurredMs) ? occurredMs : 0,
    read: Boolean(state.read),
    read_at: text(state.read_at, 40) || null,
    read_reason: text(state.read_reason, 32) || null,
    dismissed: Boolean(state.dismissed),
    archived: Boolean(state.archived),
    removed: isRemovedItem(raw),
  };
}

/** One entry of `changes`: either an upserted item snapshot or a content-free tombstone. */
export function normalizeNotificationChange(raw, context) {
  if (!raw || typeof raw !== 'object') throw new NotificationWireError('Notification change is not an object');
  const source = raw.item && typeof raw.item === 'object' ? raw.item : raw;
  const id = text(raw.id || raw.item_id || source.id, 128);
  const changeSeq = raw.change_seq ?? source.change_seq;
  if (!id || !positiveInt(changeSeq)) throw new NotificationWireError('Notification change is missing its identity or sequence');
  // Content-free tombstone: org.wingman.notification.tombstone / change_type "remove".
  const tombstone = raw.schema === 'org.wingman.notification.tombstone' || raw.change_type === 'remove' || raw.removed === true || Boolean(raw.removal_reason) || isRemovedItem(source);
  if (tombstone) return { id, change_seq: changeSeq, removed: true, row: null };
  return { id, change_seq: changeSeq, removed: false, row: normalizeNotificationItem(source, context) };
}

function requireIdentity(response, context) {
  const workspaceId = response?.identity?.workspace_id ?? response?.workspace_id;
  if (workspaceId !== undefined && workspaceId !== context.workspaceId) throw new NotificationWireError('Notification response belongs to another workspace', 'identity_mismatch');
}

/** Per-recipient preference generation (wire v1.1); null when an older Tower omits it. */
export function rulesRevisionOf(response) {
  return positiveInt(response?.rules_revision) ? response.rules_revision : null;
}

export function normalizeItemsPage(response, context) {
  requireIdentity(response, context);
  if (!Array.isArray(response?.items) || !positiveInt(response.head_seq)) throw new NotificationWireError('Invalid notification list response');
  return { rules_revision: rulesRevisionOf(response), items: response.items.map(item => normalizeNotificationItem(item, context)), next_cursor: response.next_cursor || null, head_seq: response.head_seq, inbox_started_at: text(response.inbox_started_at, 40) };
}

export function normalizeChangesPage(response, context) {
  requireIdentity(response, context);
  if (!Array.isArray(response?.changes) || !positiveInt(response.through_seq)) throw new NotificationWireError('Invalid notification changes response');
  return { rules_revision: rulesRevisionOf(response), changes: response.changes.map(change => normalizeNotificationChange(change, context)), through_seq: response.through_seq, head_seq: positiveInt(response.head_seq) ? response.head_seq : response.through_seq, has_more: response.has_more === true };
}

export function normalizeCounts(response, context) {
  requireIdentity(response, context);
  if (!positiveInt(response?.unread_total)) throw new NotificationWireError('Invalid notification counts response');
  const record = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([, count]) => positiveInt(count)));
  return { rules_revision: rulesRevisionOf(response), unread_total: response.unread_total, by_category: record(response.by_category), by_source_app: record(response.by_source_app), badge: positiveInt(response.badge) ? response.badge : null, capped_at: positiveInt(response.capped_at) ? response.capped_at : NOTIFICATION_COUNT_CAP, head_seq: positiveInt(response.head_seq) ? response.head_seq : null, inbox_started_at: text(response.inbox_started_at, 40) };
}

export function requestBodyForMutation(pending) {
  return pending.kind === 'bulk'
    ? { mutation_id: pending.mutation_id, op: pending.op, selector: pending.selector }
    : { mutation_id: pending.mutation_id, expected_row_version: pending.expected_row_version, ...(Number.isSafeInteger(pending.observed_change_seq) ? { observed_change_seq: pending.observed_change_seq } : {}), patch: pending.patch };
}

/** 410 reset_required because the recipient's rules changed since the snapshot (wire v1.1). */
export function isRulesChangedReset(error) {
  return (error?.status === 410 || errorCode(error) === 'reset_required') && error?.payload?.reason === 'rules_changed';
}

/** Collection routes missing on an older Tower, as opposed to a transient failure. Never use for item-level 404s. */
export function isUnsupportedBackend(error) {
  const code = errorCode(error);
  return ([404, 405, 501].includes(error?.status) && code !== 'notification_not_found') || code === 'not_supported' || code === 'notifications_unavailable';
}

export function errorCode(error) {
  // Tower errors are { error: <message>, code: <machine code> }.
  return error?.payload?.code || error?.code || '';
}
