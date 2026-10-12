import { beforeEach, expect, it, vi } from 'vitest';
const commands = vi.hoisted(() => ({ remove: vi.fn(), add: vi.fn(), member: vi.fn(), create: vi.fn() }));
vi.mock('../src/backend-mode.js', () => ({ isTowerPgBackendMode: () => true }));
vi.mock('../src/tower-command-intents.js', async importOriginal => ({
  ...await importOriginal(), removeTowerPgWorkspaceGroupMember: commands.remove,
  addTowerPgWorkspaceGroupMember: commands.add, createTowerPgWorkspaceMember: commands.member,
  createTowerPgWorkspaceGroup: commands.create,
}));
import { channelsManagerMixin } from '../src/channels-manager.js';
function store(overrides = {}) {
  return {
    currentWorkspace: {workspaceId:'workspace',workspaceOwnerNpub:'owner',directHttpsUrl:'http://127.0.0.1',appNpub:'fixture',pgBackendMode:true},
    session:{npub:'keeper'},canAdminWorkspace:true,groupEditPending:false,
    groups:[{group_id:'group',name:'Team',member_npubs:['keeper','removed']}],
    editGroupId:'group',editGroupName:'Team',editGroupMembers:[{npub:'keeper'}],editGroupMemberQuery:'',
    pgWorkspaceMembers:[],showEditGroupModal:true,
    isProtectedWorkspaceGroup:()=>false,consumeGroupMemberQuery:(_q,members)=>({members}),
    rememberPeople:vi.fn(),scheduleGroupsRefresh:vi.fn(),schedulePgChannelAccessMaterializationRefresh:vi.fn(),resetEditGroupDraft:vi.fn(),
    ...overrides,
  };
}
beforeEach(()=>{vi.clearAllMocks();commands.create.mockResolvedValue({group:{id:'created'}});});
it('removing a resolved person issues the typed group command and closes the dialog',async()=>{
  const s=store({pgWorkspaceMembers:[{npub:'removed',actor_id:'removed-actor'}]});
  await channelsManagerMixin.saveGroupEdits.call(s);
  expect(commands.remove).toHaveBeenCalledWith(s,'workspace','group','removed-actor',expect.any(Object));
  expect(s.showEditGroupModal).toBe(false);
});
it('an unresolved removal retains selection and dialog with an actionable error',async()=>{
  const s=store();await channelsManagerMixin.saveGroupEdits.call(s);
  expect(commands.remove).not.toHaveBeenCalled();expect(s.error).toMatch(/Cannot remove removed.*Refresh.*selection is kept/);
  expect(s.showEditGroupModal).toBe(true);expect(s.resetEditGroupDraft).not.toHaveBeenCalled();
  expect(s.editGroupMembers).toEqual([{npub:'keeper'}]);expect(s.groupEditPending).toBe(false);
});
it('adding a person first establishes workspace membership and then group membership',async()=>{
  const s=store({groups:[{group_id:'group',name:'Team',member_npubs:['keeper']}],editGroupMembers:[{npub:'keeper'},{npub:'added',kind:'human'}]});
  await channelsManagerMixin.saveGroupEdits.call(s);
  expect(commands.member).toHaveBeenCalledWith(s,'workspace',expect.objectContaining({member_npub:'added',role:'member'}),expect.any(Object));
  expect(commands.add).toHaveBeenCalledWith(s,'workspace','group',{member_npub:'added'},expect.any(Object));
  expect(commands.member.mock.invocationCallOrder[0]).toBeLessThan(commands.add.mock.invocationCallOrder[0]);
});
it('creating an empty custom group issues the typed group route without key rotation',async()=>{
  const s=store({newGroupName:'Team',newGroupMemberQuery:'',newGroupMembers:[],groupCreatePending:false,showNewGroupModal:true,resetNewGroupDraft:vi.fn()});
  await channelsManagerMixin.createSharingGroup.call(s);
  expect(commands.create).toHaveBeenCalledWith(s,'workspace',{name:'Team',kind:'custom'},expect.any(Object));
  expect(commands.add).not.toHaveBeenCalled();expect(s.showNewGroupModal).toBe(false);
});
it('resolves removal from group actor projection before mixed additions', async () => {
  const s = store({groups:[{group_id:'group',name:'Team',member_npubs:['keeper','removed'],members:[{npub:'removed',actor_id:'removed-actor'}]}],editGroupMembers:[{npub:'keeper'},{npub:'added'}]});
  await channelsManagerMixin.saveGroupEdits.call(s);
  expect(commands.add).toHaveBeenCalledTimes(1);expect(commands.remove).toHaveBeenCalledWith(s,'workspace','group','removed-actor',expect.any(Object));
  expect(s.showEditGroupModal).toBe(false);
});
it('preflights all removals before mixed changes have side effects', async () => {
  const s = store({groups:[{group_id:'group',name:'Team',member_npubs:['keeper','resolved','removed']}],pgWorkspaceMembers:[{npub:'resolved',actor_id:'resolved-actor'}],editGroupMembers:[{npub:'keeper'},{npub:'added'}]});
  await channelsManagerMixin.saveGroupEdits.call(s);
  expect(commands.member).not.toHaveBeenCalled();expect(commands.add).not.toHaveBeenCalled();expect(commands.remove).not.toHaveBeenCalled();
  expect(s.rememberPeople).not.toHaveBeenCalled();expect(s.resetEditGroupDraft).not.toHaveBeenCalled();expect(s.showEditGroupModal).toBe(true);
  expect(s.editGroupMembers).toEqual([{npub:'keeper'},{npub:'added'}]);expect(s.error).toContain('removed');
});
it('retains draft when a resolved removal is denied by Tower', async () => {
  commands.remove.mockRejectedValueOnce(new Error('Group management permission denied'));
  const s = store({pgWorkspaceMembers:[{npub:'removed',actor_id:'removed-actor'}]});
  await channelsManagerMixin.saveGroupEdits.call(s);
  expect(s.error).toContain('permission denied');expect(s.showEditGroupModal).toBe(true);expect(s.resetEditGroupDraft).not.toHaveBeenCalled();
});
it('sends one typed removal for every resolved intended member', async () => {
  const s=store({groups:[{group_id:'group',name:'Team',member_npubs:['keeper','removed','second']}],pgWorkspaceMembers:[{npub:'removed',actor_id:'removed-actor'},{npub:'second',actor_id:'second-actor'}]});
  await channelsManagerMixin.saveGroupEdits.call(s);
  expect(commands.remove.mock.calls.map(call=>call[3])).toEqual(['removed-actor','second-actor']);
  expect(s.showEditGroupModal).toBe(false);expect(s.resetEditGroupDraft).toHaveBeenCalledTimes(1);
});
