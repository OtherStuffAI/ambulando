import {
  LIVE_THREAD_ACTIVITY_CAPABILITY,
  liveOverlayAsAgentActivity,
  ThreadLiveActivityController,
  terminalLiveActivityHasDurableFinal,
} from './thread-live-activity.js';
import { refreshInstalledAutopilotConnection } from './autopilot-connection-refresh.js';

const text = (value) => String(value ?? '').trim();

function mentionedAgent(store) {
  const thread = store.getThreadParentMessage?.();
  const threadIds = new Set(
    [store.activeThreadId, thread?.record_id, thread?.pg_thread_id, thread?.thread_id]
      .map(text)
      .filter(Boolean),
  );
  const messages = [
    thread,
    ...(store.messages || []).filter((message) =>
      threadIds.has(text(message?.thread_id || message?.parent_message_id)),
    ),
  ]
    .filter(Boolean)
    .reverse();
  const installed = new Map(
    (store.workspaceAgents || []).map((agent) => [text(agent.agent_npub), agent]),
  );
  for (const message of messages) {
    for (const mention of message?.mentions || message?.metadata?.mentions || []) {
      if (mention?.type === 'agent' && installed.has(text(mention.npub)))
        return installed.get(text(mention.npub));
    }
  }
  const towerActivity = (store.agentActivities || []).find(
    (activity) =>
      threadIds.has(text(activity.thread_id)) && installed.has(text(activity.agent_npub)),
  );
  return installed.get(text(towerActivity?.agent_npub)) || null;
}

export const threadLiveActivityManagerMixin = {
  liveThreadActivityOverlay: null,
  liveThreadActivityContext: null,
  liveThreadActivityAvailability: 'idle',
  liveThreadActivityAvailabilityMessage: '',
  _threadLiveActivityController: null,
  _liveThreadActivityRefreshes: null,

  startThreadLiveActivity() {
    if (!this.activeThreadId || !this.isTowerPgMode) {
      this.stopThreadLiveActivity();
      return;
    }
    const agent = mentionedAgent(this);
    const connection = (this.agentConnections || []).find((row) => row.id === agent?.connection_id);
    const parent = this.getThreadParentMessage?.();
    const context = {
      ownerNpub: text(this.currentWorkspace?.workspaceOwnerNpub),
      workspaceId: text(this.currentWorkspace?.workspaceId),
      towerServiceNpub: text(
        this.currentWorkspace?.towerServiceNpub || this.currentWorkspace?.serviceNpub,
      ),
      appNpub: text(this.currentWorkspace?.appNpub),
      channelId: text(parent?.channel_id || this.activeChannelId),
      threadId: text(
        parent?.pg_thread_id || parent?.thread_id || this.deckThreadTowerId || this.activeThreadId,
      ),
      agentNpub: text(agent?.agent_npub),
    };
    if (!connection || Object.values(context).some((value) => !value)) {
      this.stopThreadLiveActivity();
      return;
    }
    if (!connection.capabilities?.includes(LIVE_THREAD_ACTIVITY_CAPABILITY)) {
      this._refreshThreadLiveActivityConnection(connection);
      return;
    }
    const key = JSON.stringify([connection.id, ...Object.values(context)]);
    if (this.liveThreadActivityContext?.key === key) return;
    this._threadLiveActivityController ??= new ThreadLiveActivityController({
      onChange: (overlay) => {
        this.liveThreadActivityOverlay = overlay;
        this.responseActivityTick = Number(this.responseActivityTick || 0) + 1;
      },
    });
    this.liveThreadActivityContext = { ...context, key };
    this.liveThreadActivityAvailability = 'available';
    this.liveThreadActivityAvailabilityMessage = '';
    void this._threadLiveActivityController.open({ connection, context });
  },

  async _refreshThreadLiveActivityConnection(connection, { force = false } = {}) {
    if (!this._liveThreadActivityRefreshes) this._liveThreadActivityRefreshes = new Map();
    const fingerprint = JSON.stringify([connection.id, connection.row_version, connection.capabilities]);
    if (!force && this._liveThreadActivityRefreshes.has(fingerprint)) return this._liveThreadActivityRefreshes.get(fingerprint);
    this.liveThreadActivityAvailability = 'checking';
    this.liveThreadActivityAvailabilityMessage = '';
    const activeThreadId = text(this.activeThreadId);
    const stillCurrent = () => activeThreadId && text(this.activeThreadId) === activeThreadId
      && (this.agentConnections || []).some((row) => row.id === connection.id);
    const refresh = refreshInstalledAutopilotConnection(this, connection)
      .then(({ verified }) => {
        if (!stillCurrent()) return false;
        if (!verified.capabilities.includes(LIVE_THREAD_ACTIVITY_CAPABILITY)) {
          this.liveThreadActivityAvailability = 'unsupported';
          this.liveThreadActivityAvailabilityMessage = 'This Autopilot does not support live activity. Tower updates remain available; upgrade Autopilot, then retry the capability check.';
          return false;
        }
        this.liveThreadActivityAvailability = 'refreshing';
        this.liveThreadActivityAvailabilityMessage = 'Verified updated Autopilot capabilities. Enabling live activity…';
        return true;
      })
      .catch((error) => {
        if (!stillCurrent()) return false;
        const code = text(error?.code);
        if (code === 'route_unavailable') {
          this.liveThreadActivityAvailability = 'unsupported';
          this.liveThreadActivityAvailabilityMessage = 'This healthy Autopilot uses an older connection package. Upgrade Autopilot, then retry the capability check; Tower updates remain available.';
        } else if (['installation_mismatch', 'endpoint_mismatch'].includes(code) || /preserve the installed .* identity/i.test(text(error?.message))) {
          this.liveThreadActivityAvailability = 'rejected';
          this.liveThreadActivityAvailabilityMessage = 'Live activity stayed disabled because the refreshed package did not match this installed Autopilot connection. Review the paired installation before retrying.';
        } else {
          this.liveThreadActivityAvailability = 'offline';
          this.liveThreadActivityAvailabilityMessage = '';
        }
        return false;
      });
    this._liveThreadActivityRefreshes.set(fingerprint, refresh);
    return refresh;
  },

  retryThreadLiveActivityCapabilityRefresh() {
    const agent = mentionedAgent(this);
    const connection = (this.agentConnections || []).find((row) => row.id === agent?.connection_id);
    if (connection) void this._refreshThreadLiveActivityConnection(connection, { force: true });
  },

  stopThreadLiveActivity() {
    this._threadLiveActivityController?.clear();
    this.liveThreadActivityOverlay = null;
    this.liveThreadActivityContext = null;
    this.liveThreadActivityAvailability = 'idle';
    this.liveThreadActivityAvailabilityMessage = '';
  },

  getLiveThreadActivityRow() {
    const overlay = this.liveThreadActivityOverlay;
    if (!overlay || !this.liveThreadActivityContext) return null;
    if (terminalLiveActivityHasDurableFinal(overlay, this.messages || [])) {
      this.stopThreadLiveActivity();
      return null;
    }
    return liveOverlayAsAgentActivity(overlay, this.liveThreadActivityContext);
  },

  mergeThreadLiveActivity(towerActivities = []) {
    const overlay = this.getLiveThreadActivityRow();
    if (!overlay) return towerActivities;
    const live = { ...overlay, backend_url: overlay.backend_url || this.backendUrl || '' };
    return [
      ...towerActivities.filter((row) => !(
        text(row.agent_npub) === text(live.agent_npub)
        && text(row.thread_id) === text(live.thread_id)
        && text(row.turn_id) === text(live.turn_id)
      )),
      live,
    ].sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')));
  },
};
