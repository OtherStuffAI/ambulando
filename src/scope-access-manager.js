import { acquirePgScopeAccessLease, releasePgScopeAccessLease, resolvePgEditWorkspaceContext } from './pg-edit-session.js';
import { sortChannelsByScopePosition } from './channel-order.js';
import { putTowerPgScopeAccess } from './tower-command-intents.js';
export const SCOPE_ACCESS_ROLES = [
  {value:'context_editor',label:'Context editor',description:'Create, rename and move components, link and unlink references, and delete confirmed subtrees. No scope administration or additional linked-content access.'},
  {value:'scope_manager',label:'Scope manager',description:'Manage scope settings and access, and edit the context tree.'},
];
export const scopeAccessManagerMixin = {
  scopeAccessScope: null, scopeAccessWorkspaceId: '', scopeAccessData: null, scopeAccessBusy: false, scopeAccessError: '', scopeAccessNotice: '',
  scopeAccessPrincipalKind: 'human', scopeAccessPrincipalId: '', scopeAccessRole: 'context_editor',
  get scopeAccessVisible() { return Boolean(this.scopeAccessScope && this.scopeAccessWorkspaceId === resolvePgEditWorkspaceContext(this).workspaceId); },
  get scopeAccessRoles() { return SCOPE_ACCESS_ROLES; },
  get scopeAccessRoleDescription() { return SCOPE_ACCESS_ROLES.find(r=>r.value===this.scopeAccessRole)?.description || ''; },
  get scopeAccessPrincipalOptions() {
    const principals=this.scopeAccessData?.principals;
    if (principals) return this.scopeAccessPrincipalKind==='group' ? principals.groups : principals.actors.filter(m=>m.kind===this.scopeAccessPrincipalKind);
    if (this.scopeAccessPrincipalKind==='group') return (this.pgChannelGrantGroupOptions || []).map(g=>({id:g.groupId,label:g.label}));
    return (this.pgWorkspaceMembers || []).filter(m=>m.kind===this.scopeAccessPrincipalKind || (this.scopeAccessPrincipalKind==='human' && !m.kind))
      .map(m=>({id:m.actor_id || m.id,label: m.display_name || (/^(npub1|[0-9a-f]{8}-)/i.test(this.getPgWorkspaceMemberLabel?.(m) || '') ? '' : this.getPgWorkspaceMemberLabel?.(m)) || (m.kind==='agent'?'Unnamed agent':'Unnamed person')}));
  },
  scopeAccessRoleLabel(role) { return SCOPE_ACCESS_ROLES.find(r=>r.value===role)?.label || 'Custom access'; },
  scopeSetupChannels(scopeId) { return sortChannelsByScopePosition((this.channels || []).filter(c=>c.scope_id===scopeId && c.record_state!=='deleted')); },
  handleScopeModalKeydown(event) {
    if (event.key==='Escape') { event.preventDefault(); this.showNewScopeForm ? this.cancelNewScope() : this.cancelEditScope(); return; }
    if (event.key!=='Tab') return;
    const controls=[...event.currentTarget.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter(el=>!el.disabled && el.getClientRects().length);
    if (!controls.length) return;
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey && (document.activeElement===first || document.activeElement===event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if(!event.shiftKey && document.activeElement===last) { event.preventDefault(); first.focus(); }
  },
  async openScopeAccess(scope) {
    if (!this.isTowerPgMode) return;
    this.scopeModalOpener=globalThis.document?.activeElement;
    this.editingScopeId=scope.record_id; this.editingScopeTitle=scope.title || ''; this.editingScopeDescription=scope.description || ''; this.editingScopeAssignedGroupIds=this.getScopeShareGroupIds?.(scope) || []; this.editingScopeSaving=false; this.editingScopeError='';
    this.scopeAccessWorkspaceId=resolvePgEditWorkspaceContext(this).workspaceId; this.scopeAccessScope=scope; this.scopeAccessData=null; this.scopeAccessError=''; this.scopeAccessNotice=''; this.scopeAccessPrincipalId='';
    globalThis.requestAnimationFrame?.(()=>document.querySelector('.scope-edit-modal')?.focus());
    await this.refreshScopeAccess();
    if (this.scopeAccessData?.can_manage && !this.scopeAccessData.principals) {
      try { await Promise.all([this.refreshGroups?.({force:true,minIntervalMs:0}),this.refreshTowerPgWorkspaceMembers?.({force:true,limit:200})]); }
      catch { this.scopeAccessError='Access loaded, but people and groups could not be loaded. Refresh when your connection and signer are available.'; }
    }
  },
  closeScopeAccess() { if(this.scopeAccessBusy) return; this.scopeAccessScope=null; this.scopeAccessData=null; this.editingScopeId=null; this.scopeModalOpener?.focus?.(); },
  async refreshScopeAccess() {
    const scope=this.scopeAccessScope, context=resolvePgEditWorkspaceContext(this);
    if (!scope || !context.workspaceId) return;
    this.scopeAccessBusy=true; this.scopeAccessError='';
    try {
      const result=await this.getTowerSyncService().ensureLoaded('scope-access',scope.record_id,{force:true});
      if (this.scopeAccessScope?.record_id===scope.record_id && resolvePgEditWorkspaceContext(this).workspaceId===context.workspaceId) { this.scopeAccessData=result; this.scopeAccessScope.pg_can_manage=result.can_manage===true; const row=this.scopes?.find(s=>s.record_id===scope.record_id); if(row) row.pg_can_manage=result.can_manage===true; }
    } catch(e) { this.scopeAccessError=e.status===403?'You do not have permission to view this scope access.':e.status===404?'This scope is unavailable.':'Scope access could not be loaded. Check your connection and signer, then refresh.'; }
    finally {this.scopeAccessBusy=false;}
  },
  async saveScopeAccess(grant=null, revoke=false) {
    if (!this.scopeAccessVisible || !this.scopeAccessData?.can_manage || this.scopeAccessBusy) return;
    const scope=this.scopeAccessScope, context=resolvePgEditWorkspaceContext(this);
    const principalId=grant?.principal_id || this.scopeAccessPrincipalId;
    const principalType=grant?.principal_type || (this.scopeAccessPrincipalKind==='group'?'group':'actor');
    if (!principalId) return;
    this.scopeAccessBusy=true; this.scopeAccessError=''; this.scopeAccessNotice=''; let lease;
    try {
      lease=await acquirePgScopeAccessLease(context,scope.record_id);
      const result=await putTowerPgScopeAccess(this,context.workspaceId,scope.record_id,{principal_type:principalType,principal_id:principalId,
        ...(revoke?{revoke:true}:{role:this.scopeAccessRole}),expected_revision:this.scopeAccessData.revision,lease_token:lease.lease_token},context);
      if(this.scopeAccessScope?.record_id===scope.record_id && resolvePgEditWorkspaceContext(this).workspaceId===context.workspaceId){
        this.scopeAccessData=result; this.scopeAccessNotice=revoke?'Role grants revoked. Custom permissions and group-derived access remain.':'Access saved. Existing permissions were preserved.'; this.scopeAccessPrincipalId='';
      }
      await this.getTowerSyncService().ensureLoaded('scopes','',{force:true});
    } catch(e) { this.scopeAccessError=e.status===409?'Access changed or another editor holds the lease. Refresh and try again.':e.status===403?'Scope manager permission is required to change access.':'Access could not be saved. Check your connection and signer, then retry.'; }
    finally {
      if(lease?.id) await releasePgScopeAccessLease(context,lease).catch(()=>{});
      this.scopeAccessBusy=false;
    }
  },
};
