import { canonicalContextArtifact } from './context-artifact-link.js';
import { isContextAccessDenied } from './context-tree-errors.js';
import { contextSearchChoices } from './context-tree-layout.js';
import { liveQuery } from 'dexie';

export function contextParentChoices(components, id) {
  const excluded = new Set(id ? [id] : []), children = new Map();
  for (const row of components) {
    const siblings = children.get(row.parent_id) || [];
    siblings.push(row.id); children.set(row.parent_id, siblings);
  }
  const pending = id ? [id] : [];
  while (pending.length) for (const child of children.get(pending.pop()) || []) {
    if (!excluded.has(child)) { excluded.add(child); pending.push(child); }
  }
  return components.filter(row => !excluded.has(row.id)).sort((a,b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function contextEditError(error) {
  if (error?.status === 409) return 'Conflict: this context changed. Reload and reopen the edit before saving.';
  if (isContextAccessDenied(error)) return 'This action or target is unavailable for your access.';
  if (error?.status === 400) return 'Check the name, parent or reference and try again.';
  return 'The change could not be confirmed. Reload to check the current context before trying again.';
}

// Drafts are local view state. Only acknowledged service commands change records.
export function createContextTreeEditor({ getService, getDb, getStore, online = () => globalThis.navigator?.onLine !== false, observe = liveQuery }) {
  let epoch = 0, pickerRequest = 0, subscription, pending = false;
  const unsubscribe = () => { subscription?.unsubscribe(); subscription = null; };
  return {
    capabilities: {read:false,manage:false}, editing: null, busy: false, editError: '', deletePreview: null,
    dialogMode: '', parentSearch: '', parentOpen: false, parentUncommitted: false, parentIndex: 0, pickerIndex: 0,
    picker: false, pickerType: 'all', pickerSearch: '', pickerRows: [], pickerLoading: false,
    artifactOrigin: '', artifactProject: '', artifactName: '',
    get draftTitle() { return this.editing?.title || ''; },
    set draftTitle(value) { if (this.editing) this.editing.title = value; },
    get draftParent() { return this.editing?.parentId || ''; },
    set draftParent(value) { if (this.editing) this.editing.parentId = value; },
    get canManage() { return this.status === 'complete' && this.capabilities?.manage === true; },
    get dialogOpen() { return this.canManage && !!(this.editing || this.picker || this.dialogMode === 'delete'); },
    get parentResults() { const q=this.parentSearch.trim().toLowerCase(), top={id:'',title:'Top level',subtitle:'No parent'}; return [...(('Top level No parent'.toLowerCase().includes(q)) ? [top] : []), ...contextSearchChoices(this.components,q,new Set(this.parentChoices.map(row=>row.id)))].slice(0,40); },
    chooseParent(row) { if (!this.parentResults.some(p=>p.id===row.id)) return; this.draftParent=row.id; this.parentSearch=row.title; this.parentUncommitted=false; this.parentOpen=false; },
    searchParent(value) { this.parentUncommitted=true; this.parentSearch=value; this.parentOpen=true; this.parentIndex=0; },
    comboKey(event, kind) {
      const parent=kind==='parent', rows=parent ? this.parentResults : this.filteredPickerRows, prop=parent ? 'parentIndex' : 'pickerIndex';
      if (event.key==='Escape') { if (parent && this.parentOpen) { event.preventDefault(); event.stopPropagation(); this.parentOpen=false; this.parentUncommitted=false; this.parentSearch=this.components.find(r=>r.id===this.draftParent)?.title || 'Top level'; } return; }
      if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); if(parent)this.parentOpen=true; this[prop]=Math.max(0,Math.min(rows.length-1,this[prop]+(event.key==='ArrowDown'?1:-1))); }
      else if(event.key==='Enter' && (!parent || this.parentOpen)) { event.preventDefault(); if(rows[this[prop]]) parent ? this.chooseParent(rows[this[prop]]) : void this.attachRecord(rows[this[prop]]); }
      this.$nextTick?.(()=>this.$refs?.[parent?'parentResults':'referenceResults']?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'}));
    },
    dialogKey(event) {
      if(event.key!=='Tab')return;
      const el=event.currentTarget, items=[...el.querySelectorAll('button,input,select,[tabindex="0"]')].filter(item=>!item.disabled && item.getClientRects().length);
      const index=items.indexOf(el.ownerDocument.activeElement);
      if(items.length && (event.shiftKey && index<=0 || !event.shiftKey && (index===items.length-1 || index<0))) { event.preventDefault(); items[event.shiftKey?items.length-1:0].focus(); }
    },
    syncDialog(el) {
      if(this.dialogOpen && !el.open) { el.showModal(); this.$nextTick?.(()=>{ const target=el.querySelector(this.editing ? '[aria-label="Component name"]' : this.picker ? '[aria-label="Find reference"]' : '[aria-label="Confirm component deletion"] button'); target?.focus(); }); }
      else if(!this.dialogOpen && el.open) el.close();
    },
    get parentChoices() { return contextParentChoices(this.components, this.editing?.id); },
    get pickerChannels() { return (getStore()?.channels || []).filter(row => row.pg_workspace_id === this.workspaceId && row.record_state === 'active'); },
    get filteredPickerRows() { const query = this.pickerSearch.trim().toLowerCase(); return this.pickerRows.filter(row => (row.title + ' ' + (row.subtitle || '')).toLowerCase().includes(query)); },
    clearEditor() {
      epoch++; pickerRequest++; unsubscribe(); this.dialogMode = ''; this.parentOpen=false; this.parentUncommitted=false; this.editing = null; this.deletePreview = null; this.picker = false;
      this.busy = pending; this.editError = ''; this.pickerRows = []; this.pickerLoading = false;
    },
    cancelEdit() { if (!this.busy) this.clearEditor(); },
    startCreate(parentId = '') {
      if (!this.canManage || this.busy || parentId && !this.components.some(row => row.id === parentId)) return;
      this.clearEditor(); this.editing = {id:'',title:'',parentId}; this.parentSearch=this.components.find(r=>r.id===parentId)?.title || 'Top level';
    },
    startEdit() {
      if (!this.canManage || this.busy || !this.selected) return;
      const row = this.selected; this.clearEditor();
      this.editing = {id:row.id,title:row.title,parentId:row.parent_id || '',version:row.row_version}; this.parentSearch=this.components.find(r=>r.id===row.parent_id)?.title || 'Top level';
    },
    async runEdit(operation, input, onSuccess = () => this.clearEditor()) {
      if (!this.canManage || this.busy || pending) return false;
      if (!online()) { this.editError = 'You are offline. Reconnect and reload before editing. Nothing was queued.'; return false; }
      const ticket = epoch, service = getService();
      pending = true; this.busy = true; this.editError = '';
      try {
        if (!service || service.disposed) throw new Error('Unavailable');
        const result = await service.command(`context.${operation}`, {scopeId:this.scopeId,...input});
        if (ticket !== epoch) return false;
        if (!result || result.stale) throw new Error('Unconfirmed');
        onSuccess(result);
        return true;
      } catch (error) {
        if (ticket === epoch) this.editError = contextEditError(error);
        if (ticket === epoch && operation === 'delete' && error?.status === 409) {
          this.deletePreview = null;
          try { await this.refreshDeletePreview(input.componentId, true); }
          catch { /* The preview loader retains a neutral error. */ }
        }
        return false;
      } finally { pending = false; this.busy = false; }
    },
    async saveComponent() {
      const draft = this.editing;
      if (!draft || this.busy || !this.canManage) return;
      if(this.parentUncommitted) { this.editError='Choose a parent from the results, or press Escape to keep the current parent.'; return; }
      const title = draft.title.trim();
      if (!title || title.length > 256) { this.editError = 'Enter a name of 1–256 characters.'; return; }
      if (draft.parentId && !this.parentChoices.some(row => row.id === draft.parentId)) { this.editError = 'Choose an available parent.'; return; }
      await this.runEdit(draft.id ? 'update' : 'create', {componentId:draft.id || undefined,
        body:{title,parent_id:draft.parentId || null,...(draft.id ? {expected_row_version:draft.version} : {})}}, result => {
          this.clearEditor();
          const ticket = epoch, id = result.component?.id || draft.id;
          if (id) queueMicrotask(() => { if (ticket === epoch) this.revealCreated?.(id); });
        });
    },
    async previewDelete() {
      if (!this.canManage || this.busy || !this.selected) return;
      const id = this.selectedId; this.clearEditor(); this.dialogMode='delete'; this.busy = true;
      try { await this.refreshDeletePreview(id); }
      finally { this.busy = false; }
    },
    async refreshDeletePreview(id, changed = false) {
      const ticket = epoch;
      if (!online()) { this.editError = 'You are offline. Deletion is unavailable and nothing was queued.'; return; }
      try {
        const result = await getService().ensureLoaded('context-delete-preview', id, {scopeId:this.scopeId,force:true});
        if (ticket !== epoch || !this.canManage) return;
        const preview = result?.preview;
        if (preview?.component_id !== id || !preview.confirmation_token || !Number.isInteger(preview.component_count)
          || preview.component_count < 1 || preview.descendant_count !== preview.component_count - 1
          || !Number.isInteger(preview.reference_count) || preview.reference_count < 0) throw new Error('Invalid preview');
        this.deletePreview = {...preview,changed};
        if (changed) this.editError = 'Conflict: the subtree changed. Review the refreshed counts and confirm again.';
      } catch (error) { if (ticket === epoch) { this.deletePreview = null; this.editError = contextEditError(error); } }
    },
    async confirmDelete() {
      const preview = this.deletePreview;
      if (!preview) return;
      await this.runEdit('delete', {componentId:preview.component_id,body:{confirmation_token:preview.confirmation_token}});
    },
    async unlinkReference(row) {
      if (!this.directReferences.some(current => current.id === row.id && current.row_version === row.row_version)) return;
      await this.runEdit('unlink', {componentId:row.component_id,referenceId:row.id,body:{expected_row_version:row.row_version}}, () => { void this.loadReferences(); });
    },
    async startPicker() {
      if (!this.canManage || this.busy || !this.selected) return;
      this.clearEditor(); this.picker = true; this.pickerType = 'all'; this.pickerIndex=0; this.pickerSearch = '';
      const ticket = epoch;
      try { await getService().ensureLoaded('channels', '', {force:true}); } catch { if (ticket === epoch) this.editError = 'Channels could not be checked. Retry the picker.'; return; }
      if (ticket !== epoch) return;
      await this.loadPicker();
    },
    async loadPicker() {
      const ticket = ++pickerRequest, generation = epoch, db = getDb(), type = this.pickerType;
      unsubscribe(); this.pickerRows = []; this.editError = ''; this.pickerIndex=0;
      if (type === 'artifact' || !this.picker) { this.pickerLoading = false; return; }
      this.pickerLoading = true;
      try {
        const sources = this.pickerChannels.map(row=>({id:row.record_id,title:row.title || 'Channel',scope:false}));
        for(const row of (getStore()?.scopes || []).filter(row=>row.pg_workspace_id===this.workspaceId && row.record_state==='active')) sources.push({id:row.record_id,title:row.title || 'Scope',scope:true});
        const candidates = new Map(); let failed=0;
        // Reuse bounded ACL-checked service lists, never enumerate cached titles alone.
        for (const source of sources) {
          const families = source.scope ? ['scope-tasks'] : ['channel-documents','channel-tasks'];
          for(const family of families) {
            if(type==='task' && family==='channel-documents' || ['doc','file'].includes(type) && family!=='channel-documents') continue;
            if(ticket!==pickerRequest || generation!==epoch) return;
            try {
              const rows=await getService().ensureLoaded(family,source.id,{force:true});
              for(const row of Array.isArray(rows)?rows:[]) {
                const rowType=row.pg_record_type;
                if(row.pg_workspace_id!==this.workspaceId || row.record_state!=='active' || !['doc','file','task'].includes(rowType) || type!=='all' && rowType!==type) continue;
                candidates.set(row.record_id,{type:rowType,subtitle:source.title});
              }
            } catch { failed++; }
          }
        }
        if (ticket !== pickerRequest || generation !== epoch || !this.canManage || getDb() !== db) return;
        if(failed) this.editError='Some sources could not be checked. Results include only available records.';
        subscription = observe(async () => {
          const ids=[...candidates.keys()];
          const docs=await db.documents.bulkGet(ids.filter(id=>candidates.get(id).type!=='task'));
          const tasks=ids.some(id=>candidates.get(id).type==='task') ? await db.tasks.bulkGet(ids.filter(id=>candidates.get(id).type==='task')) : [];
          return [...docs,...tasks].filter(row=>row && row.pg_workspace_id===this.workspaceId && row.record_state==='active' && candidates.get(row.record_id)?.type===row.pg_record_type)
            .map(row=>({id:row.record_id,title:row.title || 'Untitled record',...candidates.get(row.record_id)}));
        }).subscribe({
          next: rows => { if(ticket===pickerRequest && generation===epoch && this.canManage) this.pickerRows=rows; },
          error: () => { if(ticket===pickerRequest) { this.pickerRows=[]; this.editError='References are unavailable. Reload the picker.'; } },
        });
      } catch { if(ticket===pickerRequest && generation===epoch) this.editError='References could not be checked. Retry the picker.'; }
      finally { if(ticket===pickerRequest && generation===epoch) this.pickerLoading=false; }
    },
    async attachArtifact() {
      if (!this.picker || this.pickerType !== 'artifact' || !this.selected) return;
      const target = canonicalContextArtifact({origin:this.artifactOrigin.trim(),project:this.artifactProject.trim(),artifact:this.artifactName.trim(),page:'index.html',version_policy:'latest'});
      if (!target) { this.editError = 'Enter an HTTP(S) origin and project/artifact names using letters, numbers, underscores or hyphens.'; return; }
      await this.runEdit('attach', {componentId:this.selectedId,body:{target_type:'artifact',target}});
    },
    async attachRecord(row) {
      const candidate=this.filteredPickerRows.find(candidate=>candidate.id===row.id);
      if (!this.picker || !candidate || !this.selected || this.pickerLoading) return;
      await this.runEdit('attach', {componentId:this.selectedId,body:{target_type:candidate.type,target:{record_id:row.id}}});
    },
  };
}
