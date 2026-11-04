import { storedPackage } from './autopilot-connection-refresh.js';
import { createAutopilotDiscoveryClient } from './autopilot-connect-client.js';

export const LIVE_THREAD_ACTIVITY_CAPABILITY = 'flightdeck.live-thread-activity.v1';
export const LIVE_THREAD_RECONNECT_GRACE_MS = 8_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stopped']);

const text = (value) => String(value ?? '').trim();

export function reconcileLiveThreadActivity(current, incoming, expected = {}) {
  if (!incoming || text(incoming.routing_key) !== text(expected.routingKey || incoming.routing_key))
    return current;
  const generation = Number(incoming.session_generation);
  const sequence = Number(incoming.sequence);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !text(incoming.turn_id) ||
    !text(incoming.cursor)
  )
    return current;
  const started = (startedAt) => ({ ...incoming, session_generation: generation, sequence,
    started_at: text(startedAt || incoming.timestamp) });
  if (!current) return started();
  const currentGeneration = Number(current.session_generation);
  if (generation < currentGeneration) return current;
  if (generation > currentGeneration) return started();
  if (text(incoming.turn_id) !== text(current.turn_id)) return current;
  // A turn's start time is immutable; later events only move its content.
  return sequence > Number(current.sequence) ? started(current.started_at) : current;
}

