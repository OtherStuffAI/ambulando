import {it,expect,vi} from 'vitest';
vi.mock('../src/api.js',()=>({}));
vi.mock('../src/canvas/projection.js',async original=>({...await original(),canvasContext:store=>store.context}));
import { queryWorkspaceReport } from '../src/napplets/workspace-report-query.js';
const workspace='00000000-0000-4000-8000-000000000001';
const c={baseUrl:'https://tower.example',workspaceId:workspace,viewer:'alice',appNpub:'app',tower:'tower',service:'service'};
function snapshot(){return {identity:{workspace_id:workspace,app_npub:'app',tower_service_npub:'tower',workspace_service_npub:'service'},format:'workspace-report-v1',workspace_id:workspace,range:'all',from:null,to:'2026-11-22T12:00:00.000Z',as_of:'2026-11-22T12:00:00.000Z',timezone:'UTC',complete:true,channel_policy:'active-project-channels',channels:[],activity:{messages:0,conversations:0},inventory:{channels:0,conversations:0,tasks:{total:0,open:0,completed:0,archived:0,by_state:{new:0,ready:0,in_progress:0,review:0,done:0,backlog:0,blocked:0,archive:0,archived:0}},documents:0,files:0},ranking:{total_channels:0,returned_channels:0,has_more:false,other_messages:0,other_conversations:0},coverage:{tasks_channels:0,documents_channels:0,files_channels:0}};}
it('returns only a complete validated ephemeral snapshot from the fixed service read',async()=>{const read=vi.fn(async()=>snapshot());const value=await queryWorkspaceReport({context:c},'all',{}, {read});expect(value.inventory.channels).toBe(0);expect(value.identity).toBeUndefined();expect(read.mock.calls[0].slice(0,2)).toEqual([workspace,'all']);});
it('refuses identity mismatch, incomplete data and missing top10 rows',async()=>{for(const mutate of [v=>{v.identity.workspace_service_npub='other';},v=>{v.complete=false;},v=>{v.ranking.total_channels=1;v.ranking.has_more=true;v.inventory.channels=1;}]){const v=snapshot();mutate(v);await expect(queryWorkspaceReport({context:c},'all',{}, {read:async()=>v})).rejects.toThrow();}});
it('rejects late delivery after viewer context changes and honors both abort owners',async()=>{let finish;const store={context:c};const promise=queryWorkspaceReport(store,'all',{}, {read:()=>new Promise(r=>{finish=r;})});store.context={...c,viewer:'bob'};finish(snapshot());await expect(promise).rejects.toThrow('context changed');for(const serviceAbort of [false,true]){const abort=new AbortController();abort.abort();const read=vi.fn();const s={context:c,...(serviceAbort?{_towerSyncService:{readAbortController:abort,assertActive(){}}}:{})};await expect(queryWorkspaceReport(s,'all',serviceAbort?{}:{signal:abort.signal},{read})).rejects.toThrow();expect(read).not.toHaveBeenCalled();}});
it('opts in only for storage owner and refuses missing/late/mismatched extension',async()=>{
 const fixture=(await import('./fixtures/napplets/workspace-report-storage-v1.json')).default;
 const value={...structuredClone(fixture.value),identity:snapshot().identity};
 const read=vi.fn(async()=>value);
 expect((await queryWorkspaceReport({context:c},'all',{storage:true},{read})).storage).toEqual(fixture.value.storage);
 expect(read.mock.calls[0][2].storage).toBe(true);
 await expect(queryWorkspaceReport({context:c},'all',{}, {read})).rejects.toThrow();
 delete value.storage;await expect(queryWorkspaceReport({context:c},'all',{storage:true},{read})).rejects.toThrow();
 read.mockRejectedValue(Object.assign(Error('denied'),{status:403}));await expect(queryWorkspaceReport({context:c},'all',{storage:true},{read})).rejects.toMatchObject({status:403});
});
