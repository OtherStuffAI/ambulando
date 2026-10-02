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
  scopeAccessQuery: '', scopeAccessPickerOpen: false, scopeAccessPickerIndex: 0,
  scopeAccessPrincipalLabel(principal) {
    const clean=value=>{const name=String(value || '').trim();return !name || /^(npub1|[0-9a-f]{8}-|[0-9a-f]{64}$|Unknown|Unnamed)/i.test(name) ? '' : name;};
    const member=(this.pgWorkspaceMembers || []).find(m=>(m.actor_id || m.id)===(principal.id || principal.actor_id || principal.principal_id));
    const npub=principal.npub || member?.npub;
    const canonical=clean(principal.display_name || principal.label) || clean(member?.display_name);
    if(canonical) return canonical;
    const profile=npub ? clean(this.getSenderName?.(npub)) : '';
    return profile || (principal.kind==='group' || principal.principal_type==='group' ? 'Unnamed group' : principal.kind==='agent' ? 'Unnamed agent' : 'Unnamed person');
  },
  get scopeAccessCandidates() {
    const data=this.scopeAccessData?.principals;
    const actors=data?.actors || (this.pgWorkspaceMembers || []).map(m=>({...m,id:m.actor_id || m.id,kind:m.kind || 'human'}));
    const groups=data?.groups || (this.pgChannelGrantGroupOptions || []).map(g=>({id:g.groupId,label:g.label}));
    const entries=[...actors.filter(m=>['human','agent'].includes(m.kind)).map(m=>({...m,type:'actor'})),...groups.map(g=>({...g,kind:'group',type:'group'}))];
    const seen=new Set();
    const named=entries.filter(p=>p.id && !seen.has(p.type+':'+p.id) && seen.add(p.type+':'+p.id)).map(p=>({...p,label:this.scopeAccessPrincipalLabel(p)}));
    return named.map(p=>{const same=named.filter(n=>n.kind===p.kind && n.label===p.label);const kind=p.kind==='group'?'Group':p.kind==='agent'?'Agent':'Person';return {...p,subtitle:kind+(same.length>1?' · Same name '+(same.findIndex(n=>n.id===p.id)+1)+' of '+same.length:'')};});
  },
  get scopeAccessSearchResults() {
    const query=this.scopeAccessQuery.trim().toLowerCase();
    return this.scopeAccessCandidates.filter(p=>!query || (p.label+' '+p.subtitle).toLowerCase().includes(query)).slice(0,30);
  },
  get scopeAccessSelectedPrincipal() { return this.scopeAccessCandidates.find(p=>p.id===this.scopeAccessPrincipalId && (p.kind===this.scopeAccessPrincipalKind)) || null; },
  get scopeAccessAlreadyGranted() {
    const p=this.scopeAccessSelectedPrincipal;if(!p)return false;
    const row=this.scopeAccessData?.grants?.find(g=>g.principal_id===p.id && g.principal_type===p.type);
    return Boolean(row && (row.role==='scope_manager' || row.permissions?.includes(this.scopeAccessRole==='scope_manager'?'scope.manage':'context.edit')));
  },
  changeScopeAccessQuery(value) { this.scopeAccessQuery=value; this.scopeAccessPrincipalId=''; this.scopeAccessPickerIndex=0; this.scopeAccessPickerOpen=true; },
  selectScopeAccessPrincipal(option) {
    const p=this.scopeAccessCandidates.find(p=>p.id===option.id && p.type===option.type);if(!p)return;
    this.scopeAccessPrincipalId=p.id; this.scopeAccessPrincipalKind=p.kind; this.scopeAccessQuery=p.label; this.scopeAccessPickerOpen=false;
  },
  handleScopeAccessPickerKeydown(event) {
    if(event.key==='Escape' && this.scopeAccessPickerOpen) {event.preventDefault();event.stopPropagation();this.scopeAccessPickerOpen=false;return;}
    if(event.key==='ArrowDown' || event.key==='ArrowUp') { event.preventDefault();this.scopeAccessPickerOpen=true;const count=this.scopeAccessSearchResults.length;this.scopeAccessPickerIndex=count?(this.scopeAccessPickerIndex+(event.key==='ArrowDown'?1:-1)+count)%count:0;return; }
    if(event.key==='Enter' && this.scopeAccessPickerOpen) {event.preventDefault();event.stopPropagation();const p=this.scopeAccessSearchResults[this.scopeAccessPickerIndex];if(p)this.selectScopeAccessPrincipal(p);}
  },
  hydrateScopeAccessNames() { for(const p of this.scopeAccessData?.principals?.actors || []) if(p.npub && (!p.label || /^Unnamed/i.test(p.label))) this.resolveChatProfile?.(p.npub); },
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
    this.scopeAccessWorkspaceId=resolvePgEditWorkspaceContext(this).workspaceId; this.scopeAccessScope=scope; this.scopeAccessData=null; this.scopeAccessError=''; this.scopeAccessNotice=''; this.scopeAccessPrincipalId=''; this.scopeAccessQuery=''; this.scopeAccessPickerOpen=false;
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
      if (this.scopeAccessScope?.record_id===scope.record_id && resolvePgEditWorkspaceContext(this).workspaceId===context.workspaceId) { this.scopeAccessData=result; this.hydrateScopeAccessNames(); this.scopeAccessScope.pg_can_manage=result.can_manage===true; const row=this.scopes?.find(s=>s.record_id===scope.record_id); if(row) row.pg_can_manage=result.can_manage===true; }
    } catch(e) { this.scopeAccessError=e.status===403?'You do not have permission to view this scope access.':e.status===404?'This scope is unavailable.':'Scope access could not be loaded. Check your connection and signer, then refresh.'; }
    finally {this.scopeAccessBusy=false;}
  },
  async saveScopeAccess(grant=null, revoke=false) {
    if (!this.scopeAccessVisible || !this.scopeAccessData?.can_manage || this.scopeAccessBusy) return;
    const scope=this.scopeAccessScope, context=resolvePgEditWorkspaceContext(this);
    const selected=this.scopeAccessSelectedPrincipal;
    if(!grant && (!selected || this.scopeAccessAlreadyGranted)) return;
    const principalId=grant?.principal_id || selected?.id;
    const principalType=grant?.principal_type || selected?.type;
    if (!principalId) return;
    this.scopeAccessBusy=true; this.scopeAccessError=''; this.scopeAccessNotice=''; let lease;
    try {
      lease=await acquirePgScopeAccessLease(context,scope.record_id);
      const result=await putTowerPgScopeAccess(this,context.workspaceId,scope.record_id,{principal_type:principalType,principal_id:principalId,
        ...(revoke?{revoke:true}:{role:this.scopeAccessRole}),expected_revision:this.scopeAccessData.revision,lease_token:lease.lease_token},context);
      if(this.scopeAccessScope?.record_id===scope.record_id && resolvePgEditWorkspaceContext(this).workspaceId===context.workspaceId){
        this.scopeAccessData=result; this.scopeAccessNotice=revoke?'Role grants revoked. Custom permissions and group-derived access remain.':'Access saved. Existing permissions were preserved.'; this.scopeAccessPrincipalId=''; this.scopeAccessQuery=''; this.scopeAccessPickerOpen=false; this.hydrateScopeAccessNames();
      }
      await this.getTowerSyncService().ensureLoaded('scopes','',{force:true});
    } catch(e) { this.scopeAccessError=e.status===409?'Access changed or another editor holds the lease. Refresh and try again.':e.status===403?'Scope manager permission is required to change access.':'Access could not be saved. Check your connection and signer, then retry.'; }
    finally {
      if(lease?.id) await releasePgScopeAccessLease(context,lease).catch(()=>{});
      this.scopeAccessBusy=false;
    }
  },
};
