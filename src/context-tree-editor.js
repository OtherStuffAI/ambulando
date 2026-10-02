import { canonicalContextArtifact } from './context-artifact-link.js';
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
  if ([403,404].includes(error?.status)) return 'This action or target is unavailable for your access.';
  if (error?.status === 400) return 'Check the name, parent or reference and try again.';
  return 'The change could not be confirmed. Reload to check the current context before trying again.';
}

// Drafts are local view state. Only acknowledged service commands change records.
export function createContextTreeEditor({ getService, getDb, getStore, online = () => globalThis.navigator?.onLine !== false, observe = liveQuery }) {
  let epoch = 0, pickerRequest = 0, subscription, pending = false;
  const unsubscribe = () => { subscription?.unsubscribe(); subscription = null; };
  return {
    capabilities: {read:false,manage:false}, editing: null, busy: false, editError: '', deletePreview: null,
    picker: false, pickerType: 'doc', pickerChannel: '', pickerSearch: '', pickerRows: [], pickerLoading: false,
    artifactOrigin: '', artifactProject: '', artifactName: '',
    get draftTitle() { return this.editing?.title || ''; },
    set draftTitle(value) { if (this.editing) this.editing.title = value; },
    get draftParent() { return this.editing?.parentId || ''; },
    set draftParent(value) { if (this.editing) this.editing.parentId = value; },
    get canManage() { return this.status === 'complete' && this.capabilities?.manage === true; },
    get parentChoices() { return contextParentChoices(this.components, this.editing?.id); },
    get pickerChannels() { return (getStore()?.channels || []).filter(row => row.pg_workspace_id === this.workspaceId && row.record_state === 'active'); },
    get pickerScopes() { return this.pickerType === 'task' ? (getStore()?.scopes || []).filter(row => row.pg_workspace_id === this.workspaceId && row.record_state === 'active') : []; },
    get filteredPickerRows() { const query = this.pickerSearch.trim().toLowerCase(); return this.pickerRows.filter(row => row.title.toLowerCase().includes(query)); },
    clearEditor() {
      epoch++; pickerRequest++; unsubscribe(); this.editing = null; this.deletePreview = null; this.picker = false;
      this.busy = pending; this.editError = ''; this.pickerRows = []; this.pickerLoading = false;
    },
    cancelEdit() { if (!this.busy) this.clearEditor(); },
    startCreate(parentId = '') {
      if (!this.canManage || this.busy || parentId && !this.components.some(row => row.id === parentId)) return;
      this.clearEditor(); this.editing = {id:'',title:'',parentId};
    },
    startEdit() {
      if (!this.canManage || this.busy || !this.selected) return;
      const row = this.selected; this.clearEditor();
      this.editing = {id:row.id,title:row.title,parentId:row.parent_id || '',version:row.row_version};
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
      const id = this.selectedId; this.clearEditor(); this.busy = true;
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
      this.clearEditor(); this.picker = true; this.pickerType = 'doc'; this.pickerSearch = '';
      this.pickerChannel = this.pickerChannels[0]?.record_id || '';
      const ticket = epoch;
      try { await getService().ensureLoaded('channels', '', {force:true}); } catch { if (ticket === epoch) this.editError = 'Channels could not be checked. Retry the picker.'; return; }
      if (ticket !== epoch) return;
      this.pickerChannel = this.pickerChannels[0]?.record_id || '';
      await this.loadPicker();
    },
    async loadPicker() {
      const ticket = ++pickerRequest, generation = epoch, db = getDb(), type = this.pickerType, channel = this.pickerChannel;
      unsubscribe(); this.pickerRows = []; this.editError = '';
      if (type === 'artifact' || !channel || !this.picker) { this.pickerLoading = false; return; }
      this.pickerLoading = true;
      try {
        const scope = type === 'task' && channel.startsWith('scope:');
        const rows = await getService().ensureLoaded(scope ? 'scope-tasks' : type === 'task' ? 'channel-tasks' : 'channel-documents', scope ? channel.slice(6) : channel, {force:true});
        if (ticket !== pickerRequest || generation !== epoch || !this.canManage || getDb() !== db) return;
        const ids = new Set((Array.isArray(rows) ? rows : []).filter(row => row.pg_workspace_id === this.workspaceId && row.record_state === 'active'
          && row.pg_record_type === (type === 'doc' ? 'doc' : type)).map(row => row.record_id));
        const table = type === 'task' ? db.tasks : db.documents;
        subscription = observe(async () => (await table.bulkGet([...ids])).filter(row => row && row.pg_workspace_id === this.workspaceId
          && row.record_state === 'active' && row.pg_record_type === type).map(row => ({id:row.record_id,title:row.title || 'Untitled record'}))).subscribe({
          next: candidates => { if (ticket === pickerRequest && generation === epoch && this.canManage) this.pickerRows = candidates; },
          error: () => { if (ticket === pickerRequest) { this.pickerRows = []; this.editError = 'References are unavailable. Reload the picker.'; } },
        });
      } catch { if (ticket === pickerRequest && generation === epoch) this.editError = 'References are unavailable for this channel. Choose another or retry.'; }
      finally { if (ticket === pickerRequest && generation === epoch) this.pickerLoading = false; }
    },
    async attachArtifact() {
      if (!this.picker || this.pickerType !== 'artifact' || !this.selected) return;
      const target = canonicalContextArtifact({origin:this.artifactOrigin.trim(),project:this.artifactProject.trim(),artifact:this.artifactName.trim(),page:'index.html',version_policy:'latest'});
      if (!target) { this.editError = 'Enter an HTTP(S) origin and project/artifact names using letters, numbers, underscores or hyphens.'; return; }
      await this.runEdit('attach', {componentId:this.selectedId,body:{target_type:'artifact',target}});
    },
    async attachRecord(row) {
      if (!this.picker || !this.filteredPickerRows.some(candidate => candidate.id === row.id) || !this.selected) return;
      await this.runEdit('attach', {componentId:this.selectedId,body:{target_type:this.pickerType,target:{record_id:row.id}}});
    },
  };
}
