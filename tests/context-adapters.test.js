import { beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceDb } from '../src/db.js';
import { mapContextRow } from '../src/context-cache.js';
import { loadTowerPgContext, loadTowerPgContextReferences } from '../src/pg-read-hydrator.js';
import { writeTowerPgContext } from '../src/pg-write-adapter.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import fixture from './fixtures/context-record-delta-v1.json';
import { requestTowerPgContext } from '../src/api.js';
vi.mock('../src/api.js', async importOriginal => ({ ...await importOriginal(), requestTowerPgContext: vi.fn() }));
const workspaceId=fixture.components[0].workspace_id, scopeId=fixture.components[0].scope_id;
let db,service,store;
beforeEach(async()=>{
  vi.clearAllMocks();db=openWorkspaceDb('context-adapter-tests');await db.open();await Promise.all(db.tables.map(t=>t.clear()));
  service=new TowerSyncService({workspaceKey:'test'});
  store={currentWorkspace:{workspaceId,workspaceOwnerNpub:'owner',pgBackendMode:true},session:{npub:'viewer'},getTowerSyncService:()=>service,
    runTowerPgWorkspaceSync:vi.fn(async()=>db.context_coverage.put({scope_id:scopeId,workspace_id:workspaceId,status:'complete'}))};
});
it('loader distinguishes loading from complete empty and carries capabilities after worker recovery',async()=>{
  requestTowerPgContext.mockImplementation(async()=>{expect((await db.context_coverage.get(scopeId)).status).toBe('loading');return {capabilities:{read:true,manage:false}};});
  expect(await loadTowerPgContext(store,scopeId)).toMatchObject({status:'complete',capabilities:{manage:false}});
  expect(store.runTowerPgWorkspaceSync).toHaveBeenCalledOnce();
});
it('permission denial clears cached rows; disposed late reads cannot write to another workspace',async()=>{
  await db.context_components.put(mapContextRow(fixture.components[0]));
  requestTowerPgContext.mockRejectedValueOnce(Object.assign(Error('denied'),{status:404,code:'context_not_found'}));
  await expect(loadTowerPgContext(store,scopeId)).rejects.toThrow('denied');expect(await db.context_components.count()).toBe(0);
  requestTowerPgContext.mockImplementationOnce(async()=>{service.dispose();return {capabilities:{read:true}};});
  await expect(loadTowerPgContext(store,scopeId)).rejects.toThrow();expect(store.runTowerPgWorkspaceSync).not.toHaveBeenCalled();
});
it('an unregistered route sets error coverage without declaring access revoked',async()=>{
  await db.context_components.put(mapContextRow(fixture.components[0]));
  requestTowerPgContext.mockRejectedValueOnce(Object.assign(Error('404 Not Found'),{status:404}));
  await expect(loadTowerPgContext(store,scopeId)).rejects.toThrow('404 Not Found');
  expect((await db.context_coverage.get(scopeId)).status).toBe('error');
  expect(await db.context_components.count()).toBe(1);
  expect((await db.context_coverage.get(scopeId)).capabilities).toBeUndefined();
});
it('target resolution follows all ACL-checked pages and matches cache row versions',async()=>{
  const row=fixture.references[0];await db.context_references.put(mapContextRow(row));
  requestTowerPgContext.mockResolvedValueOnce({references:[{...row,resolution:{status:'available',record_id:row.target.record_id,title:'Checked title'}}],next_cursor:'next'})
    .mockResolvedValueOnce({references:[],next_cursor:null});
  await loadTowerPgContextReferences(store,scopeId,row.component_id);
  expect(requestTowerPgContext).toHaveBeenCalledTimes(2);expect((await db.context_reference_resolutions.get(row.id)).resolution.title).toBe('Checked title');
  requestTowerPgContext.mockResolvedValueOnce({references:[{...row,row_version:2,resolution:{status:'available',title:'Unmatched'}}],next_cursor:null});
  await loadTowerPgContextReferences(store,scopeId,row.component_id);expect(await db.context_reference_resolutions.count()).toBe(0);
});
it('unlink passes signed DELETE JSON CAS and delete passes explicit preview token',async()=>{
  requestTowerPgContext.mockResolvedValue({});
  await writeTowerPgContext(store,'unlink',{scopeId,componentId:'component',referenceId:'reference',body:{expected_row_version:7}});
  expect(requestTowerPgContext).toHaveBeenLastCalledWith(workspaceId,scopeId,'/component/references/reference',expect.objectContaining({method:'DELETE',body:{expected_row_version:7}}));
  const descriptor=prepareTowerWorkspaceCommand(store,'context.delete',{scopeId,componentId:'component',body:{confirmation_token:'confirmed'}});
  const result=await descriptor.execute();await descriptor.reconcile(result);
  expect(requestTowerPgContext).toHaveBeenLastCalledWith(workspaceId,scopeId,'/component/delete',expect.objectContaining({method:'POST',body:{confirmation_token:'confirmed'}}));
  expect(store.runTowerPgWorkspaceSync).toHaveBeenCalledOnce();
  expect(store.runTowerPgWorkspaceSync).toHaveBeenCalledWith({force:true,afterCurrent:true});
  expect(await db.pending_writes.count()).toBe(0);
});
