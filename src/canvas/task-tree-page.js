import { ArtifactCatalog } from './artifact-picker.js';
import { TaskTreeRuntime } from './task-tree-runtime.js';
import { normalizeTaskTreeView } from './projection.js';
import { buildSectionUrl } from '../route-helpers.js';
import { buildPgChannelTaskBoardId } from '../pg-record-context.js';
import { formatStateLabel } from '../translators/tasks.js';

const keyOf=naplet=>naplet.layout?.task_tree?.instance_id||naplet.id;
const emptyGraph=()=>({nodes:[],edges:[],references:[],positions:{},bounded:false});

export function canvasTaskTreeStore() {
  let runtime,catalog,operations;
  return {
    treeDrafts:[],trees:{},taskDetailFrame:null,
    startTaskTrees(context,ports) {
      operations=ports;catalog=new ArtifactCatalog(context);
      runtime=new TaskTreeRuntime(context,{onState:(key,state)=>{
        const previous=this.trees[key];if(previous) {const first=!previous.graph?.nodes?.length && state.graph?.nodes?.length;const {error,...loaded}=state;Object.assign(previous,{...loaded,loadError:error,graph:state.graph||emptyGraph()});if(first)requestAnimationFrame(()=>{const naplet=this.naplets.find(row=>keyOf(row)===key),node=document.querySelector(`[data-task-tree="${key}"] .tree-scroll`),v=naplet?.layout.task_tree?.viewport;if(node&&v){node.scrollLeft=-v.x;node.scrollTop=-v.y;}});}
      }});
    },
    stopTaskTrees(){runtime?.close();runtime=null;},
    treeKey: keyOf,
    treeState(naplet){return this.trees[keyOf(naplet)]||{graph:emptyGraph(),scopes:[],channels:[],tasks:[]};},
    treeStatus:formatStateLabel,
    treeDestinationReady(naplet) {
      const state=this.treeState(naplet);
      return !naplet._treeDraft && Boolean(state.scopeId && state.channelId)
        && state.scopeId===naplet.content?.scope_id && state.channelId===naplet.source?.id
        && state.channelId===naplet.content?.channel_id;
    },
    treeBoardUrl(naplet) {
      if(!this.treeDestinationReady(naplet))return null;
      return buildSectionUrl({section:'tasks',scopeid:buildPgChannelTaskBoardId(naplet.source.id),params:{workspacekey:this.currentWorkspaceKey,revealnew:'1'}});
    },
    treeDestinationLabel(naplet) {
      const state=this.treeState(naplet);
      const scope=state.scopes.find(row=>row.id===naplet.content?.scope_id)?.title||'Scope';
      return `${scope} → ${naplet.content?.channel_title||'Channel'}`;
    },
    mergeTreeNaplets(rows) {
      const instances=new Set(rows.map(keyOf));
      this.treeDrafts=this.treeDrafts.filter(row=>!instances.has(keyOf(row)));
      return [...rows,...(this.canvas?.can_manage?this.treeDrafts:[])];
    },
    async syncTaskTrees(naplets) {
      if(!runtime)return;
      const seen=new Set();
      for(const naplet of naplets) {
        if(naplet.access!=='ready'||naplet.source?.type!=='task_tree')continue;
        const key=keyOf(naplet);seen.add(key);
        const binding=`${naplet.content?.scope_id||''}:${naplet.source.id||''}`;
        const prior=this.trees[key];
        if(prior && prior.binding!==binding) {
          Object.assign(prior,{binding,scopeId:naplet.content?.scope_id||'',channelId:naplet.source.id||'',channels:[],tasks:[],mode:'',anchor:null,lastCreated:null,request:null,entry:'',error:'Destination changed. Using the saved scope and channel.'});
          try{const result=await catalog.channels(prior.scopeId);if(prior.binding===binding)prior.channels=result.channels;}
          catch{prior.error='Destination choices unavailable. Retry by reopening this naplet.';}
        }
        if(!this.trees[key]) {
          this.trees={...this.trees,[key]:{binding,graph:emptyGraph(),scopes:[],channels:[],scopeId:naplet.content?.scope_id||'',channelId:naplet.source.id||'',tasks:[],query:'',entry:'',mode:'',anchor:null,lastCreated:null,busy:false,error:'',searchCursor:null,searchMore:false}};
          try {const scopes=await catalog.scopes();this.trees[key].scopes=scopes.scopes;this.trees[key].catalogPartial=scopes.truncated; if(naplet.content?.scope_id) {const channels=await catalog.channels(naplet.content.scope_id);this.trees[key].channels=channels.channels;this.trees[key].catalogPartial ||= channels.truncated;}}
          catch {this.trees[key].error='Destination choices unavailable. Retry by reopening this naplet.';}
        }
        if(!naplet._treeDraft) runtime.bind(key,naplet.layout.task_tree?.root_task_id,{collapsed:naplet.layout.task_tree?.collapsed||[],upstream:naplet.layout.task_tree?.upstream||[]});
      }
      for(const key of Object.keys(this.trees))if(!seen.has(key)){runtime.remove(key);delete this.trees[key];}
    },
    async placeTaskTree(point) {
      if(!this.canvas?.can_manage)return;
      const instance=crypto.randomUUID();
      const draft={id:instance,_treeDraft:true,access:'ready',source:{type:'task_tree',id:''},title:'Task Tree',content:{},layout:{x:Math.round(point.x),y:Math.round(point.y),width:Math.min(880,Math.max(300,this.stageRect().width-40)),height:Math.min(640,Math.max(400,this.stageRect().height-40)),z:this.highestZ()+1,task_tree:normalizeTaskTreeView({instance_id:instance})}};
      this.treeDrafts.push(draft);this.naplets=[...this.naplets,draft];this.tool='select';
      await this.syncTaskTrees(this.naplets);
    },
    async chooseTreeScope(naplet,scopeId) {
      const state=this.treeState(naplet);
      if(state.busy)return;
      if(state.entry && !window.confirm('Discard this unsaved title and change destination?'))return;
      state.entry='';state.mode='';state.request=null;state.lastCreated=null;state.scopeId=scopeId;state.channelId='';state.channels=[];state.tasks=[];state.busy=true;state.error='';
      try {const result=await catalog.channels(scopeId);if(state.scopeId===scopeId){state.channels=result.channels;state.catalogPartial=result.truncated;}}
      catch {state.error='Channels unavailable. Select the scope to retry.';}
      finally{state.busy=false;}
    },
    async chooseTreeChannel(naplet,channelId) {
      const state=this.treeState(naplet);if(state.busy||!state.channels.some(row=>row.id===channelId))return;
      if(state.entry && !window.confirm('Discard this unsaved title and change destination?'))return;
      state.busy=true;state.error='';state.channelId=channelId;
      const layout={...naplet.layout,task_tree:normalizeTaskTreeView({instance_id:keyOf(naplet)})};
      try {
        if(naplet._treeDraft) {
          // Reconcile an uncertain binding POST by its stable view identity.
          await operations.refresh();
          if(this.treeDrafts.some(row=>row.id===naplet.id))await operations.add({source:{type:'task_tree',id:channelId},title:'Task Tree',layout});
        } else await operations.save(naplet.id,{layout,tree_channel_id:channelId});
        state.channelId=channelId;state.entry='';state.mode='';state.tasks=[];state.request=null;state.lastCreated=null;
      }catch(error){state.error=error.message||'Destination was not saved. Retry the same channel.';}
      finally{state.busy=false;}
    },
    openTreeSearch(naplet){const state=this.treeState(naplet);if(state.busy||!this.treeDestinationReady(naplet))return;if(state.entry&&!window.confirm('Discard this unsaved title and choose another task?'))return;state.entry='';state.request=null;state.mode='search';return this.searchTreeTasks(naplet);},
    async searchTreeTasks(naplet,{more=false}={}) {
      const state=this.treeState(naplet);if(state.busy||!this.treeDestinationReady(naplet))return;
      state.busy=true;state.error='';
      try{const page=await runtime.search(naplet.source.id,{cursor:more?state.searchCursor:null});state.tasks=[...new Map([...(more?state.tasks:[]),...page.tasks].map(row=>[row.id,row])).values()];state.searchCursor=page.next_cursor;state.searchMore=page.has_more;}
      catch{state.error='Tasks unavailable. Search again to retry.';state.tasks=[];}
      finally{state.busy=false;}
    },
    treeSearchResults(naplet){const state=this.treeState(naplet);const query=String(state.query||'').toLowerCase();return state.tasks.filter(row=>!query||row.title.toLowerCase().includes(query));},
    async saveTreeView(naplet,patch) {
      const tree=normalizeTaskTreeView({...naplet.layout.task_tree,...patch,instance_id:keyOf(naplet)});
      if(!this.canvas?.can_manage){naplet.layout={...naplet.layout,task_tree:tree};runtime.bind(keyOf(naplet),tree.root_task_id,{collapsed:tree.collapsed,upstream:tree.upstream});return;}
      await operations.save(naplet.id,{layout:{...naplet.layout,task_tree:tree}});
    },
    async selectTreeRoot(naplet,task) {
      const state=this.treeState(naplet);if(state.busy)return;
      state.busy=true;state.error='';
      try{await this.saveTreeView(naplet,{root_task_id:task.id,collapsed:[],upstream:[],viewport:{x:0,y:0,scale:1}});state.mode='';state.tasks=[];}
      catch(error){state.error=error.message||'Root selection was not saved.';}
      finally{state.busy=false;}
    },
    beginTreeEntry(naplet,mode,task=null) {
      const state=this.treeState(naplet);if(state.busy||!this.treeDestinationReady(naplet)||!naplet.content?.can_create)return;
      if(state.entry && !window.confirm('Discard this unsaved title and change insertion point?'))return;
      Object.assign(state,{mode,anchor:task,entry:'',request:null,lastCreated:null,error:''});
      queueMicrotask(()=>document.querySelector(`[data-tree-entry="${keyOf(naplet)}"]`)?.focus());
    },
    treeEntryLabel(naplet) {const s=this.treeState(naplet);return s.mode==='child'?`Adding child to ${s.anchor?.title}`:s.mode==='successor'?`Adding next task after ${s.anchor?.title}`:'New base task';},
    cancelTreeEntry(naplet) {const s=this.treeState(naplet);if(!s.busy){s.mode='';s.entry='';s.request=null;}},
    async submitTreeEntry(naplet) {
      const state=this.treeState(naplet),title=String(state.entry||'').trim();
      if(state.busy||!title||!state.mode||!this.treeDestinationReady(naplet)||!naplet.content?.can_create)return;
      state.busy=true;state.error='';
      const metadata={parent_task_id:state.mode==='child'?state.anchor.record_id:state.mode==='successor'?state.anchor.parent_task_id||null:null,predecessor_task_ids:state.mode==='successor'?[state.anchor.record_id]:[]};
      // On an uncertain response retry the exact captured request. The draft
      // remains editable; changing it requires explicit resolution of that retry.
      if(state.request && state.request.title!==title){state.error='Retry the previous title first to resolve its creation, then add this title.';state.busy=false;return;}
      state.request ||= {title,state:'new',metadata,client_request_id:crypto.randomUUID()};
      const destination={channelId:naplet.source.id,scopeId:state.scopeId};
      let confirmed=false;
      try {
        const task=await runtime.create(destination.channelId,state.request,{scopeId:destination.scopeId});
        confirmed=true;
        state.lastCreated={...task,record_id:task.id,parent_task_id:task.metadata?.parent_task_id};
        const current=this.naplets?.find(row=>keyOf(row)===keyOf(naplet))||naplet;
        if(current.source?.id!==destination.channelId || current.content?.scope_id!==destination.scopeId) {
          state.request=null;state.entry='';state.mode='';
          state.error='Task saved in the original destination. The tree destination changed while saving.';
          return;
        }
        if(state.mode==='root') {await this.saveTreeView(naplet,{root_task_id:task.id,collapsed:[],upstream:[],viewport:{x:0,y:0,scale:1}});state.mode='';}
        else await runtime.refresh(keyOf(naplet));
        state.entry='';state.request=null;
      }catch(error){state.error=confirmed?'Task saved, but the tree view was not saved. Retry this title to reconnect the same task.':error.message||'Task was not confirmed. Retry this title.';if(!confirmed && [400,403,409].includes(Number(error.status)))state.request=null;}
      finally{state.busy=false;queueMicrotask(()=>document.querySelector(`[data-tree-entry="${keyOf(naplet)}"]`)?.focus());}
    },
    continueTreeChain(naplet){const s=this.treeState(naplet);if(!s.lastCreated||s.busy)return;const task=s.lastCreated;this.beginTreeEntry(naplet,'successor',task);},
    async toggleTreeBranch(naplet,task){const collapsed=new Set(naplet.layout.task_tree?.collapsed||[]);collapsed.has(task.record_id)?collapsed.delete(task.record_id):collapsed.add(task.record_id);try{await this.saveTreeView(naplet,{collapsed:[...collapsed]});}catch(error){this.treeState(naplet).error=error.message;}},
    async expandTreeReference(naplet,reference){try{await this.saveTreeView(naplet,{upstream:[...new Set([...(naplet.layout.task_tree?.upstream||[]),reference.targetId])]});}catch(error){this.treeState(naplet).error=error.message;}},
    treeChannelLabel(naplet,task){return task.pg_channel_id===naplet.source.id?naplet.content.channel_title:this.treeState(naplet).channels.find(row=>row.id===task.pg_channel_id)?.title||task.pg_channel_title||'Other channel';},
    treeNodeStyle(naplet,task){const p=this.treeState(naplet).graph.positions[task.record_id]||{x:0,y:0};return {left:`${20+p.x*300}px`,top:`${20+p.y*180}px`};},
    treeEdgePath(naplet,edge){const p=this.treeState(naplet).graph.positions,a=p[edge.from],b=p[edge.to];if(!a||!b)return '';return edge.kind==='child'?`M ${140+a.x*300} ${150+a.y*180} L ${140+b.x*300} ${20+b.y*180}`:`M ${260+a.x*300} ${75+a.y*180} L ${20+b.x*300} ${75+b.y*180}`;},
    treeWorldStyle(naplet){const view=naplet.layout.task_tree?.viewport||{x:0,y:0,scale:1};const positions=Object.values(this.treeState(naplet).graph.positions);return {width:`${Math.max(800,...positions.map(p=>p.x*300+300))}px`,height:`${Math.max(500,...positions.map(p=>p.y*180+180))}px`,transform:`scale(${view.scale})`,transformOrigin:'0 0'};},
    startTreeScroll(event){if(event.pointerType!=='touch'||event.target.closest('button,input,select'))return;const node=event.currentTarget;node._treePan={id:event.pointerId,x:event.clientX,y:event.clientY,left:node.scrollLeft,top:node.scrollTop};node.setPointerCapture(event.pointerId);event.preventDefault();},
    moveTreeScroll(event){const node=event.currentTarget,p=node._treePan;if(!p||p.id!==event.pointerId)return;const scale=node.getBoundingClientRect().width/node.offsetWidth||1;node.scrollLeft=p.left+(p.x-event.clientX)/scale;node.scrollTop=p.top+(p.y-event.clientY)/scale;event.preventDefault();},
    endTreeScroll(event){event.currentTarget._treePan=null;},
    async saveTreeScroll(naplet,node){if(naplet._treeDraft||!this.canvas?.can_manage)return;const v=naplet.layout.task_tree?.viewport||{scale:1};try{await this.saveTreeView(naplet,{viewport:{...v,x:-node.scrollLeft,y:-node.scrollTop}});}catch(error){this.treeState(naplet).error=error.message;}},
    async fitTaskTree(naplet) {
      const scroll=document.querySelector(`[data-task-tree="${keyOf(naplet)}"] .tree-scroll`);
      if(scroll){scroll.scrollLeft=0;scroll.scrollTop=0;}
      const positions=Object.values(this.treeState(naplet).graph.positions);
      const width=Math.max(300,...positions.map(p=>p.x*300+300));
      const height=Math.max(180,...positions.map(p=>p.y*180+180));
      const ideal=Math.min(1,Math.max(1,(scroll?.clientWidth||naplet.layout.width)-20)/width,Math.max(1,(scroll?.clientHeight||naplet.layout.height-230)-20)/height);
      this.treeState(naplet).fitLimited=ideal<0.85;
      try{await this.saveTreeView(naplet,{viewport:{x:0,y:0,scale:Math.max(0.85,ideal)}});}
      catch(error){this.treeState(naplet).error=error.message;}
    },
    async zoomTaskTree(naplet,factor){const v=naplet.layout.task_tree?.viewport||{x:0,y:0,scale:1};try{await this.saveTreeView(naplet,{viewport:{...v,scale:v.scale*factor}});}catch(error){this.treeState(naplet).error=error.message;}},
    loadMoreTree(naplet){return runtime.advance(keyOf(naplet),{more:true});},
    refreshTaskTree(naplet){return runtime.refresh(keyOf(naplet));},
    removeTreeDraft(naplet){this.treeDrafts=this.treeDrafts.filter(row=>row.id!==naplet.id);this.naplets=this.naplets.filter(row=>row.id!==naplet.id);runtime?.remove(keyOf(naplet));},
    openTreeTask(naplet,task){this.taskDetailFrame={id:task.record_id,key:crypto.randomUUID(),url:''};this.taskDetailFrame.url=this.makeChatUrl(this.taskDetailFrame.key,{canvastask:task.record_id});queueMicrotask(()=>document.querySelector('.canvas-task-detail-dialog')?.showModal());},
    closeTreeTask(){document.querySelector('.canvas-task-detail-dialog')?.close();this.taskDetailFrame=null;for(const naplet of this.naplets)if(naplet.source?.type==='task_tree'&&!naplet._treeDraft)void this.refreshTaskTree(naplet);},
  };
}
