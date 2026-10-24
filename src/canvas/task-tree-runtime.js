import { liveQuery } from 'dexie';
import { getWorkspaceDb, replaceTasksForOwner } from '../db.js';
import { mapPgTaskToLocal } from '../pg-read-hydrator.js';
import { getTowerPgTaskRelationships, getTowerPgChannelTasks, createTowerPgChannelTask } from '../api.js';
import { assertIdentity } from './projection.js';

const defaults={getTowerPgTaskRelationships,getTowerPgChannelTasks,createTowerPgChannelTask};
const denied = error => [401,403,404].includes(Number(error?.status));

/** The canvas's sole task network/materialization owner. View data is canonical
 * task rows, observed through Dexie; graph traversal/layout runs in a worker.
 * One shared refresh subscription discovers remote creations and ACL changes;
 * Dexie changes from other views are observed without waiting for that refresh.
 */
export class TaskTreeRuntime {
  constructor(context,{api=defaults,onState=()=>{},projector=null,interval=10000,isVisible=()=>true}={}) {
    this.context=Object.freeze({...context});this.api=api;this.onState=onState;this.views=new Map();this.closed=false;this.isVisible=isVisible;this.reads=new Map();this.projectionGeneration=0;
    this.db=getWorkspaceDb();
    this.worker=projector;
    this.onProjection=({data})=>{
      const view=this.views.get(data.key);
      if (!view || this.closed || data.generation!==view.generation) return;
      view.graph=data.graph;this.emit(view);
    };
    this.refreshVisible=()=>{ if(!globalThis.document?.hidden) for(const view of this.views.values()) if(this.isVisible(view.key)) void this.refresh(view.key); };
    this.timer=setInterval(this.refreshVisible,interval);
    this.visibilityChanged=()=>{for(const view of this.views.values()) {if(globalThis.document?.hidden)this.suspend(view.key);else this.resume(view.key);}};
    globalThis.document?.addEventListener('visibilitychange',this.visibilityChanged);
  }
  projector() {
    this.worker ||= new Worker(new URL('./task-tree-worker.js',import.meta.url),{type:'module'});
    this.worker.onmessage=this.onProjection;
    return this.worker;
  }
  options(extra={}) {return {baseUrl:this.context.baseUrl,appNpub:this.context.appNpub,...extra};}
  emit(view) {if(!this.closed) this.onState(view.key,{graph:view.graph,loading:view.loading,error:view.error,partial:view.queue.length>0,unavailable:view.unavailable,loaded:view.ids.size,renderLimit:view.limit});}
  verify(page){assertIdentity({...page,workspace_id:page.identity?.workspace_id},this.context);}
  async materialize(rows,isCurrent=()=>true) {
    if(this.closed||!isCurrent()) return;
    for(const row of rows) if(row.workspace_id!==this.context.workspaceId) throw new Error('Invalid task workspace response');
    if(this.closed||!isCurrent())return;
    await replaceTasksForOwner(this.context.workspaceOwnerNpub,rows.map(row=>({...mapPgTaskToLocal(row,{workspaceOwnerNpub:this.context.workspaceOwnerNpub}),...(row.channel_title?{pg_channel_title:row.channel_title}:{})})),{isCurrent:()=>!this.closed&&isCurrent()});
  }
  bind(key,root,options={}) {
    options={...options,collapsed:[...(options.collapsed||[])],upstream:[...(options.upstream||[])]};
    let view=this.views.get(key);
    if(view && view.root===root) {const changed=JSON.stringify(view.options)!==JSON.stringify(options);view.options=options;for(const id of options.upstream||[])if(!view.ids.has(id)&&!view.queue.some(item=>item.id===id))view.queue.push({id,cursor:null,contextOnly:true});if(changed)this.project(view);if(view.queue.some(item=>item.contextOnly))void this.advance(key);return;}
    this.remove(key);
    view={key,root,options,ids:new Set(),queue:root?[{id:root,cursor:null},...(options.upstream||[]).map(id=>({id,cursor:null,contextOnly:true}))]:[],visited:new Set(),generation:0,graph:null,loading:false,error:'',unavailable:false,limit:100,subscription:null};
    this.views.set(key,view);if(this.isVisible(key)&&!globalThis.document?.hidden)void this.advance(key);
  }
  resume(key) {
    const view=this.views.get(key);
    if(!view || !this.isVisible(key) || globalThis.document?.hidden)return;
    this.observe(view);
    if(view.loading)view.resumePending=true;
    else void this.refresh(key);
  }
  suspend(key) {const view=this.views.get(key);if(view){view.generation=++this.projectionGeneration;view.subscription?.unsubscribe();view.subscription=null;}}
  readRelationships(id,options) {
    // Only concurrent identical authorized reads share a promise. Never retain
    // a completed response across polling/resume or an access change.
    const key=JSON.stringify([id,options.cursor,options.limit]);
    let pending=this.reads.get(key);
    if(!pending){
      pending=Promise.resolve().then(()=>this.api.getTowerPgTaskRelationships(this.context.workspaceId,id,this.options(options)))
        .finally(()=>{if(this.reads.get(key)===pending)this.reads.delete(key);});
      this.reads.set(key,pending);
    }
    return pending;
  }
  remove(key) {const view=this.views.get(key);if(view){view.subscription?.unsubscribe();view.generation++;this.views.delete(key);}}
  observe(view) {
    view.subscription?.unsubscribe();
    const ids=[...view.ids];
    if(ids.length && this.isVisible(view.key) && !globalThis.document?.hidden) view.subscription=liveQuery(()=>this.db.tasks.bulkGet(ids)).subscribe({next:rows=>this.project(view,rows.filter(Boolean)),error:()=>{view.error='Task updates unavailable. Refresh to retry.';this.emit(view);}});
  }
  async project(view,rows=null) {
    if(!this.isVisible(view.key) || globalThis.document?.hidden)return;
    const generation=++this.projectionGeneration;view.generation=generation;
    rows ||= (await this.db.tasks.bulkGet([...view.ids])).filter(Boolean);
    if(this.closed || this.views.get(view.key)!==view || generation!==view.generation) return;
    this.projector().postMessage({key:view.key,generation,rows,root:view.root,options:{...view.options,limit:view.limit,previous:view.graph?.positions||{}}});
  }
  async advance(key,{more=false}={}) {
    const view=this.views.get(key);if(!view || view.loading || this.closed || !view.root) return;
    if(more) view.limit=Math.min(2000,view.limit+100);
    view.loading=true;view.error='';this.emit(view);
    let requests=0;
    const scan=view.scan||view;
    try {
      while(!globalThis.document?.hidden && this.isVisible(key) && scan.queue.length && requests<Math.max(100,view.limit) && scan.ids.size<view.limit) {
        const item=scan.queue[0];requests++;
        let page;
        try {page=await this.readRelationships(item.id,{cursor:item.cursor,limit:Math.min(100,Math.max(1,view.limit-scan.ids.size-(scan.ids.has(item.id)?0:1)))});}
        catch(error){if(!denied(error)||item.id===view.root)throw error;scan.ids.delete(item.id);scan.queue.shift();scan.visited.add(item.id);view.unavailable=true;this.observe(view);continue;}
        this.verify(page);
        if(page.has_more && page.next_cursor===item.cursor)throw new Error('Repeated relationship cursor');
        if(this.closed || this.views.get(key)!==view) return;
        if(page.task?.id!==item.id || !Array.isArray(page.tasks) || page.has_more && !page.next_cursor) throw new Error('Incomplete task relationship response');
        const rows=item.contextOnly?[page.task]:[page.task,...page.tasks];
        await this.materialize(rows,()=>this.views.get(key)===view);
        if(this.closed || this.views.get(key)!==view) return;
        for(const row of rows) scan.ids.add(row.id);
        view.unavailable ||= page.unavailable===true;
        if(page.has_more && !item.contextOnly) item.cursor=page.next_cursor;
        else {scan.queue.shift();scan.visited.add(item.id);}
        for(const row of item.contextOnly?[]:page.tasks) if(!scan.visited.has(row.id) && !scan.queue.some(item=>item.id===row.id)) scan.queue.push({id:row.id,cursor:null});
        if(!view.scan)this.observe(view);
      }
    } catch(error) {
      if(denied(error)) {
        // Never keep cached titles after a failed authorization refresh.
        view.generation++;scan.ids.clear();view.ids.clear();view.graph=null;view.subscription?.unsubscribe();view.unavailable=true;
        view.error='Task relationship unavailable. Access may have changed.';
      } else view.error='Tree partially loaded. Retry loading to continue.';
    } finally {
      if(view.scan===scan){
        if(!view.error){view.ids=scan.ids;view.queue=scan.queue;view.visited=scan.visited;}
        view.scan=null;this.observe(view);
      }
      view.loading=false;this.emit(view);
      if(view.resumePending){view.resumePending=false;this.resume(key);}
    }
  }
  async refresh(key) {
    const view=this.views.get(key);if(!view || view.loading) return;
    view.scan={ids:new Set(),queue:view.root?[{id:view.root,cursor:null},...(view.options.upstream||[]).map(id=>({id,cursor:null,contextOnly:true}))]:[],visited:new Set()};
    view.unavailable=false;
    // Keep the authorized graph and positions until a complete bounded refresh
    // succeeds. Authorization denial clears it immediately in advance().
    await this.advance(key);
  }
  async search(channelId,{cursor=null}={}) {
    const page=await this.api.getTowerPgChannelTasks(this.context.workspaceId,channelId,this.options({cursor,limit:100}));
    if(!Array.isArray(page.tasks) || page.has_more && !page.next_cursor) throw new Error('Incomplete task search response');
    this.verify(page);await this.materialize(page.tasks);return page;
  }
  async create(channelId,request,{scopeId}={}) {
    const result=await this.api.createTowerPgChannelTask(this.context.workspaceId,channelId,request,this.options());
    this.verify(result);
    if(!result.task?.id) throw new Error('Task creation was not confirmed. Retry the same entry.');
    if(result.task.channel_id!==channelId || scopeId && result.task.scope_id!==scopeId) throw new Error('Task destination was not confirmed. Retry the same entry.');
    await this.materialize([result.task]);return result.task;
  }
  close() {this.closed=true;clearInterval(this.timer);globalThis.document?.removeEventListener('visibilitychange',this.visibilityChanged);for(const key of this.views.keys())this.remove(key);this.worker?.terminate();}
}
