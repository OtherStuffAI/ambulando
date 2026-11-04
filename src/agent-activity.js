const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

// Lease timing (design: 60 s heartbeat, 180 s lease). The client clears a
// non-terminal lifecycle no later than its server deadline plus this grace.
export const AGENT_ACTIVITY_LEASE_GRACE_MS = 15_000;
// An expired lifecycle stays in the current slot as "Stopped responding" for
// this window, then moves to earlier activity.
const AGENT_ACTIVITY_STOPPED_WINDOW_MS = 10 * 60_000;
// Presentational only: a live turn without commentary for this long shows a
// "no update" hint. It never ends or expires the turn.
export const AGENT_ACTIVITY_QUIET_MS = 5 * 60_000;
const EXPIRED_LEASE_HEALTH = new Set(['stale', 'expired']);

function text(value) {
  return String(value ?? '').trim();
}

function optionalCounter(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function isTerminalAgentActivity(activity = {}) {
  return TERMINAL_STATES.has(text(activity.state).toLowerCase());
}

export function mapPgAgentActivity(activity = {}) {
  const recordId = text(activity.id || activity.record_id);
  const activityId = text(activity.activity_id);
  const visibility = text(activity.visibility);
  const sequence = Number(activity.sequence);
  if (!recordId || !activityId || visibility !== 'user_visible' || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  return {
    ...(/^\d+$/.test(text(activity.commentary_cursor)) ? { commentary_cursor: text(activity.commentary_cursor) } : {}),
    record_id: recordId,
    activity_id: activityId,
    turn_id: text(activity.turn_id) || null,
    pg_backend: true,
    workspace_id: text(activity.workspace_id),
    scope_id: text(activity.scope_id),
    channel_id: text(activity.channel_id),
    thread_id: text(activity.thread_id),
    trigger_message_id: text(activity.trigger_message_id),
    session_id: text(activity.session_id),
    agent_npub: text(activity.agent_npub),
    state: text(activity.state).toLowerCase(),
    label: text(activity.label),
    summary: text(activity.summary),
    body: text(activity.body),
    visibility,
    sequence,
    last_heartbeat_at: text(activity.last_heartbeat_at),
    lease_expires_at: text(activity.lease_expires_at || activity.expires_at),
    expires_at: text(activity.expires_at || activity.lease_expires_at),
    lease_health: text(activity.lease_health).toLowerCase(),
    lease_epoch: optionalCounter(activity.lease_epoch),
    lease_sequence: optionalCounter(activity.lease_sequence),
    expired_at: text(activity.expired_at),
    blocked_by_turn_id: text(activity.blocked_by_turn_id) || null,
    queue_position: Number.isSafeInteger(Number(activity.queue_position)) && Number(activity.queue_position) > 0
      ? Number(activity.queue_position) : null,
    terminal_at: text(activity.terminal_at),
    created_at: text(activity.created_at),
    updated_at: text(activity.updated_at),
    ...(Object.hasOwn(activity, 'commentary_next_before_sequence')
      ? { commentary_next_before_sequence: activity.commentary_next_before_sequence } : {}),
  };
}

export function mapPgAgentActivityCommentary(commentary = {}, activity = {}, context = {}) {
  const turnId = text(commentary.turn_id);
  const activityId = text(commentary.activity_id);
  const sequence = Number(commentary.sequence);
  const body = text(commentary.body || commentary.summary);
  const state = text(commentary.state || 'working').toLowerCase();
  const visibility = text(commentary.visibility || 'user_visible');
  if (
    !turnId
    || !activityId
    || activityId !== text(activity.activity_id)
    || turnId !== text(activity.turn_id)
    || !Number.isSafeInteger(sequence)
    || sequence < 0
    || !body
    || state !== 'working'
    || visibility !== 'user_visible'
  ) return null;
  const workspaceId = text(context.workspaceId || activity.workspace_id);
  const backendUrl = text(context.backendUrl);
  return {
    history_key: [workspaceId, backendUrl, turnId, sequence].join('\u0000'),
    workspace_id: workspaceId,
    backend_url: backendUrl,
    turn_id: turnId,
    activity_id: activityId,
    channel_id: text(activity.channel_id),
    sequence,
    summary: text(commentary.summary),
    body,
    created_at: text(commentary.created_at),
  };
}

export function isVisibleAgentActivity(activity = {}, nowMs = Date.now()) {
  if (!activity?.record_id || activity.visibility !== 'user_visible') return false;
  return true;
}

export function agentActivityLifecycleKey(activity = {}) {
  return `${text(activity.activity_id)}\u0000${text(activity.turn_id)}`;
}

export function compareAgentActivityLifecycle(left = {}, right = {}) {
  const createdOrder = text(left.created_at).localeCompare(text(right.created_at));
  if (createdOrder !== 0) return createdOrder;
  return text(left.activity_id).localeCompare(text(right.activity_id));
}

function agentActivityLeaseDeadlineMs(activity = {}) {
  return Date.parse(activity.lease_expires_at || activity.expires_at || '');
}

// The latest local time at which a non-terminal lifecycle may still read as
// live: the server deadline plus grace, or the server-confirmed expiry.
export function agentActivityClearAtMs(activity = {}) {
  const deadline = agentActivityLeaseDeadlineMs(activity);
  const expiredAt = Date.parse(activity.expired_at || '');
  const clearAt = Number.isFinite(deadline) ? deadline + AGENT_ACTIVITY_LEASE_GRACE_MS : NaN;
  if (Number.isFinite(expiredAt)) return Number.isFinite(clearAt) ? Math.min(clearAt, expiredAt) : expiredAt;
  return clearAt;
}

// terminal | live | expired. History never implies liveness: a row without a
// usable deadline, a server-confirmed expiry, or a passed deadline+grace is
// expired. nowMs is server-calibrated time.
export function getAgentActivityLeaseState(activity = {}, nowMs = Date.now()) {
  if (isTerminalAgentActivity(activity)) return 'terminal';
  if (text(activity.expired_at)) return 'expired';
  if (EXPIRED_LEASE_HEALTH.has(text(activity.lease_health).toLowerCase())) return 'expired';
  const clearAt = agentActivityClearAtMs(activity);
  if (!Number.isFinite(clearAt) || nowMs >= clearAt) return 'expired';
  return 'live';
}

export function isAgentActivityLeaseLive(activity = {}, nowMs = Date.now()) {
  return getAgentActivityLeaseState(activity, nowMs) === 'live';
}

// Whether an expired lifecycle may still occupy the current header.
export function isAgentActivityInStoppedWindow(activity = {}, nowMs = Date.now()) {
  if (getAgentActivityLeaseState(activity, nowMs) !== 'expired') return false;
  const clearAt = agentActivityClearAtMs(activity);
  const reference = Number.isFinite(clearAt)
    ? clearAt
    : Date.parse(activity.last_heartbeat_at || activity.updated_at || activity.created_at || '');
  return Number.isFinite(reference) && nowMs < reference + AGENT_ACTIVITY_STOPPED_WINDOW_MS;
}

export function getAgentActivityHealth(activity = {}, sseStatus = 'connected', nowMs = Date.now(), recovery = {}) {
  if (isTerminalAgentActivity(activity)) return { state: 'finished', message: '' };
  // Producer death is independent of this client's connection: once the
  // deadline has passed no transport state may present the turn as working.
  if (getAgentActivityLeaseState(activity, nowMs) === 'expired') {
    return { state: 'expired', message: 'Stopped responding' };
  }
  const status = text(sseStatus).toLowerCase();
  const startedAt = Number(recovery.startedAt || 0);
  const transportLost = !['connected', 'fallback-polling'].includes(status);
  if (startedAt > 0 || transportLost) {
    const since = startedAt > 0 ? startedAt : nowMs;
    const lost = nowMs - since >= 60_000;
    return {
      state: lost ? 'error' : 'degraded',
      message: lost ? 'connection lost · reconnecting…' : 'reconnecting…',
    };
  }
  return { state: 'live', message: '' };
}

export function selectVisibleAgentActivities(activities = [], sseStatus = 'connected', nowMs = Date.now()) {
  const byLifecycle = new Map();
  for (const activity of Array.isArray(activities) ? activities : []) {
    if (!isVisibleAgentActivity(activity, nowMs)) continue;
    const key = [activity.workspace_id, activity.backend_url, agentActivityLifecycleKey(activity)].map(text).join('\u0000');
    byLifecycle.set(key, mergeAgentActivityRecord(byLifecycle.get(key), activity));
  }
  return [...byLifecycle.values()];
}

function leaseOrder(left = {}, right = {}) {
  const epoch = (row) => row.lease_epoch ?? 1;
  const leaseSequence = (row) => row.lease_sequence ?? -1;
  return (epoch(left) - epoch(right))
    || (leaseSequence(left) - leaseSequence(right))
    || (Number(left.sequence) - Number(right.sequence));
}

function sameLifecycle(current = {}, incoming = {}) {
  return text(current.activity_id) === text(incoming.activity_id) && (
    text(current.turn_id) === text(incoming.turn_id)
    || (!text(current.turn_id) && Boolean(text(incoming.turn_id)))
  );
}

const LEASE_FIELDS = ['lease_expires_at', 'expires_at', 'lease_epoch', 'lease_sequence', 'last_heartbeat_at', 'lease_health'];

// Order-independent merge for one lifecycle: state and commentary follow the
// canonical sequence; the lease follows (lease_epoch, lease_sequence), which v1
// rows lack, so their lease follows sequence; terminal always wins; an expiry
// survives only events that do not prove a later deadline in its epoch.
export function mergeAgentActivityRecord(current, incoming) {
  if (!incoming?.record_id) return current || null;
  if (!current?.record_id) return incoming;
  if (!sameLifecycle(current, incoming)) return current;
  const currentTerminal = isTerminalAgentActivity(current);
  const incomingTerminal = isTerminalAgentActivity(incoming);
  const base = currentTerminal !== incomingTerminal
    ? (incomingTerminal ? incoming : current)
    : (Number(incoming.sequence) > Number(current.sequence) ? incoming : current);
  // A terminal lifecycle's lease is irrelevant; later lease events cannot touch it.
  const lease = isTerminalAgentActivity(base) ? base : (leaseOrder(incoming, current) > 0 ? incoming : current);
  const leaseDeadline = agentActivityLeaseDeadlineMs(lease);
  const expiry = [current, incoming]
    .filter((row) => text(row.expired_at) && (row.lease_epoch ?? 1) === (lease.lease_epoch ?? 1))
    .map((row) => text(row.expired_at))
    .find((expiredAt) => !Number.isFinite(leaseDeadline) || Date.parse(expiredAt) >= leaseDeadline) || '';
  if (base === current && lease === current && expiry === text(current.expired_at)) return current;
  const merged = { ...current, ...base };
  for (const field of LEASE_FIELDS) {
    if (Object.hasOwn(lease, field)) merged[field] = lease[field];
  }
  merged.expired_at = expiry;
  if (expiry) merged.lease_health = 'expired';
  merged.created_at = current.created_at || incoming.created_at || '';
  return merged;
}

export function reconcileAgentActivity(current, incoming) {
  return mergeAgentActivityRecord(current, incoming);
}

// Project retained records without changing storage or allowing update/replay time
// to promote an earlier lifecycle into the current conversation slot.
export function selectCurrentAgentActivities(activities = [], nowMs = Date.now()) {
  const groups = new Map();
  for (const activity of selectVisibleAgentActivities(activities)) {
    const key = JSON.stringify([
      activity.workspace_id || '', activity.backend_url || '',
      activity.channel_id || '', activity.thread_id || activity.trigger_message_id || '', activity.agent_npub || '',
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(activity);
  }
  return [...groups.values()].flatMap((runs) => {
    runs.sort((a, b) => compareAgentActivityLifecycle(b, a));
    // A queued request must not replace the turn ahead of it. A confirmed
    // terminal current turn must not resurrect an older unconfirmed lifecycle.
    // Earlier failures remain diagnostic history, even when their producer
    // state has not yet been reconciled after a successful dispatch.
    // An expired lifecycle holds the current slot only for its stopped window.
    const latest = runs.find((run) => run.state !== 'queued');
    const current = latest && (getAgentActivityLeaseState(latest, nowMs) !== 'expired'
      || isAgentActivityInStoppedWindow(latest, nowMs)) ? latest : null;
    const selected = runs.filter((run) => {
      if (run === current) return true;
      if (run.state !== 'queued') return false;
      return isAgentActivityLeaseLive(run, nowMs);
    });
    const earlier = runs.filter((run) => !selected.includes(run));
    // Even a queue-only or fully expired conversation retains its records in
    // diagnostics; the carrier is history only and never a current header.
    if (!selected.length) return [{ ...runs[0], history_only: true, earlier_activities: runs.slice(1) }];
    return selected.map((run, index) => ({ ...run, earlier_activities: index === 0 ? earlier : [] }));
  });
}

export function mapPgAgentSessionHealth(health = {}) {
  const recordId = text(health.id || health.record_id);
  const sessionId = text(health.session_id);
  const generation = Number(health.generation);
  const sequence = Number(health.sequence);
  const rowVersion = Number(health.row_version);
  if (!recordId || !sessionId || !Number.isSafeInteger(generation) || generation < 0
    || !Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(rowVersion) || rowVersion < 1) return null;
  return {
    record_id: recordId,
    workspace_id: text(health.workspace_id),
    scope_id: text(health.scope_id),
    channel_id: text(health.channel_id),
    thread_id: text(health.thread_id) || null,
    session_id: sessionId,
    agent_npub: text(health.agent_npub),
    status: text(health.status).toLowerCase(),
    active_turn_id: text(health.active_turn_id) || null,
    generation,
    sequence,
    row_version: rowVersion,
    last_seen_at: text(health.last_seen_at),
    lease_expires_at: text(health.lease_expires_at),
    lease_health: text(health.lease_health).toLowerCase(),
    error_summary: text(health.error_summary),
    created_at: text(health.created_at),
    updated_at: text(health.updated_at),
  };
}
