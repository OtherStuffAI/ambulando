import { describe, it, expect } from 'vitest';
import '../public/napplets/workspace-report/v1/model.js';
const model = globalThis.WorkspaceReportModel;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function reportFixture() {
  return {format:'workspace-report-v1',workspace_id:id(1),range:'30d',from:'2026-10-23T12:00:00.000Z',to:'2026-11-22T12:00:00.000Z',as_of:'2026-11-22T12:00:00.000Z',timezone:'UTC',complete:true,channel_policy:'active-project-channels',channels:[{channel_id:id(3),scope_id:id(2),name:'Planning',scope_name:'Project',messages:8,conversations:3},{channel_id:id(4),scope_id:id(2),name:'Delivery',scope_name:'Project',messages:4,conversations:2}],ranking:{total_channels:2,returned_channels:2,has_more:false,other_messages:0,other_conversations:0},coverage:{tasks_channels:2,documents_channels:2,files_channels:2},activity:{messages:12,conversations:5},inventory:{channels:2,conversations:7,tasks:{total:10,open:6,completed:4,archived:0,by_state:{new:1,ready:1,in_progress:2,review:1,done:4,backlog:0,blocked:1,archive:0,archived:0}},documents:3,files:2}};
}
describe('Workspace Report aggregate model',()=>{
  it('distinguishes message, conversation and current task inventory counts',()=>{const v=model.validate(reportFixture());expect(v.activity).toEqual({messages:12,conversations:5});expect(v.inventory.tasks.open).toBe(6);expect(model.ranking(v).map(c=>c.name)).toEqual(['Planning','Delivery']);});
  it('sorts ties by channel ID without mutating input',()=>{const v=reportFixture();v.channels[1].messages=8;expect(model.ranking(v).map(c=>c.channel_id)).toEqual([id(3),id(4)]);expect(v.channels[0].name).toBe('Planning');});
  it.each([
    v=>{v.complete=false;},v=>{v.partial=true;},v=>{v.channels.push(v.channels[0]);},v=>{v.activity.messages=11;},v=>{v.activity.conversations=4;},v=>{v.inventory.channels=3;},v=>{v.inventory.tasks.total=9;},v=>{v.inventory.tasks.by_state.unknown=1;},v=>{v.inventory.tasks.completed=5;},v=>{v.inventory.tasks.open=5;},v=>{v.inventory.files=-1;},v=>{v.inventory.documents=Number.MAX_SAFE_INTEGER+1;},v=>{v.from='2026-10-24T12:00:00.000Z';},v=>{v.to='2026-11-23T12:00:00.000Z';},v=>{v.as_of='2026-02-30T12:00:00.000Z';},v=>{v.timezone='Australia/Perth';},v=>{v.channel_policy='all';},v=>{v.channels[0].body='private content';},v=>{v.channels[0].conversations=5;},v=>{v.channels[0].messages=1.5;},v=>{v.channels[0].name='x'.repeat(301);}
  ])('rejects partial, malformed, inconsistent or undeclared data %#',mutate=>{const v=reportFixture();mutate(v);expect(()=>model.validate(v)).toThrow();});
  it('accepts complete zero and all-time snapshots',()=>{const v=reportFixture();v.range='all';v.from=null;v.channels=[];v.activity={messages:0,conversations:0};v.ranking={total_channels:0,returned_channels:0,has_more:false,other_messages:0,other_conversations:0};v.coverage={tasks_channels:0,documents_channels:0,files_channels:0};v.inventory={channels:0,conversations:0,tasks:{total:0,open:0,completed:0,archived:0,by_state:Object.fromEntries(model.states.map(s=>[s,0]))},documents:0,files:0};expect(model.validate(v).inventory.channels).toBe(0);});
});

it('checks explicit ranking remainder, task archive sums and coverage independently',()=>{
 const v=reportFixture();v.ranking={total_channels:4,returned_channels:2,has_more:true,other_messages:2,other_conversations:1};v.inventory.channels=4;v.activity={messages:14,conversations:6};v.inventory.tasks.by_state.archived=2;v.inventory.tasks.archived=2;v.inventory.tasks.total=12;
 expect(model.validate(v).ranking.other_messages).toBe(2);
 for(const mutate of [x=>{x.ranking.other_messages=1;},x=>{x.ranking.has_more=false;},x=>{x.coverage.tasks_channels=5;},x=>{x.inventory.tasks.archived=0;},x=>{x.channels.reverse();}]){const bad=structuredClone(v);mutate(bad);expect(()=>model.validate(bad)).toThrow();}
});
