import { expect, it, vi } from 'vitest';
vi.mock('../src/api.js', async () => ({ ...await vi.importActual('../src/api.js'), removeTowerPgWorkspaceMember: vi.fn() }));
import { removeTowerPgWorkspaceMember } from '../src/api.js';
import { openWorkspaceDb, getWorkspaceDb, getWorkspaceMembers, replaceWorkspaceMembers } from '../src/db.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import { TowerSyncService } from '../src/tower-sync-service.js';

it('commits accepted removal in its original partition before a disposed sync service rejects its late response', async () => {
  openWorkspaceDb(`remove-command-${crypto.randomUUID()}`);
  const original = getWorkspaceDb();
  await original.open();
  const member = { actor_id: 'retired', npub: 'npub-retired' };
  await replaceWorkspaceMembers('workspace-a', [member]);
  let finish;
  removeTowerPgWorkspaceMember.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const service = new TowerSyncService({ workspaceKey: 'workspace-a', ports: {
    prepareCommand: (name, input) => prepareTowerWorkspaceCommand({}, name, input),
  } });
  const command = service.command('workspace-member.remove', { args: ['workspace-a', member.actor_id, { confirm_npub: member.npub, confirmation_token: 'token' }] });
  const rejected = expect(command).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  service.dispose();
  openWorkspaceDb(`remove-command-other-${crypto.randomUUID()}`);
  const other = getWorkspaceDb();
  await other.open();
  await replaceWorkspaceMembers('workspace-b', [{ actor_id: 'other', npub: member.npub }]);
  finish({ removed: true, actor: { id: member.actor_id, npub: member.npub } });
  try {
    await rejected;
    await original.open();
    expect(await original.workspace_members.get(member.actor_id)).toBeUndefined();
    expect((await original.sync_state.get('workspace-member-removals:workspace-a')).value.retired.npub).toBe(member.npub);
    expect(await getWorkspaceMembers('workspace-b')).toHaveLength(1);
  } finally { await original.delete(); await other.delete(); }
});
