const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/context-record-delta-v1.json');

test('populated v30 upgrade, second-client paging/reconnect, subtree delete, revocation and workspace isolation in real worker', async ({ page, baseURL }) => {
  const options = { bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') } };
  const worker = await build({ ...options, entryPoints: [path.resolve(__dirname, '../../src/worker/tower-pg-materialization-worker.js')] });
  const harness = await build({ ...options, stdin: { contents: `import Dexie from 'dexie'; import {openWorkspaceDb} from './src/db.js'; import {observeContextScope} from './src/context-cache.js'; import {PG_RECORD_DELTA_FAMILIES} from './src/pg-record-delta.js'; window.probe={Dexie,openWorkspaceDb,observeContextScope,families:PG_RECORD_DELTA_FAMILIES};`, resolveDir: path.resolve(__dirname, '../..') } });
  const origin = new URL(baseURL).origin;
  await page.route(`${origin}/__context-probe`, r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module" src="/__context-harness.js"></script>' }));
  await page.route(`${origin}/__context-harness.js`, r => r.fulfill({ contentType: 'text/javascript', body: harness.outputFiles[0].text }));
  await page.route(`${origin}/__context-worker.js`, r => r.fulfill({ contentType: 'text/javascript', body: worker.outputFiles[0].text }));
  await page.goto(`${origin}/__context-probe`); await page.waitForFunction(() => window.probe);
  const result = await page.evaluate(async ({ fixture, origin }) => {
    const { Dexie, openWorkspaceDb, observeContextScope, families } = window.probe;
    const key = `context-lifecycle-${crypto.randomUUID()}`, workspaceId = fixture.components[0].workspace_id, scopeId = fixture.components[0].scope_id;
    const name = `wingman-fd-ws-${key}`;
    const old = new Dexie(name); old.version(30).stores({ tasks: 'record_id', sync_state: 'key' });
    await old.open(); await old.tasks.put({ record_id: 'existing-task', title: 'Retained existing cache' });
    await old.sync_state.put({ key: 'existing-cursor', value: 'retained' }); old.close();
    const db = openWorkspaceDb(key); await db.open();
    const upgraded = { version: db.verno, task: await db.tasks.get('existing-task'), cursor: await db.sync_state.get('existing-cursor') };
    const observed=[]; const sub=observeContextScope(db,workspaceId,scopeId).subscribe(v=>observed.push(v));
    let w, requestId=0;
    const start=()=>{ w=new Worker(`${origin}/__context-worker.js`,{type:'module'}); };
    const store={session:{npub:'viewer'},currentWorkspace:{workspaceId,workspaceOwnerNpub:'owner',pgBackendMode:true}};
    const send=bundle=>new Promise((resolve,reject)=>{
      w.onmessage=({data})=>data.ok?resolve(data.value):reject(Error(JSON.stringify(data.error)));
      w.onerror=e=>reject(Error(e.message));
      w.postMessage({type:'tower-pg-materializer:request',id:++requestId,workspaceKey:key,workspaceDbKey:key,store,bundle});
    });
    const changes=[...fixture.components.map(row=>({family:'context_component',row})),...fixture.references.map(row=>({family:'context_reference',row}))]
      .map((c,i)=>({...c,id:c.row.id,workspace_id:workspaceId,scope_id:scopeId,channel_id:null,operation:'upsert',version:String(i+1)}));
    const page=(changes,cursor,has_more=false)=>({protocol_version:1,families,mode:'delta',changes,next_cursor:cursor,has_more,snapshot_id:null,snapshot_complete:false,partitions_complete:[]});
    const counts=async()=>[await db.context_components.count(),await db.context_references.count()];
    try {
      start();await send(page(changes.slice(0,1),'a',true));const partial=await counts();
      w.terminate();start();await send(page(changes.slice(1),'b'));const reconnected=await counts();
      await send(page([{...changes[1],version:'8',row:{...changes[1].row,title:'Second client change',row_version:2}}],'c'));
      const secondClient=(await db.context_components.get(changes[1].id)).title;
      const tombstones=changes.map((c,i)=>({...c,version:String(10+i),operation:'delete',row:null}));
      await send(page(tombstones.slice(0,1),'d',true));const splitDelete=await counts();
      await send(page(tombstones.slice(1),'e'));const deleted=await counts();
      await send(page(changes.map((c,i)=>({...c,version:String(20+i)})),'f'));
      // Epoch replacement after scope revocation: no authorized context rows.
      await send({...page([],'g',true),mode:'snapshot',snapshot_id:'revocation',snapshot_complete:true,partitions_complete:families});
      await send(page([],'h'));const revoked=await counts();
      const other=openWorkspaceDb(`${key}-other`);await other.open();const switched=[await other.context_components.count(),await other.context_references.count()];
      other.close();await Dexie.delete(other.name);
      await new Promise(r=>setTimeout(r,50));
      const orphanSnapshots=observed.filter(v=>v.references.some(r=>!v.components.some(c=>c.id===r.component_id))||v.components.some(c=>c.parent_id&&!v.components.some(p=>p.id===c.parent_id))).length;
      return {upgraded,partial,reconnected,secondClient,splitDelete,deleted,revoked,switched,orphanSnapshots};
    } finally {sub.unsubscribe();w.terminate();db.close();await Dexie.delete(name);}
  }, { fixture, origin });
  expect(result.upgraded.version).toBe(31);expect(result.upgraded.task.title).toBe('Retained existing cache');expect(result.upgraded.cursor.value).toBe('retained');
  expect(result.partial).toEqual([0,0]);expect(result.reconnected).toEqual([2,1]);expect(result.secondClient).toBe('Second client change');
  expect(result.splitDelete).toEqual([2,1]);expect(result.deleted).toEqual([0,0]);expect(result.revoked).toEqual([0,0]);expect(result.switched).toEqual([0,0]);expect(result.orphanSnapshots).toBe(0);
});