async function consumeSse(response, onActivity, signal) {
  if (!response.body) throw new Error('Autopilot live activity stream has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Autopilot live activity stream ended.');
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = block
          .split('\n')
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (event === 'activity' && data) onActivity(JSON.parse(data));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class ThreadLiveActivityController {
  constructor({
    createClient = createAutopilotDiscoveryClient,
    graceMs = LIVE_THREAD_RECONNECT_GRACE_MS,
    onChange = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.createClient = createClient;
    this.graceMs = graceMs;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.abort = null;
    this.client = null;
    this.context = null;
    this.overlay = null;
    this.graceTimer = null;
    this.run = 0;
  }

  clear() {
    this.run += 1;
    this.abort?.abort();
    this.abort = null;
    if (this.graceTimer) this.clearTimer(this.graceTimer);
    this.graceTimer = null;
    this.client?.disconnect?.();
    this.client = null;
    this.context = null;
    this.setOverlay(null);
  }

  async open({ connection, context }) {
    this.clear();
    if (!connection?.capabilities?.includes(LIVE_THREAD_ACTIVITY_CAPABILITY)) return;
    const run = this.run;
    this.context = context;
    try {
      this.client = this.createClient(storedPackage(connection));
      await this.loadSnapshot(run);
      if (run !== this.run) return;
      await this.stream(run);
    } catch (error) {
      if (run === this.run && error?.name !== 'AbortError') this.reconnecting(run);
    }
  }

  async loadSnapshot(run) {
    const snapshot = await this.client.liveThreadSnapshot(this.context);
    if (run !== this.run) return;
    if (!snapshot?.activity) this.setOverlay(null);
    else this.accept(snapshot.activity, { replace: true });
    this.cursor = text(snapshot?.cursor || snapshot?.activity?.cursor || '0');
  }

  async stream(run) {
    while (run === this.run) {
      this.abort = new AbortController();
      try {
        const response = await this.client.liveThreadEvents(
          this.context,
          this.cursor,
          this.abort.signal,
        );
        if (this.graceTimer) this.clearTimer(this.graceTimer);
        this.graceTimer = null;
        if (this.overlay?.reconnecting) this.setOverlay({ ...this.overlay, reconnecting: false });
        await consumeSse(response, (activity) => this.accept(activity), this.abort.signal);
      } catch (error) {
        if (run !== this.run || this.abort.signal.aborted) return;
        this.reconnecting(run);
        if (error?.status === 409) await this.loadSnapshot(run);
        await new Promise((resolve) => this.setTimer(resolve, 500));
      }
    }
  }

  reconnecting(run) {
    if (this.overlay) this.setOverlay({ ...this.overlay, reconnecting: true });
    if (this.graceTimer) this.clearTimer(this.graceTimer);
    this.graceTimer = this.setTimer(() => {
      if (run === this.run) this.setOverlay(null);
    }, this.graceMs);
  }

  accept(activity, { replace = false } = {}) {
    const next = replace
      ? reconcileLiveThreadActivity(null, activity)
      : reconcileLiveThreadActivity(this.overlay, activity);
    if (next === this.overlay) return;
    this.cursor = text(next.cursor || this.cursor || '0');
    if (this.graceTimer) this.clearTimer(this.graceTimer);
    this.graceTimer = null;
    this.setOverlay({ ...next, reconnecting: false });
  }

  setOverlay(value) {
    this.overlay = value;
    this.onChange(value);
  }
}

export function liveOverlayAsAgentActivity(overlay, context) {
  if (!overlay) return null;
  return {
    record_id: `live:${overlay.routing_key}:${overlay.turn_id}`,
    activity_id: `live:${overlay.routing_key}:${overlay.turn_id}`,
    workspace_id: context.workspaceId,
    channel_id: context.channelId,
    thread_id: context.threadId,
    agent_npub: context.agentNpub,
    turn_id: overlay.turn_id,
    state: text(overlay.lifecycle).toLowerCase() === 'stopped' ? 'cancelled' : overlay.lifecycle,
    visibility: 'user_visible',
    sequence: overlay.sequence,
    body: overlay.commentary || overlay.activity_status,
    summary: overlay.commentary || overlay.activity_status,
    label: overlay.reconnecting ? 'Reconnecting…' : overlay.activity_status,
    updated_at: overlay.timestamp,
    created_at: overlay.started_at || overlay.timestamp,
    live_overlay: true,
    reconnecting: overlay.reconnecting,
    commentary_history: overlay.commentary
      ? [
          {
            activity_id: `live:${overlay.routing_key}:${overlay.turn_id}`,
            turn_id: overlay.turn_id,
            sequence: overlay.sequence,
            body: overlay.commentary,
            created_at: overlay.timestamp,
            workspace_id: context.workspaceId,
            visibility: 'user_visible',
          },
        ]
      : [],
  };
}

export function terminalLiveActivityHasDurableFinal(overlay, messages = []) {
  return Boolean(
    overlay &&
      TERMINAL.has(text(overlay.lifecycle).toLowerCase()) &&
      messages.some(
        (message) =>
          text(message?.metadata?.source) === 'autopilot_session' &&
          text(message?.metadata?.turn_id) === text(overlay.turn_id),
      ),
  );
}

// Tower is the liveness authority. The overlay carries no lease, so it never
// asserts work on its own: without a Tower row for its turn it contributes
// nothing. With one, it only adds newer public commentary or a terminal state;
// the Tower record keeps its identity, created time, lease and history, so an
// expired Tower lease cannot be shadowed.
export function boundLiveOverlayByTower(overlayRow, towerRow) {
  if (!towerRow) return null;
  if (!overlayRow) return towerRow;
  const terminalTower = TERMINAL.has(text(towerRow.state).toLowerCase());
  if (terminalTower) return towerRow;
  const overlayTerminal = TERMINAL.has(text(overlayRow.state).toLowerCase());
  const history = Array.isArray(towerRow.commentary_history) ? towerRow.commentary_history : [];
  const commentary = text(overlayRow.commentary_history?.[0]?.body);
  const overlayNewer = !(Date.parse(towerRow.updated_at || '') > Date.parse(overlayRow.updated_at || ''));
  const addCommentary = commentary && overlayNewer && !history.some((item) => text(item.body) === commentary)
    && text(towerRow.body) !== commentary;
  return {
    ...towerRow,
    ...(overlayTerminal ? { state: overlayRow.state } : {}),
    ...(addCommentary ? {
      body: commentary,
      summary: commentary,
      commentary_history: [...history, {
        history_key: `live:${towerRow.turn_id}:${overlayRow.sequence}`,
        activity_id: towerRow.activity_id,
        turn_id: towerRow.turn_id,
        sequence: Number(towerRow.sequence) + 0.5,
        body: commentary,
        created_at: overlayRow.updated_at,
        visibility: 'user_visible',
      }],
    } : {}),
    live_overlay: true,
    reconnecting: overlayRow.reconnecting,
  };
}
