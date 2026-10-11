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
it('diagnostic: an unresolved removal currently closes as success without issuing a command',async()=>{
  const s=store();await channelsManagerMixin.saveGroupEdits.call(s);
  expect(commands.remove).not.toHaveBeenCalled();expect(s.error).toBeNull();
  expect(s.showEditGroupModal).toBe(false);expect(s.resetEditGroupDraft).toHaveBeenCalled();
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
