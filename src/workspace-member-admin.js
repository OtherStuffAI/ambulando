import { getTowerPgWorkspaceMemberAccess, previewTowerPgWorkspaceMemberRemoval } from './api.js';
import { removeTowerPgWorkspaceMember, setTowerPgWorkspaceAgentManager } from './tower-command-intents.js';
import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';

function contextKey(context) {
  return JSON.stringify([context.workspaceId, context.baseUrl, context.appNpub, context.generation, context.sessionNpub]);
}

const permissionLabels = {
  'workspace.read': 'View workspace', 'workspace.manage': 'Manage workspace', 'workspace.invite': 'Invite workspace members',
  'event_subscription.manage': 'Manage event subscriptions', 'scope.read': 'View scope', 'scope.create': 'Create scopes',
  'scope.manage': 'Manage scope', 'context.edit': 'Edit scope context', 'channel.read': 'Read channel',
  'channel.create': 'Create channels', 'channel.write': 'Write channel messages', 'channel.manage': 'Manage channel',
  'channel.grant': 'Grant channel access', 'channel.grants.read': 'Inspect channel access', 'channel.grants.manage': 'Manage channel access',
  'task.read': 'Read tasks', 'task.create': 'Create tasks', 'task.update': 'Update tasks', 'task.comment': 'Comment on tasks',
  'comment.create': 'Create comments', 'doc.read': 'Read documents', 'doc.write': 'Write documents',
  'file.read': 'Read files', 'file.write': 'Write files', 'audio_note.read': 'Read audio notes', 'audio_note.write': 'Write audio notes',
  'daily_note.read': 'Read personal daily notes', 'daily_note.write': 'Write personal daily notes',
  'org_data.read': 'Read organisation data', 'org_data.write': 'Write organisation data', 'org_data.schema': 'Manage organisation data schema',
  'napplet.publish': 'Publish napplets', 'napplet.install': 'Install napplets',
};

