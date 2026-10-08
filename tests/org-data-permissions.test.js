import { expect, it, vi } from 'vitest';
import { orgDataPermissionsMixin, replaceEditorPermissions } from '../src/org-data/permissions.js';
import { orgDataContext, orgDataLifecycle } from '../src/org-data/projection.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { readOrgDataPermissions, prepareOrgDataCommand } from '../src/org-data/tower.js';
import { orgDataRequest } from '../src/api.js';
vi.mock('../src/api.js', () => ({ orgDataRequest: vi.fn() }));
function store() {
 const s={...orgDataPermissionsMixin,canAdminWorkspace:true,session:{npub:'manager'},workspaceDbKey:'db',currentWorkspace:{workspaceId:'workspace',workspaceOwnerNpub:'owner',appNpub:'app',directHttpsUrl:'http://localhost:3100'}};
 Object.defineProperty(s,'orgDataContextKey',{get:()=>orgDataLifecycle(orgDataContext(s))});
 Object.defineProperty(s,'orgDataPermissionRows',{get:()=>s.orgDataPermissionsContext===s.orgDataContextKey?s.orgDataPermissionMembers:[]});s._towerSyncService=new TowerSyncService({workspaceKey:'test',families:{'org-data-permissions':{load:(_id,options)=>readOrgDataPermissions(s,options)}},ports:{prepareCommand:(_name,input)=>prepareOrgDataCommand(s,input)}});s.getTowerSyncService=()=>s._towerSyncService;return s;
}
it('replaces only narrow direct grants, preserving publication/install grants',()=>{
 expect(replaceEditorPermissions(['napplet.publish','org_data.read'],['org_data.write'])).toEqual(['napplet.publish','org_data.write']);
});
it('bootstraps a manager without data grants and saves expected direct permissions',async()=>{
 const s=store();orgDataRequest.mockResolvedValueOnce({members:[{id:'actor',permissions:['napplet.install']}]});await s.loadOrgDataPermissions();
 const member=s.orgDataPermissionRows[0];member.selected=['org_data.read'];orgDataRequest.mockResolvedValueOnce({permissions:['napplet.install','org_data.read']});await s.saveOrgDataPermissions(member);
 expect(orgDataRequest).toHaveBeenLastCalledWith('workspace','permissions',expect.objectContaining({method:'POST',body:{actor_id:'actor',expected_permissions:['napplet.install'],permissions:['napplet.install','org_data.read']}}));
});
it('reports CAS drift and server denial without silently retrying or self-granting',async()=>{
 const s=store();orgDataRequest.mockResolvedValueOnce({members:[{id:'actor',permissions:[]}]});await s.loadOrgDataPermissions();const member=s.orgDataPermissionRows[0];
 orgDataRequest.mockRejectedValueOnce({status:409});await s.saveOrgDataPermissions(member);expect(s.orgDataPermissionsError).toContain('Reload');expect(member.permissions).toEqual([]);
 orgDataRequest.mockRejectedValueOnce(new Error('self_permission_escalation'));await s.saveOrgDataPermissions(member);expect(s.orgDataPermissionsError).toBe('self_permission_escalation');
});
it('ignores a late permission response after switching workspace',async()=>{
 const s=store();let release;orgDataRequest.mockImplementationOnce(()=>new Promise(r=>release=r));const pending=s.loadOrgDataPermissions();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));s.currentWorkspace={...s.currentWorkspace,workspaceId:'foreign'};release({members:[{id:'old',permissions:[]}]});await pending;expect(s.orgDataPermissionRows).toEqual([]);
});
