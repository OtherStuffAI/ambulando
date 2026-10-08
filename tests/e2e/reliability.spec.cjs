const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

async function probe(page, baseURL) {
  const result = await build({ stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
    export * from './src/db.js';
    export * from './src/pg-record-delta.js';
    export {syncTowerPgWorkspace} from './src/pg-read-hydrator.js';
    export {prepareTowerWorkspaceCommand} from './src/tower-command-port.js';
    export {updateTowerPgThreadTitleFromLocal} from './src/pg-write-adapter.js';
    export {observeDiagnostics} from './src/diagnostics-events.js';
    export {sanitizeDiagnosticEvent} from './src/diagnostics-schema.js';
  ` }, bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') },
    plugins: [{name:'controlled-signing',setup(build) {
      build.onLoad({filter:/\/src\/api\.js$/},args=>({contents:fs.readFileSync(args.path,'utf8').replace('return createAuthHeaderForIntendedUrl(resolveTowerSigningUrl(requestUrl), method, body, options);', "return 'controlled-test';"),loader:'js',resolveDir:path.dirname(args.path)}));
    }}],
  });
  const origin = new URL(baseURL).origin;
  await page.route(`${origin}/__reliability`, r => r.fulfill({contentType:'text/html',body:'<!doctype html><div id="outcome" role="status"></div>'}));
  await page.route(`${origin}/__reliability.js`, r => r.fulfill({contentType:'text/javascript',body:result.outputFiles[0].text}));
  await page.goto(`${origin}/__reliability`);
  await page.evaluate(async origin => { window.probe = await import(`${origin}/__reliability.js`); }, origin);
  return origin;
}

test('stale rename recovers once; exhausted and independent conflicts retain a visible failure', async ({page,baseURL}) => {
  const origin = await probe(page,baseURL);
  let attempts=0, exhausted=false;
  await page.route(`${origin}/api/v4/flightdeck-pg/workspaces/*/threads/*`, route => {
    const patch=route.request().method()==='PATCH';
    const failed=patch && (++attempts===1 || exhausted);
    return route.fulfill({status:failed?409:200,contentType:'application/json',body:JSON.stringify(failed?{code:'stale_row_version'}:{thread:{id:'thread',row_version:5,title:'Intended title'}})});
  });
  const run=()=>page.evaluate(async origin=>{
    const events=[];const stop=probe.observeDiagnostics(input=>events.push(probe.sanitizeDiagnosticEvent({...input,ts:Date.now()})));
    const store={session:{npub:'viewer'},backendUrl:origin,currentWorkspace:{workspaceId:'workspace',workspaceOwnerNpub:'owner',appNpub:'test-app',pgBackendMode:true}};
    try {const row=await probe.updateTowerPgThreadTitleFromLocal(store,{record_id:'thread',pg_thread_version:1},'Intended title');document.querySelector('#outcome').textContent=row.title;return {row,events};}
    catch(error){document.querySelector('#outcome').textContent='Rename failed';return {failed:true,events};}
    finally{stop();}
  },origin);
  const recovered=await run();
  expect(attempts).toBe(2);
  expect(recovered.events.filter(e=>e.level==='error')).toHaveLength(0);
  expect(recovered.events.at(-1)).toMatchObject({operation:'thread-rename',outcome:'recovered'});
  expect(recovered.events.filter(e=>e.code==='request').map(e=>e.status)).toEqual([409,200,200]);
  await expect(page.getByRole('status')).toHaveText('Intended title');
  exhausted=true;attempts=0;
  const failure=await run();
  expect(attempts).toBe(2);
  expect(failure.events.at(-1)).toMatchObject({outcome:'failed',level:'error',status:409});
  expect(failure.events.at(-1).correlation).not.toBe(recovered.events.at(-1).correlation);
  await expect(page.getByRole('status')).toHaveText('Rename failed');
});

test('settled channel acknowledgement and long delta catch-up retain cache, pending intent and accurate progress', async ({page,baseURL}) => {
  await probe(page,baseURL);
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/sync-manager.js'),'utf8');
  const methods=['startupSyncProgressLabel','startupSyncProgressMeta'].map(name=>{
    const start=source.indexOf(`  ${name}() {`),end=source.indexOf('\n  },',start)+5;
    return source.slice(start,end);
  }).join('\n');
  const result=await page.evaluate(async ({fixture,methods})=>{
    const workspaceId=fixture.one_message_delta.changes[0].workspace_id;
    const store={session:{npub:'viewer'},backendUrl:location.origin,currentWorkspace:{workspaceId,workspaceOwnerNpub:'owner',appNpub:'test-app',pgBackendMode:true}};
    const key='reliability-'+crypto.randomUUID();const db=probe.openWorkspaceDb(key);await db.open();
    const delta=(cursor,more=false)=>({...fixture.one_message_delta,changes:[],next_cursor:cursor,has_more:more});
    try {
      await probe.applyPgRecordChanges(store,{...delta('settled'),changes:fixture.canonical_upserts.changes});
      await db.pending_writes.add({record_id:'pending-draft',envelope:{}});
      const before=(await db.sync_state.get(probe.recordDeltaCursorKey(store))).value;
      const existing=fixture.canonical_upserts.changes.find(c=>c.family==='channel');
      const created={...existing.row,id:'11111111-1111-4111-8111-111111111111',name:'New channel'};
      const command=probe.prepareTowerWorkspaceCommand(store,'channel.create',{args:[workspaceId,created.scope_id,{name:created.name,client_record_id:created.id},{}],entityId:created.id});
      await command.optimistic();await command.reconcile({channel:created});
      const after=(await db.sync_state.get(probe.recordDeltaCursorKey(store))).value;
      let n=0;const progress=[],cursors=[],counts=[];
      const labels=new Function(`return ({${methods}})`)();
      await probe.syncTowerPgWorkspace(store,{onProgress:update=>{
        progress.push(update);store.startupSyncProgress=update;
        document.querySelector('#outcome').textContent=labels.startupSyncProgressLabel.call(store)+' '+labels.startupSyncProgressMeta.call(store);
      }},{getTowerPgResourceViewStates:async()=>({states:[]}),getTowerPgRecordSync:async(_ws,options)=>{
        cursors.push(options.cursor);counts.push(await db.chat_messages.count());
        await new Promise(resolve=>setTimeout(resolve,5));return delta('delta-'+(++n),n<20);
      }});
      return {before,after,cursors,counts,progress,pending:await db.pending_writes.count(),channels:await db.channels.count()};
    } finally {await probe.deleteWorkspaceDb(key);}
  },{fixture,methods});
  expect(result.after).toEqual(result.before);
  expect(result.cursors).toHaveLength(20);
  expect(result.cursors[0]).toBe('settled');
  expect(result.cursors.every(Boolean)).toBe(true);
  expect(result.counts.every(n=>n>0)).toBe(true);
  expect(result.pending).toBe(1);
  expect(result.channels).toBeGreaterThan(1);
  expect(result.progress.some(p=>p.stage==='recovery')).toBe(false);
  expect(result.progress.filter(p=>p.stage==='applying').every(p=>p.mode==='delta' && p.fullSnapshot===false)).toBe(true);
  await expect(page.getByRole('status')).toContainText('Delta');
});

test('real lazy editor factory failure has a handled concurrent outcome and explicit retry', async ({page})=>{
  await page.route('**/*',route=>serveBuiltFlightDeck(route));
  await page.addInitScript(()=>{window.mountRejections=[];window.addEventListener('unhandledrejection',e=>window.mountRejections.push(e.reason?.name));});
  await page.goto('/', {waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.Alpine?.store('chat'));
  const result=await page.evaluate(async()=>{
    const store=Alpine.store('chat');store.dailyNoteEditorOpen=false;store.dailyNoteEditorMode='view';
    await new Promise(resolve=>setTimeout(resolve,100));
    const el=document.createElement('div');el.id='mount-probe';document.body.append(el);
    store.destroyDailyNoteRichEditor();
    // Actual lazy import runs; a deterministic factory setup failure is independent of transport.
    const prepend=el.prepend.bind(el);let fail=true;
    el.prepend=(...args)=>{if(fail)throw new TypeError('controlled factory setup');return prepend(...args);};
    store.dailyNoteEditorMode='edit';store.dailyNoteEditorBody='Retained draft';
    const outcomes=await Promise.all([store.mountDailyNoteRichEditor(el),store.mountDailyNoteRichEditor(el)]);
    fail=false;
    return {outcomes,draft:store.dailyNoteEditorBody,state:store.dailyNoteRichEditorLoadState};
  });
  expect(result).toEqual({outcomes:[false,false],draft:'Retained draft',state:'error'});
  await expect(page.locator('#mount-probe [role=alert]')).toBeVisible();
  await page.locator('#mount-probe button').click();
  await expect(page.locator('#mount-probe .ProseMirror')).toContainText('Retained draft');
  expect(await page.evaluate(()=>window.mountRejections)).toEqual([]);
});
