import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb, getWorkspaceDb, getWorkspaceMembers, replaceWorkspaceMembers } from '../src/db.js';
vi.mock('../src/api.js', () => ({ getTowerPgWorkspaceMemberAccess: vi.fn(), previewTowerPgWorkspaceMemberRemoval: vi.fn() }));
vi.mock('../src/tower-command-intents.js', () => ({ removeTowerPgWorkspaceMember: vi.fn(), setTowerPgWorkspaceAgentManager: vi.fn() }));
vi.mock('../src/pg-workspace-context.js', () => ({ resolveTowerPgWorkspaceContext: (store) => store.context }));
import { getTowerPgWorkspaceMemberAccess, previewTowerPgWorkspaceMemberRemoval } from '../src/api.js';
import { removeTowerPgWorkspaceMember, setTowerPgWorkspaceAgentManager } from '../src/tower-command-intents.js';
import { workspaceMemberAdminMixin } from '../src/workspace-member-admin.js';

const actor = { id: 'actor-a', npub: 'npub-exact-current', kind: 'agent', display_name: 'Current Orion' };
function store() {
  const state = { context: { workspaceId: 'workspace-a', baseUrl: 'http://127.0.0.1:3100', appNpub: 'app', generation: 1, sessionNpub: 'owner' }, pgMemberAdminBusy: false, refreshGroups: vi.fn(), refreshTowerPgWorkspaceMembers: vi.fn() };
  Object.defineProperties(state, Object.getOwnPropertyDescriptors(workspaceMemberAdminMixin));
  return state;
}
async function opened() {
  const state = store();
  getTowerPgWorkspaceMemberAccess.mockResolvedValue({ actor, can_administer: true, agent_manager: false, coverage: {} });
  await state.openPgMemberAdmin(actor);
  return state;
}
let db;
beforeEach(async () => {
  vi.clearAllMocks();
  openWorkspaceDb(`member-admin-${crypto.randomUUID()}`);
  db = getWorkspaceDb();
  await db.open();
});
afterEach(async () => { await db.delete(); });
describe('workspace membership administration', () => {
  it('rejects access responses for another identity instead of enabling actions', async () => {
    getTowerPgWorkspaceMemberAccess.mockResolvedValue({ actor: { ...actor, npub: 'npub-old' }, can_administer: true });
    const state = store();
    await state.openPgMemberAdmin(actor);
    expect(state.pgMemberAdmin.access).toBeNull();
    expect(state.pgMemberAdminError).toContain('different member identity');
  });
  it('discards an access response after switching workspaces', async () => {
    let finish;
    getTowerPgWorkspaceMemberAccess.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const state = store();
    const pending = state.openPgMemberAdmin(actor);
    state.context = { ...state.context, workspaceId: 'workspace-b' };
    finish({ actor, can_administer: true });
    await pending;
    expect(state.pgMemberAdminVisible).toBe(false);
    expect(state.pgMemberAdmin.access).toBeNull();
  });
  it('requires both deliberate role acknowledgement and the exact full npub', async () => {
    const state = await opened();
    await state.setPgMemberAgentManager(true);
    state.pgMemberAdminRoleConfirmed = true;
    state.pgMemberAdminConfirmNpub = 'npub-old';
    await state.setPgMemberAgentManager(true);
    expect(setTowerPgWorkspaceAgentManager).not.toHaveBeenCalled();
    state.pgMemberAdminConfirmNpub = actor.npub;
    await state.setPgMemberAgentManager(true);
    expect(setTowerPgWorkspaceAgentManager).toHaveBeenCalledWith(state, 'workspace-a', actor.id, { enabled: true, confirm_npub: actor.npub }, state.context);
    expect(state.pgMemberAdminConfirmNpub).toBe('');
  });
  it('supports legacy human-kind agents without changing their global actor kind', async () => {
    const state = await opened();
    state.pgMemberAdmin.actor = { ...actor, kind: 'human' };
    state.pgMemberAdminRoleConfirmed = true;
    state.pgMemberAdminConfirmNpub = actor.npub;
    await state.setPgMemberAgentManager(true);
    expect(setTowerPgWorkspaceAgentManager).toHaveBeenCalledWith(state, 'workspace-a', actor.id, { enabled: true, confirm_npub: actor.npub }, state.context);
  });
  it('does not offer role mutations to app or service actors', async () => {
    const state = await opened();
    state.pgMemberAdminRoleConfirmed = true;
    state.pgMemberAdminConfirmNpub = actor.npub;
    for (const kind of ['app', 'service']) {
      state.pgMemberAdmin.actor = { ...actor, kind };
      await state.setPgMemberAgentManager(true);
    }
    expect(setTowerPgWorkspaceAgentManager).not.toHaveBeenCalled();
  });
  it('labels known permissions and resources without inventing missing names', async () => {
    const state = await opened();
    state.pgMemberAdmin.access.coverage = { scopes: [{ id: 'scope-a', name: 'Research' }], channels: [{ id: 'channel-a', scope_id: 'scope-a', name: 'Design' }] };
    state.pgMemberAdmin.preview = { groups: [{ id: 'group-a', name: 'Editors' }] };
    expect(state.getPgMemberAdminPermissionLabel('channel.read')).toBe('Read channel');
    expect(state.getPgMemberAdminPermissionLabel('unknown.permission')).toBe('Additional permission');
    expect(state.getPgMemberAdminGrantResourceLabel({ resource_channel_id: 'channel-a' })).toBe('Channel: Design · Scope: Research');
    expect(state.getPgMemberAdminGrantResourceLabel({ resource_scope_id: 'scope-a' })).toBe('Scope: Research');
    expect(state.getPgMemberAdminGrantResourceLabel({ resource_type: 'workspace' })).toBe('Workspace');
    expect(state.getPgMemberAdminGrantResourceLabel({ resource_channel_id: 'unknown' })).toBe('Channel: name unavailable');
    expect(state.getPgMemberAdminGrantGroupLabel({ principal_group_id: 'group-a' })).toBe('Through group: Editors');
    expect(state.getPgMemberAdminGrantGroupLabel({ principal_group_id: 'unknown' })).toBe('Through an inherited group (name unavailable)');
  });
  it('requires preview, exact identity and an unblocked token before removal', async () => {
    const state = await opened();
    state.pgMemberAdminConfirmNpub = actor.npub;
    await state.confirmPgMemberRemoval();
    expect(removeTowerPgWorkspaceMember).not.toHaveBeenCalled();
    previewTowerPgWorkspaceMemberRemoval.mockResolvedValue({ preview: { actor, confirmation_token: 'preview-token', blocked_reason: null } });
    await state.previewPgMemberRemoval();
    expect(state.pgMemberAdminConfirmNpub).toBe('');
    state.pgMemberAdminConfirmNpub = 'Current Orion';
    await state.confirmPgMemberRemoval();
    expect(removeTowerPgWorkspaceMember).not.toHaveBeenCalled();
    state.pgMemberAdminConfirmNpub = actor.npub;
    state.pgMemberAdmin.preview.blocked_reason = 'self-removal';
    await state.confirmPgMemberRemoval();
    expect(removeTowerPgWorkspaceMember).not.toHaveBeenCalled();
    state.pgMemberAdmin.preview.blocked_reason = null;
    await state.confirmPgMemberRemoval();
    expect(removeTowerPgWorkspaceMember).toHaveBeenCalledWith(state, 'workspace-a', actor.id, { confirmation_token: 'preview-token', confirm_npub: actor.npub }, state.context);
    expect(state.refreshTowerPgWorkspaceMembers).toHaveBeenCalled();
    expect(state.pgMemberAdmin).toBeNull();
  });
  it('invalidates preview on rejection so removal cannot be blindly replayed', async () => {
    const state = await opened();
    previewTowerPgWorkspaceMemberRemoval.mockResolvedValue({ preview: { actor, confirmation_token: 'token' } });
    await state.previewPgMemberRemoval();
    state.pgMemberAdminConfirmNpub = actor.npub;
    removeTowerPgWorkspaceMember.mockRejectedValueOnce(new Error('Preview changed'));
    await state.confirmPgMemberRemoval();
    expect(state.pgMemberAdmin.preview).toBeNull();
    expect(state.pgMemberAdminConfirmNpub).toBe('');
    expect(state.pgMemberAdminError).toBe('Preview changed');
  });
  it('retires cached identity after accepted removal even when refresh fails, preserving history and other workspaces', async () => {
    const state = await opened();
    await replaceWorkspaceMembers('workspace-a', [{ ...actor, actor_id: actor.id }]);
    await replaceWorkspaceMembers('workspace-b', [{ actor_id: 'other-actor', npub: actor.npub }]);
    await db.chat_messages.put({ record_id: 'history', sender_npub: actor.npub, body: 'Keep this' });
    await db.pg_actors.put({ actor_id: actor.id, npub: actor.npub });
    state.pgWorkspaceMembers = [{ ...actor, actor_id: actor.id }];
    state.newChannelDmNpub = actor.npub;
    state.refreshActiveMentionResults = vi.fn();
    state.refreshTowerPgWorkspaceMembers.mockRejectedValueOnce(new Error('offline'));
    previewTowerPgWorkspaceMemberRemoval.mockResolvedValue({ preview: { actor, confirmation_token: 'token' } });
    await state.previewPgMemberRemoval();
    state.pgMemberAdminConfirmNpub = actor.npub;
    await state.confirmPgMemberRemoval();
    expect(state.pgMemberAdmin).toBeNull();
    expect(state.pgWorkspaceMembers).toEqual([]);
    expect(state.newChannelDmNpub).toBe('');
    expect(state.refreshActiveMentionResults).toHaveBeenCalled();
    expect(await getWorkspaceMembers('workspace-a')).toEqual([]);
    expect(await getWorkspaceMembers('workspace-b')).toHaveLength(1);
    expect(await db.chat_messages.get('history')).toMatchObject({ body: 'Keep this', sender_npub: actor.npub });
    expect(await db.pg_actors.get(actor.id)).toMatchObject({ npub: actor.npub });
    expect(state.pgWorkspaceMemberAddNotice).toContain('could not refresh');
    db.close(); await db.open();
    await replaceWorkspaceMembers('workspace-a', [{ ...actor, actor_id: actor.id }]);
    expect(await getWorkspaceMembers('workspace-a')).toEqual([]);
  });
  it.each(['cannot_remove_self', 'cannot_remove_owner'])('preserves protected membership when Tower reports %s', async blocked_reason => {
    const state = await opened();
    previewTowerPgWorkspaceMemberRemoval.mockResolvedValue({ preview: { actor, confirmation_token: 'token', blocked_reason } });
    await state.previewPgMemberRemoval(); state.pgMemberAdminConfirmNpub = actor.npub;
    await state.confirmPgMemberRemoval();
    expect(removeTowerPgWorkspaceMember).not.toHaveBeenCalled();
    expect(state.getPgMemberRemovalBlockedMessage(blocked_reason)).toMatch(/cannot/);
  });
  it('does not preview or remove without Tower administration authority', async () => {
    const state = await opened();
    state.pgMemberAdmin.access.can_administer = false;
    await state.previewPgMemberRemoval();
    expect(previewTowerPgWorkspaceMemberRemoval).not.toHaveBeenCalled();
    state.pgMemberAdmin.preview = { confirmation_token: 'stale-token' };
    state.pgMemberAdminConfirmNpub = actor.npub;
    await state.confirmPgMemberRemoval();
    expect(removeTowerPgWorkspaceMember).not.toHaveBeenCalled();
  });
  it('persists an accepted removal in its original database after switching workspaces during the command', async () => {
    const state = await opened();
    await replaceWorkspaceMembers('workspace-a', [{ ...actor, actor_id: actor.id }]);
    previewTowerPgWorkspaceMemberRemoval.mockResolvedValue({ preview: { actor, confirmation_token: 'token' } });
    await state.previewPgMemberRemoval(); state.pgMemberAdminConfirmNpub = actor.npub;
    let finish;
    removeTowerPgWorkspaceMember.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = state.confirmPgMemberRemoval();
    openWorkspaceDb(`member-admin-other-${crypto.randomUUID()}`);
    const other = getWorkspaceDb();
    await other.open();
    state.context = { ...state.context, workspaceId: 'workspace-b' };
    state.pgWorkspaceMembers = [{ actor_id: 'other', npub: actor.npub }];
    await replaceWorkspaceMembers('workspace-b', state.pgWorkspaceMembers);
    finish({ removed: true, actor });
    await pending;
    await db.open();
    expect(await db.workspace_members.get(actor.id)).toBeUndefined();
    expect(state.pgWorkspaceMembers).toEqual([{ actor_id: 'other', npub: actor.npub }]);
    expect(await getWorkspaceMembers('workspace-b')).toHaveLength(1);
    expect(state.refreshTowerPgWorkspaceMembers).not.toHaveBeenCalled();
    await other.delete();
  });
});
