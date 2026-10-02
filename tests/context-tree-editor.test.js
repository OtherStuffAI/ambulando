import {describe,it,expect,vi} from 'vitest';
import {createContextTreeEditor,contextParentChoices} from '../src/context-tree-editor.js';
import {canonicalContextArtifact,contextArtifactLatestUrl} from '../src/context-artifact-link.js';
const rows = [{id:'root',title:'Root',parent_id:null,row_version:1},{id:'child',title:'Child',parent_id:'root',row_version:2},{id:'deep',title:'Deep',parent_id:'child',row_version:1},{id:'other',title:'Other',parent_id:null,row_version:1}];
const preview = {component_id:'root',component_count:3,descendant_count:2,reference_count:4,confirmation_token:'one'};
function setup(manage=true) {
  let online=true,next;
  const service={command:vi.fn(async()=>({component:{id:'new'}})),ensureLoaded:vi.fn(async()=>({preview}))};
  const db={documents:{bulkGet:vi.fn(async()=>[{record_id:'doc',title:'Current',pg_record_type:'doc',pg_workspace_id:'workspace',record_state:'active'}])}};
  const view={status:'complete',components:structuredClone(rows),workspaceId:'workspace',scopeId:'scope',selectedId:'root',loadReferences:vi.fn(),get selected(){return this.components.find(r=>r.id===this.selectedId)},get directReferences(){return [{id:'ref',component_id:'root',row_version:3}]}};
  Object.defineProperties(view,Object.getOwnPropertyDescriptors(createContextTreeEditor({getService:()=>service,getDb:()=>db,getStore:()=>({channels:[{record_id:'channel',title:'Channel',pg_workspace_id:'workspace',record_state:'active'}]}),online:()=>online,observe:fn=>({subscribe(observer){next=async()=>observer.next(await fn());void next();return {unsubscribe:vi.fn()}}})})));
  view.capabilities={read:true,manage};
  return {view,service,db,setOffline:()=>online=false,emitPicker:()=>next()};
}
describe('Context editing service workflow',()=>{
  it('root and child creation send explicit parent pointers without optimistic rows',async()=>{
    const {view,service}=setup();view.startCreate();view.editing.title=' Root two ';await view.saveComponent();
    expect(service.command).toHaveBeenLastCalledWith('context.create',{scopeId:'scope',componentId:undefined,body:{title:'Root two',parent_id:null}});
    view.startCreate('child');view.editing.title='New child';await view.saveComponent();
    expect(service.command.mock.calls[1][1].body.parent_id).toBe('child');expect(view.components).toEqual(rows);
  });
  it('parent typeahead uses paths, commits only choices, and keeps selection on cancel',async()=>{
    const {view,service}=setup();view.startCreate('child');expect(view.draftParent).toBe('child');expect(view.parentSearch).toBe('Child');
    view.searchParent('Other');expect(view.draftParent).toBe('child');view.draftTitle='New';await view.saveComponent();expect(service.command).not.toHaveBeenCalled();
    view.chooseParent(view.parentResults[0]);expect(view.draftParent).toBe('other');await view.saveComponent();expect(service.command.mock.calls[0][1].body.parent_id).toBe('other');
    view.startEdit();view.searchParent('Deep');expect(view.parentResults).toEqual([]);view.cancelEdit();expect(view.selectedId).toBe('root');
  });
  it('rename/reparent sends only the moved root and original row version',async()=>{
    const {view,service}=setup();view.startEdit();view.editing.title='Renamed';view.editing.parentId='other';await view.saveComponent();
    expect(service.command).toHaveBeenCalledWith('context.update',{scopeId:'scope',componentId:'root',body:{title:'Renamed',parent_id:'other',expected_row_version:1}});
    view.startEdit();view.editing.parentId='';await view.saveComponent();expect(service.command.mock.calls[1][1].body.parent_id).toBeNull();
  });
  it('excludes self and every descendant and prevents invalid parent submissions',async()=>{
    expect(contextParentChoices(rows,'root').map(r=>r.id)).toEqual(['other']);
    const {view,service}=setup();view.startEdit();view.editing.parentId='deep';await view.saveComponent();expect(service.command).not.toHaveBeenCalled();
  });
  it('every mutation and preview is gated by authoritative manage capability',async()=>{
    const {view,service}=setup(false);view.startCreate();view.startEdit();await view.previewDelete();await view.startPicker();
    await view.runEdit('create',{body:{title:'bypass'}});await view.unlinkReference(view.directReferences[0]);
    expect(view.editing).toBeNull();expect(service.command).not.toHaveBeenCalled();expect(service.ensureLoaded).not.toHaveBeenCalled();
  });
  it('duplicate submission is disabled until command settles, including lifecycle reset',async()=>{
    const {view,service}=setup();let resolve;service.command.mockImplementation(()=>new Promise(r=>resolve=r));view.startCreate();view.editing.title='Once';
    const pending=view.saveComponent();expect(view.busy).toBe(true);await view.saveComponent();view.clearEditor();view.startCreate();await view.runEdit('create',{});
    expect(service.command).toHaveBeenCalledTimes(1);resolve({component:{id:'one'}});await pending;expect(view.busy).toBe(false);
  });
  it('stale row versions show neutral conflict without phantom local success',async()=>{
    const {view,service}=setup();service.command.mockRejectedValue({status:409,message:'PRIVATE'});view.startEdit();view.editing.title='Draft';await view.saveComponent();
    expect(view.editError).toContain('Conflict');expect(view.editError).not.toContain('PRIVATE');expect(view.editing.title).toBe('Draft');expect(view.components).toEqual(rows);
  });
  it('cancelled delete sends no destructive command; confirmed delete sends exact preview token',async()=>{
    const {view,service}=setup();await view.previewDelete();expect(view.deletePreview).toMatchObject(preview);view.cancelEdit();await view.confirmDelete();expect(service.command).not.toHaveBeenCalled();
    await view.previewDelete();await view.confirmDelete();expect(service.command).toHaveBeenCalledWith('context.delete',{scopeId:'scope',componentId:'root',body:{confirmation_token:'one'}});
  });
  it('changed subtree refresh requires a new explicit confirmation, even if counts stay the same',async()=>{
    const {view,service}=setup();await view.previewDelete();service.command.mockRejectedValueOnce({status:409});service.ensureLoaded.mockResolvedValue({preview:{...preview,confirmation_token:'two'}});
    await view.confirmDelete();expect(service.command).toHaveBeenCalledTimes(1);expect(view.deletePreview.confirmation_token).toBe('two');expect(view.editError).toContain('confirm again');
    await view.confirmDelete();expect(service.command.mock.calls[1][1].body.confirmation_token).toBe('two');
  });
  it('invalid refreshed preview cannot be confirmed',async()=>{
    const {view,service}=setup();service.ensureLoaded.mockResolvedValue({preview:{...preview,component_count:8}});await view.previewDelete();await view.confirmDelete();expect(service.command).not.toHaveBeenCalled();expect(view.deletePreview).toBeNull();
  });
  it('offline preview and deletion never queue or send commands',async()=>{
    const h=setup();await h.view.previewDelete();h.setOffline();await h.view.confirmDelete();expect(h.service.command).not.toHaveBeenCalled();expect(h.view.editError).toContain('Nothing was queued');
    h.view.cancelEdit();await h.view.previewDelete();expect(h.service.ensureLoaded).toHaveBeenCalledTimes(1);
  });
  it('unlink uses its independent version and never mutates linked content',async()=>{
    const {view,service,db}=setup();await view.unlinkReference(view.directReferences[0]);expect(service.command).toHaveBeenCalledWith('context.unlink',{scopeId:'scope',componentId:'root',referenceId:'ref',body:{expected_row_version:3}});
    expect(db.documents.bulkGet).not.toHaveBeenCalled();expect(view.loadReferences).toHaveBeenCalled();
  });
  it('failed writes and stale acknowledgements retain draft without reporting success',async()=>{
    const {view,service}=setup();view.startCreate();view.editing.title='Draft';service.command.mockResolvedValue({stale:true});await view.saveComponent();expect(view.editing.title).toBe('Draft');expect(view.editError).toContain('could not be confirmed');
  });
  it('picker renders current liveQuery titles only for fresh accessible same-workspace browsing IDs',async()=>{
    const h=setup();h.service.ensureLoaded.mockResolvedValue([{record_id:'doc',pg_workspace_id:'workspace',pg_record_type:'doc',record_state:'active'},{record_id:'foreign',pg_workspace_id:'other',pg_record_type:'doc',record_state:'active'}]);
    await h.view.startPicker();await h.emitPicker();expect(h.db.documents.bulkGet).toHaveBeenCalledWith(['doc']);expect(h.view.pickerRows).toEqual([{id:'doc',title:'Current',type:'doc',subtitle:'Channel'}]);
    h.db.documents.bulkGet.mockResolvedValue([{record_id:'doc',title:'Updated',pg_record_type:'doc',pg_workspace_id:'workspace',record_state:'active'}]);await h.emitPicker();expect(h.view.pickerRows[0].title).toBe('Updated');
    await h.view.attachRecord(h.view.pickerRows[0]);expect(h.service.command.mock.calls[0][1].body).toEqual({target_type:'doc',target:{record_id:'doc'}});
  });
  it('denied picker clears results and cannot link arbitrary cached identifiers',async()=>{
    const {view,service}=setup();service.ensureLoaded.mockRejectedValue({status:403,message:'secret'});await view.startPicker();await view.attachRecord({id:'private'});expect(view.pickerRows).toEqual([]);expect(service.command).not.toHaveBeenCalled();expect(view.editError).not.toContain('secret');
  });
  it('typed artifact attach retains latest and canonical origin, rejecting executable/path descriptors',async()=>{
    const {view,service}=setup();view.picker=true;view.pickerType='artifact';view.artifactOrigin='https://Artifacts.example:443';view.artifactProject='Suite';view.artifactName='Design';await view.attachArtifact();
    const target=service.command.mock.calls[0][1].body.target;expect(target.origin).toBe('https://artifacts.example');expect(contextArtifactLatestUrl(target)).toBe('https://artifacts.example/artifacts/Suite/Design/');
    for(const origin of ['javascript:alert(1)','https://user:pass@example.com','https://example.com/private','https://example.com/?token=x'])expect(canonicalContextArtifact({...target,origin})).toBeNull();
  });
});
