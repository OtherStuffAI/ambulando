import { resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';
import { previewTowerPgChannelMove, moveTowerPgChannel } from './tower-command-intents.js';
import { isDmChannel, isDmScope } from './dm-scope.js';

function context(store) {
  const ctx = resolveTowerPgWorkspaceContext(store);
  if (!ctx.workspaceId || !ctx.baseUrl || ctx.workspaceId !== store.channelSettingsWorkspaceId) {
    throw new Error('The workspace changed. Close settings and select the channel again.');
  }
  return ctx;
}
function contextKey(ctx) {
  return JSON.stringify([ctx.workspaceId, ctx.baseUrl, ctx.appNpub, ctx.sessionNpub, ctx.generation]);
}
function errorMessage(error) {
  if (error?.status === 403) return 'Tower denied this move. You need Manage access to the channel and both scopes, plus permission to read channel grants.';
  if (error?.status === 404) return 'The channel or destination is no longer available. Close settings and refresh.';
  if (error?.status === 409) return `The move preview is no longer valid or this channel cannot be moved. Preview again. ${error?.payload?.message || error?.payload?.error || ''}`;
  return error?.message || 'The connection failed. Retry the same move to safely check its result.';
}

export const channelMoveMixin = {
  channelMoveDestinationId: '',
  channelMovePreview: null,
  channelMoveRequest: null,
  channelMoveContextKey: '',
  channelMoveBusy: false,
  channelMoveError: '',
  channelMoveNotice: '',
  get canMoveSettingsChannel() {
    const channel = (this.channels || []).find(row => row.record_id === this.channelSettingsChannelId);
    return Boolean(this.isTowerPgMode && channel && !isDmChannel(channel)
      && !['default', 'system', 'archive'].includes(channel.pg_kind || channel.channel_type)
      && !(this.scopes || []).some(scope => scope.default_channel_id === channel.record_id || scope.pg_default_channel_id === channel.record_id)
      && !channel.metadata?.system_key && !channel.archived_at && !['deleted', 'archived'].includes(channel.record_state) && this.canManageChannel(channel));
  },
  get channelMoveDestinations() {
    const channel = (this.channels || []).find(row => row.record_id === this.channelSettingsChannelId);
    return (this.scopes || []).filter(scope => scope.record_id !== channel?.scope_id
      && scope.record_state !== 'deleted' && !scope.archived_at && !scope.virtual && !scope.system_key
      && !['system', 'archive', 'default'].includes(scope.pg_kind) && !isDmScope(scope)
      && this.canManageScope?.(scope)).map(scope => ({ id: scope.record_id, label: this.getScopeBreadcrumb?.(scope.record_id) || scope.title || scope.record_id }));
  },
  resetChannelMove() {
    this.channelMoveContextKey = '';
    this.channelMoveDestinationId = '';
    this.channelMovePreview = null;
    this.channelMoveRequest = null;
    this.channelMoveError = '';
    this.channelMoveNotice = '';
  },
  invalidateChannelMovePreview() {
    if (this.channelMoveRequest) return;
    this.channelMovePreview = null;
    this.channelMoveError = '';
    this.channelMoveNotice = '';
  },
  channelMoveAccessLabel(row) {
    const labels = { 'scope.read': 'View scope', 'scope.manage': 'Manage scope', 'channel.read': 'Read channel', 'channel.manage': 'Manage channel', 'channel.grants.read': 'Read channel grants', 'channel.grants.manage': 'Manage channel grants' };
    return `${row.label || row.name || row.npub || row.actor_id || row.principal_id || 'Principal'}: ${(row.permissions || []).map(permission => labels[permission] || permission).join(', ') || row.permission || 'No permissions'}`;
  },
  async previewSettingsChannelMove() {
    if (this.channelMoveBusy || this.channelMoveRequest || !this.canMoveSettingsChannel) return;
    const destinationId = this.channelMoveDestinationId;
    const channelId = this.channelSettingsChannelId;
    this.channelMovePreview = null;
    this.channelMoveError = '';
    this.channelMoveNotice = '';
    this.channelMoveBusy = true;
    try {
      const ctx = context(this);
      if (!this.channelMoveDestinations.some(scope => scope.id === destinationId)) throw new Error('Choose an eligible destination scope.');
      const result = await previewTowerPgChannelMove(this, ctx.workspaceId, channelId,
        { destination_scope_id: destinationId }, { baseUrl: ctx.baseUrl, appNpub: ctx.appNpub });
      if (this.channelSettingsChannelId !== channelId || this.channelMoveDestinationId !== destinationId) return;
      if (contextKey(context(this)) !== contextKey(ctx)) throw new Error('The connection changed. Preview again.');
      const preview = result?.preview;
      if (!preview?.confirmation_token || preview.channel_id !== channelId || preview.destination_scope_id !== destinationId
        || !Array.isArray(preview.access_changes?.gained) || !Array.isArray(preview.access_changes?.lost)
        || preview.access_changes?.direct_grants_preserved !== true) throw new Error('Tower returned an incomplete access preview. Refresh and try again.');
      this.channelMoveContextKey = contextKey(ctx);
      this.channelMovePreview = preview;
    } catch (error) { this.channelMoveError = errorMessage(error); }
    finally { this.channelMoveBusy = false; }
  },
  async confirmSettingsChannelMove() {
    if (this.channelMoveBusy || !this.channelMovePreview) return;
    this.channelMoveBusy = true;
    this.channelMoveError = '';
    try {
      const ctx = context(this);
      if (this.channelMoveContextKey && this.channelMoveContextKey !== contextKey(ctx)) throw new Error('The connection changed. Close settings and preview again.');
      const preview = this.channelMovePreview;
      if (preview.channel_id !== this.channelSettingsChannelId || preview.destination_scope_id !== this.channelMoveDestinationId) throw new Error('Preview the selected destination again.');
      this.channelMoveRequest ||= { destination_scope_id: preview.destination_scope_id,
        confirmation_token: preview.confirmation_token, mutation_id: crypto.randomUUID() };
      const result = await moveTowerPgChannel(this, ctx.workspaceId, preview.channel_id,
        { ...this.channelMoveRequest }, { baseUrl: ctx.baseUrl, appNpub: ctx.appNpub });
      if (!result?.channel?.id || result.channel.scope_id !== preview.destination_scope_id) throw new Error('Move acknowledgement unavailable. Retry the same move.');
      context(this);
      this.channelMovePreview = null;
      this.channelMoveRequest = null;
      this.channelMoveNotice = 'Channel moved. Conversations, tasks, documents, files and links keep their identities.';
      // Rendered domain collections remain owned by Dexie liveQuery.
    } catch (error) {
      if ([403, 404, 409].includes(error?.status)) {
        this.channelMovePreview = null;
        this.channelMoveRequest = null;
      }
      this.channelMoveError = errorMessage(error);
    } finally { this.channelMoveBusy = false; }
  },
};
