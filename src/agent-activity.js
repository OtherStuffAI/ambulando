const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function text(value) {
  return String(value ?? '').trim();
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

export function getAgentActivityHealth(activity = {}, sseStatus = 'connected', nowMs = Date.now(), recovery = {}) {
  if (isTerminalAgentActivity(activity)) return { state: 'finished', message: '' };
  const status = text(sseStatus).toLowerCase();
  const startedAt = Number(recovery.startedAt || 0);
  const expiresAt = Date.parse(activity.lease_expires_at || activity.expires_at || '');
  const transportLost = !['connected', 'fallback-polling'].includes(status);
  const expired = !Number.isFinite(expiresAt) || expiresAt <= nowMs;
  if (startedAt > 0 || transportLost) {
    const since = startedAt > 0 ? startedAt : nowMs;
    const lost = nowMs - since >= 60_000;
    return {
      state: lost ? 'error' : 'degraded',
      message: lost ? 'Connection lost—status unknown' : 'Reconnecting',
    };
  }
  if (expired || text(activity.lease_health).toLowerCase() === 'stale') {
    return { state: 'stale', message: 'Status unknown — reconnecting' };
  }
  return { state: 'live', message: '' };
}

export function selectVisibleAgentActivities(activities = [], sseStatus = 'connected', nowMs = Date.now()) {
  const byLifecycle = new Map();
  for (const activity of Array.isArray(activities) ? activities : []) {
    if (!isVisibleAgentActivity(activity, nowMs)) continue;
    const key = [activity.workspace_id, activity.backend_url, agentActivityLifecycleKey(activity)].map(text).join('\u0000');
    const current = byLifecycle.get(key);
    if (!current || Number(activity.sequence) > Number(current.sequence)) byLifecycle.set(key, activity);
  }
  return [...byLifecycle.values()];
}

export function reconcileAgentActivity(current, incoming) {
  if (!incoming?.record_id) return current || null;
  if (!current?.record_id) return incoming;
  if (agentActivityLifecycleKey(current) !== agentActivityLifecycleKey(incoming)) return current;
  return Number(incoming.sequence) > Number(current.sequence) ? incoming : current;
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
    const current = runs.find((run) => run.state !== 'queued');
    const selected = runs.filter((run) => {
      if (run === current || run.state === 'failed') return true;
      if (run.state !== 'queued') return false;
      const expiresAt = Date.parse(run.lease_expires_at || run.expires_at || '');
      return run.lease_health !== 'stale' && (!Number.isFinite(expiresAt) || expiresAt > nowMs);
    });
    const earlier = runs.filter((run) => !selected.includes(run));
    // Even a queue-only conversation retains its expired records in diagnostics.
    if (!selected.length) return [{ ...runs[0], earlier_activities: runs.slice(1) }];
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