export const workspaceMemberAdminMixin = {
  getPgMemberAdminPermissionLabel(permission) {
    return permissionLabels[permission] || 'Additional permission';
  },
  getPgMemberAdminGrantResourceLabel(grant) {
    const coverage = this.pgMemberAdmin?.access?.coverage || {};
    if (grant.resource_channel_id) {
      const channel = (coverage.channels || []).find(row => row.id === grant.resource_channel_id);
      const scope = channel && (coverage.scopes || []).find(row => row.id === channel.scope_id);
      return `Channel: ${channel?.name || 'name unavailable'}${scope?.name ? ` · Scope: ${scope.name}` : ''}`;
    }
    if (grant.resource_scope_id) {
      const scope = (coverage.scopes || []).find(row => row.id === grant.resource_scope_id);
      return `Scope: ${scope?.name || 'name unavailable'}`;
    }
    return grant.resource_type === 'workspace' ? 'Workspace' : 'Resource name unavailable';
  },
  getPgMemberAdminGrantGroupLabel(grant) {
    const group = (this.pgMemberAdmin?.preview?.groups || []).find(row => (row.id || row.group_id) === grant.principal_group_id);
    return group?.name ? `Through group: ${group.name}` : 'Through an inherited group (name unavailable)';
  },
  get pgMemberAdminVisible() {
    return Boolean(this.pgMemberAdmin && this.pgMemberAdmin.contextKey === contextKey(resolveTowerPgWorkspaceContext(this)));
  },
  getPgMemberRemovalBlockedMessage(reason) {
    if (reason === 'cannot_remove_self') return 'You cannot remove your own workspace membership.';
    if (reason === 'cannot_remove_owner') return 'The workspace owner cannot be removed.';
    return reason ? 'Tower has blocked removal of this member. Refresh access before continuing.' : '';
  },
  closePgMemberAdmin() {
    if (this.pgMemberAdminBusy) return;
    this.pgMemberAdmin = null;
    this.pgMemberAdminError = '';
    this.pgMemberAdminConfirmNpub = '';
    this.pgMemberAdminRoleConfirmed = false;
  },
  async openPgMemberAdmin(member) {
    if (this.pgMemberAdminBusy) return;
    const context = resolveTowerPgWorkspaceContext(this);
    const actorId = member?.actor_id || member?.id;
    if (!context.workspaceId || !actorId) return;
    const key = contextKey(context);
    this.pgMemberAdmin = { actor: { id: actorId, npub: member.npub, display_name: member.display_name, kind: member.kind }, contextKey: key, access: null, preview: null };
    this.pgMemberAdminError = '';
    this.pgMemberAdminConfirmNpub = '';
    this.pgMemberAdminRoleConfirmed = false;
    this.pgMemberAdminBusy = true;
    try {
      const access = await getTowerPgWorkspaceMemberAccess(context.workspaceId, actorId, context);
      if (contextKey(resolveTowerPgWorkspaceContext(this)) !== key) return;
      // Never display or act upon a response for a different selected identity.
      if (access?.actor?.id !== actorId || access.actor.npub !== member.npub) throw new Error('Tower returned a different member identity. Refresh the member list.');
      this.pgMemberAdmin = { ...this.pgMemberAdmin, actor: access.actor, access };
    } catch (error) {
      if (contextKey(resolveTowerPgWorkspaceContext(this)) === key) this.pgMemberAdminError = error?.message || 'Unable to inspect member access';
    } finally { this.pgMemberAdminBusy = false; }
  },
  async previewPgMemberRemoval() {
    if (this.pgMemberAdminBusy || !this.pgMemberAdminVisible || !this.pgMemberAdmin?.access?.can_administer) return;
    const selected = this.pgMemberAdmin;
    const context = resolveTowerPgWorkspaceContext(this);
    this.pgMemberAdminBusy = true;
    this.pgMemberAdminError = '';
    this.pgMemberAdminConfirmNpub = '';
    try {
      const result = await previewTowerPgWorkspaceMemberRemoval(context.workspaceId, selected.actor.id, context);
      if (!this.pgMemberAdminVisible || this.pgMemberAdmin !== selected) return;
      if (result?.preview?.actor?.id !== selected.actor.id || result.preview.actor.npub !== selected.actor.npub) throw new Error('Removal preview identity does not match the selected member.');
      this.pgMemberAdmin = { ...selected, preview: result.preview };
    } catch (error) { if (this.pgMemberAdminVisible) this.pgMemberAdminError = error?.message || 'Unable to preview removal'; }
    finally { this.pgMemberAdminBusy = false; }
  },
  async confirmPgMemberRemoval() {
    const selected = this.pgMemberAdmin;
    const preview = selected?.preview;
    if (this.pgMemberAdminBusy || !this.pgMemberAdminVisible || !preview?.confirmation_token || preview.blocked_reason || this.pgMemberAdminConfirmNpub !== selected.actor.npub) return;
    const context = resolveTowerPgWorkspaceContext(this);
    this.pgMemberAdminBusy = true;
    this.pgMemberAdminError = '';
    try {
      await removeTowerPgWorkspaceMember(this, context.workspaceId, selected.actor.id, { confirmation_token: preview.confirmation_token, confirm_npub: selected.actor.npub }, context);
      if (!this.pgMemberAdminVisible) return;
      // Refresh directory/group materialization; historical authors and records remain intact.
      await Promise.all([this.refreshTowerPgWorkspaceMembers?.({ reason: 'mutation', force: true }), this.refreshGroups?.({ force: true, minIntervalMs: 0 })]);
      if (!this.pgMemberAdminVisible) return;
      this.pgMemberAdmin = null;
      this.pgWorkspaceMemberAddNotice = 'Workspace access removed. Historical messages, authorship and audit history are preserved.';
    } catch (error) {
      if (this.pgMemberAdminVisible) {
        this.pgMemberAdminError = error?.message || 'Removal failed. Preview again before retrying.';
        this.pgMemberAdmin = { ...selected, preview: null };
        this.pgMemberAdminConfirmNpub = '';
      }
    } finally { this.pgMemberAdminBusy = false; }
  },
  async setPgMemberAgentManager(enabled) {
    const selected = this.pgMemberAdmin;
    if (this.pgMemberAdminBusy || !this.pgMemberAdminVisible || !selected?.access?.can_administer || !['human', 'agent'].includes(selected.actor.kind) || !this.pgMemberAdminRoleConfirmed || this.pgMemberAdminConfirmNpub !== selected.actor.npub) return;
    const context = resolveTowerPgWorkspaceContext(this);
    this.pgMemberAdminBusy = true;
    this.pgMemberAdminError = '';
    try {
      await setTowerPgWorkspaceAgentManager(this, context.workspaceId, selected.actor.id, { enabled, confirm_npub: selected.actor.npub }, context);
      if (!this.pgMemberAdminVisible) return;
      this.pgMemberAdminBusy = false;
      await this.openPgMemberAdmin(selected.actor);
    } catch (error) { if (this.pgMemberAdminVisible) this.pgMemberAdminError = error?.message || 'Unable to change agent-manager role'; }
    finally { this.pgMemberAdminBusy = false; }
  },
};
