import { expect, it } from 'vitest';
import { canvasTaskTreeStore } from '../src/canvas/task-tree-page.js';

const scope='40000000-0000-4000-8000-000000000001';
const channel='50000000-0000-4000-8000-000000000001';
function fixture() {
  const store=canvasTaskTreeStore();
  const naplet={id:'view',source:{type:'task_tree',id:channel},content:{scope_id:scope,channel_id:channel,channel_title:'Delivery',can_create:true},layout:{}};
  store.currentWorkspaceKey='workspace';
  store.trees.view={scopeId:scope,channelId:channel,scopes:[{id:scope,title:'Work'}],entry:'',busy:false};
  return {store,naplet,state:store.trees.view};
}
it('requires displayed, persisted and authorized destination identities to agree',()=>{
  const {store,naplet,state}=fixture();
  expect(store.treeDestinationReady(naplet)).toBe(true);
  for(const patch of [{scopeId:'other'},{channelId:''},{channelId:'other'}]) {
    Object.assign(state,{scopeId:scope,channelId:channel},patch);
    expect(store.treeDestinationReady(naplet)).toBe(false);
    expect(store.treeBoardUrl(naplet)).toBe(null);
    store.beginTreeEntry(naplet,'root');expect(state.mode).toBeUndefined();
  }
  Object.assign(state,{scopeId:scope,channelId:channel});naplet.content.channel_id='other';
  expect(store.treeDestinationReady(naplet)).toBe(false);
});
it('does not submit a retained draft or search through an old binding after a scope change',async()=>{
  const {store,naplet,state}=fixture();
  Object.assign(state,{scopeId:'other',mode:'root',entry:'Must stay here'});
  await store.submitTreeEntry(naplet);await store.openTreeSearch(naplet);
  expect(state.entry).toBe('Must stay here');expect(state.busy).toBe(false);expect(state.mode).toBe('root');
});
it('opens the ordinary channel Tasks board with a navigation-only request to reveal new tasks',()=>{
  const {store,naplet}=fixture();
  const url=new URL(store.treeBoardUrl(naplet),'http://localhost');
  expect(url.pathname).toBe('/tasks');expect(url.searchParams.get('scopeid')).toBe(`__pg_channel__:${channel}`);
  expect(url.searchParams.get('revealnew')).toBe('1');expect(url.searchParams.get('workspacekey')).toBe('workspace');
  expect(store.treeDestinationLabel(naplet)).toBe('Work → Delivery');
});
