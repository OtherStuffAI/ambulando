import { beforeEach, describe, expect, it, vi } from 'vitest';
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
beforeEach(() => vi.clearAllMocks());
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
});
