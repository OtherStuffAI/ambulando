const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const evidence = path.resolve(__dirname, '../../tmp/docs/handoffs/context-ui-polish');
let bundle, markup, css;
test.beforeAll(async () => {
  const html = new JSDOM(await fs.readFile(path.resolve(__dirname, '../../index.html'), 'utf8'));
  function find(node) { return node.querySelector('.context-tree-view') || [...node.querySelectorAll('template')].map(t => find(t.content)).find(Boolean); }
  markup = find(html.window.document).outerHTML;
  css = await fs.readFile(path.resolve(__dirname, '../../src/styles.css'), 'utf8');
  const result = await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1fixture') },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
      import Alpine from 'alpinejs'; import Dexie from 'dexie';
      import {openWorkspaceDb,getWorkspaceDb} from './src/db.js'; import {createContextTreeView} from './src/context-tree-view.js';
      const dbKey='context-ui-'+crypto.randomUUID(), db=openWorkspaceDb(dbKey); await db.open();
      const components=[{id:'suite',title:'Wingman Suite',parent_id:null,sort_order:0},{id:'flight',title:'Flight Deck',parent_id:'suite',sort_order:1},{id:'tree',title:'Tree browser',parent_id:'flight',sort_order:0},{id:'auto',title:'Autopilot',parent_id:'suite',sort_order:0},{id:'ops',title:'Operations',parent_id:null,sort_order:1}]
        .map(row=>({...row,record_id:row.id,workspace_id:'workspace',scope_id:'scope',row_version:1}));
      const references=[{id:'doc-ref',target_type:'doc',target:{record_id:'doc'}},{id:'task-ref',target_type:'task',target:{record_id:'task'}},{id:'file-ref',target_type:'file',target:{record_id:'file'}},{id:'hidden-ref',target_type:'doc',target:{record_id:'private'}},{id:'artifact-ref',target_type:'artifact',target:{origin:'https://artifacts.example',project:'Suite',artifact:'Design',page:'index.html',version_policy:'latest'}}]
        .map((row,i)=>({...row,record_id:row.id,workspace_id:'workspace',scope_id:'scope',component_id:'flight',sort_order:i,row_version:1}));
      await db.transaction('rw',db.context_components,db.context_references,async()=>{await db.context_components.bulkPut(components); await db.context_references.bulkPut(references);});
      const calls=[],opened=[]; let fail=false, delay=false, manage=true, commandDelay=false;
      const commands=[];
      await db.documents.put({record_id:'doc',title:'Picked document',pg_record_type:'doc',pg_workspace_id:'workspace',record_state:'active'});
      await db.documents.put({record_id:'file',title:'Picked file',pg_record_type:'file',pg_workspace_id:'workspace',record_state:'active'});
      await db.tasks.put({record_id:'task',title:'Picked task',pg_record_type:'task',pg_workspace_id:'workspace',record_state:'active'});
      async function preview(id){const all=await db.context_components.toArray(),ids=new Set([id]);let changed=true;while(changed){changed=false;for(const row of all)if(ids.has(row.parent_id)&&!ids.has(row.id)){ids.add(row.id);changed=true}}const refs=(await db.context_references.toArray()).filter(r=>ids.has(r.component_id));return {component_id:id,component_count:ids.size,descendant_count:ids.size-1,reference_count:refs.length,confirmation_token:JSON.stringify([all.filter(r=>ids.has(r.id)),refs])};}
      const service={disposed:false,async ensureLoaded(family,id,options){calls.push({family,id,options}); const current=getWorkspaceDb();
        if(fail) throw Object.assign(Error('PRIVATE server error'),{status:500});
        if(family==='context-tree') await current.context_coverage.put({scope_id:id,workspace_id:Alpine.store('chat').currentWorkspace.workspaceId,status:'complete',capabilities:{read:true,manage}});
        if(family==='context-delete-preview') return {preview:await preview(id)};
        if(family==='channel-documents') return current.documents.toArray();
        if(family==='channel-tasks' || family==='scope-tasks') return current.tasks.toArray();
        if(family==='context-references'){
          await current.context_reference_resolutions.where('component_id').equals(id).delete();
          if(delay) await new Promise(r=>window.releaseReferences=r);
          const rows=await current.context_references.where('component_id').equals(id).toArray();
          for(const row of rows) await current.context_reference_resolutions.put({record_id:row.id,workspace_id:row.workspace_id,scope_id:row.scope_id,component_id:id,row_version:row.row_version,resolution:row.id==='hidden-ref'?{status:'unavailable'}:row.target_type==='artifact'?{status:'external'}:{status:'available',title:'Current '+row.target_type+' title'}});
        }
        if(family==='documents') await current.documents.put({record_id:'file',pg_record_type:'file',record_state:'active',pg_storage_object_id:'authorized-storage',title:'Authorized file'});
      },async command(name,input){
        commands.push({name,input});let created;
        if(!manage)throw Object.assign(Error('Denied'),{status:403});
        if(commandDelay)await new Promise(resolve=>window.releaseCommand=resolve);
        const {componentId,referenceId,body}=input, operation=name.split('.')[1];
        if(operation==='create'){const id=crypto.randomUUID();created={id,record_id:id,title:body.title,parent_id:body.parent_id,workspace_id:'workspace',scope_id:'scope',row_version:1,sort_order:20};await db.context_components.put(created);}
        if(operation==='update'){const row=await db.context_components.get(componentId);if(row.row_version!==body.expected_row_version)throw Object.assign(Error('Stale'),{status:409});await db.context_components.put({...row,title:body.title,parent_id:body.parent_id,row_version:row.row_version+1});}
        if(operation==='attach'){const id=crypto.randomUUID();await db.context_references.put({id,record_id:id,component_id:componentId,workspace_id:'workspace',scope_id:'scope',row_version:1,sort_order:20,...body});}
        if(operation==='unlink'){const row=await db.context_references.get(referenceId);if(row.row_version!==body.expected_row_version)throw Object.assign(Error('Stale'),{status:409});await db.context_references.delete(referenceId);}
        if(operation==='delete'){const current=await preview(componentId);if(current.confirmation_token!==body.confirmation_token)throw Object.assign(Error('Changed'),{status:409});const ids=JSON.parse(current.confirmation_token)[0].map(r=>r.id),refs=JSON.parse(current.confirmation_token)[1].map(r=>r.id);await db.transaction('rw',db.context_components,db.context_references,async()=>{await db.context_components.bulkDelete(ids);await db.context_references.bulkDelete(refs);});}
        return {acknowledged:true,component:created};
      }};
      Alpine.store('chat',{isLoggedIn:true,isTowerPgMode:true,workspaceDbKey:dbKey,currentWorkspace:{workspaceId:'workspace'},pgContextScope:{record_id:'scope',title:'Wingman Suite'},selectedBoardScope:null,channels:[{record_id:'channel',title:'Other scope channel',pg_workspace_id:'workspace',record_state:'active'}],scopes:[],
        getTowerSyncService(){return service},handleMentionNavigate(type,id){opened.push({type,id})},navigateTo(section){opened.push({section})},downloadFileBrowserRow(row){opened.push(row)}});
      Alpine.data('contextTreeView',()=>createContextTreeView({openExternal:url=>opened.push({url})}));
      window.Alpine=Alpine;window.fixture={db,components,references,calls,opened,commands,setManage(value){manage=value},setCommandDelay(value){commandDelay=value},store:Alpine.store('chat'),get view(){return Alpine.$data(document.querySelector('.context-tree-view'))},setFailure(value){fail=value},setDelay(value){delay=value},async switchWorkspace(){this.view.suspend();const other=openWorkspaceDb(dbKey+'-other');await other.open();this.store.currentWorkspace={workspaceId:'other'};this.store.workspaceDbKey=dbKey+'-other';this.store.pgContextScope={record_id:'otherScope',title:'Other scope'};},async cleanup(){Alpine.$data(document.querySelector('.context-tree-view')).destroy();const current=getWorkspaceDb(),names=[db.name,current.name];db.close();current.close();for(const name of new Set(names))await Dexie.delete(name);}};
      Alpine.start();` } });
  bundle = result.outputFiles[0].text;
});
async function start(page, baseURL, viewport) {
  page.wp4Errors = []; page.on('pageerror', error => page.wp4Errors.push(error.message));
  if (viewport) await page.setViewportSize(viewport);
  const origin = new URL(baseURL).origin;
  await page.route(`${origin}/__context-ui`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>[x-cloak]{display:none!important}body{margin:0;font-family:system-ui}${css}</style>${markup}<script type="module" src="/__context-ui.js"></script>` }));
  await page.route(`${origin}/__context-ui.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.goto(`${origin}/__context-ui`);  await page.waitForFunction(() => window.fixture?.view.status === 'complete');
  await expect(page.getByRole('treeitem', { name: 'Flight Deck', exact: true })).toBeVisible();
}
test.afterEach(async ({ page }) => { await page.evaluate(() => { window.fixture?.view.cancelEdit(); return window.fixture?.cleanup(); }).catch(() => {}); expect(page.wp4Errors || []).toEqual([]); });

for(const [name,viewport,mode] of [['desktop',{width:1440,height:900},'Outline'],['mobile',{width:390,height:844},'Outline'],['desktop-visual',{width:1440,height:900},'Visual'],['mobile-visual',{width:390,height:844},'Visual']]) {
 test(`${name} manager creates root/child, renames, moves subtree, links current records and preserves content on deletion`,async({page,baseURL})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await start(page,baseURL,viewport);
  await page.getByRole('button',{name:mode,exact:true}).click();
  await page.getByRole('button',{name:'Add top-level component',exact:true}).click();
  await page.getByRole('textbox',{name:'Component name',exact:true}).fill('New root');await page.getByRole('button',{name:'Save component',exact:true}).click();
  await expect(page.getByRole('treeitem',{name:'New root',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Add child to New root',exact:true}).click();await page.getByRole('textbox',{name:'Component name',exact:true}).fill('New child');await page.getByRole('button',{name:'Save component',exact:true}).click();
  const find=page.getByRole('combobox',{name:'Find component',exact:true});await find.fill('New root');await page.getByRole('button',{name:'New root New root',exact:true}).click();await page.getByRole('button',{name:'Rename or move',exact:true}).click();
  const parent=page.getByRole('combobox',{name:'Component parent',exact:true});await parent.fill('New');await expect(page.locator('#context-parent-results')).not.toContainText('New root');await expect(page.locator('#context-parent-results')).not.toContainText('New child');
  await parent.fill('Operations');await page.getByRole('option',{name:'Operations Top level'}).click();await page.getByRole('textbox',{name:'Component name',exact:true}).fill('Moved root');await page.getByRole('button',{name:'Save component',exact:true}).click();
  await expect.poll(()=>page.evaluate(async()=>{const rows=await window.fixture.db.context_components.toArray(),root=rows.find(r=>r.title==='Moved root'),child=rows.find(r=>r.title==='New child');return root.parent_id==='ops'&&child.parent_id===root.id})).toBe(true);
  await page.getByRole('button',{name:'Link reference',exact:true}).click();await expect(page.getByRole('button',{name:'Picked document Document · Other scope channel',exact:true})).toBeVisible();await page.getByRole('button',{name:'Picked document Document · Other scope channel',exact:true}).click();
  await expect(page.getByRole('button',{name:'Current doc title',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Current doc title',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.fixture.opened)).toContainEqual({type:'doc',id:'doc'});
  await page.getByRole('button',{name:'Link reference',exact:true}).click();await page.getByRole('combobox',{name:'Reference type',exact:true}).selectOption('task');await page.getByRole('button',{name:'Picked task Task · Other scope channel',exact:true}).click();
  await page.getByRole('button',{name:'Current task title',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.fixture.opened)).toContainEqual({type:'task',id:'task'});
  await page.getByRole('button',{name:'Link reference',exact:true}).click();await page.getByRole('combobox',{name:'Reference type',exact:true}).selectOption('file');await page.getByRole('button',{name:'Picked file File · Other scope channel',exact:true}).click();
  await page.getByRole('button',{name:'Current file title',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.fixture.opened)).toContainEqual({object_id:'authorized-storage',name:'Authorized file',kind:'file'});
  await page.getByRole('button',{name:'Unlink Current task title',exact:true}).click();await expect(page.getByRole('button',{name:'Current task title',exact:true})).toHaveCount(0);
  await fs.mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${name}-references.png`),fullPage:true});
  await page.getByRole('button',{name:'Delete component',exact:true}).click();await expect(page.getByText('Delete this component and 1 descendants? 2 reference links will be removed. Linked content will remain.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel deletion',exact:true}).click();await expect(page.getByRole('treeitem',{name:'Moved root',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Delete component',exact:true}).click();await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();await expect(page.getByRole('treeitem',{name:'Moved root',exact:true})).toHaveCount(0);await expect(page.getByRole('treeitem',{name:'New child',exact:true})).toHaveCount(0);await expect(page.getByRole('tree',{name:'Scope components',exact:true})).toBeFocused();
  expect(await page.evaluate(async()=>({doc:!!await window.fixture.db.documents.get('doc'),file:!!await window.fixture.db.documents.get('file'),task:!!await window.fixture.db.tasks.get('task')}))).toEqual({doc:true,file:true,task:true});
  expect(errors).toEqual([]);await fs.mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${name}-editing.png`),fullPage:true});
 });
}
test('stale delete preview refreshes counts/token and requires another explicit confirmation',async({page,baseURL})=>{
 await start(page,baseURL);await page.getByRole('treeitem',{name:'Flight Deck',exact:true}).click();await page.getByRole('button',{name:'Delete component',exact:true}).click();
 await page.evaluate(async()=>{const row=await window.fixture.db.context_components.get('tree');await window.fixture.db.context_components.put({...row,title:'Remote rename',row_version:2});});
 await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();await expect(page.getByRole('alert')).toContainText('confirm again');
 expect(await page.evaluate(()=>window.fixture.commands.filter(c=>c.name==='context.delete').length)).toBe(1);await expect(page.getByRole('treeitem',{name:'Flight Deck',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();await expect(page.getByRole('treeitem',{name:'Flight Deck',exact:true})).toHaveCount(0);
});
test('stale row version, disabled duplicate submit, offline deletion and non-manager bypass are rejected',async({page,baseURL})=>{
 await start(page,baseURL);await page.getByRole('treeitem',{name:'Flight Deck',exact:true}).click();await page.getByRole('button',{name:'Rename or move',exact:true}).click();
 await page.evaluate(async()=>{const row=await window.fixture.db.context_components.get('flight');await window.fixture.db.context_components.put({...row,row_version:2});});await page.getByRole('textbox',{name:'Component name',exact:true}).fill('Stale');await page.getByRole('button',{name:'Save component',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Conflict');await page.getByRole('button',{name:'Cancel edit',exact:true}).click();
 await page.getByRole('button',{name:'Add top-level component',exact:true}).click();await page.getByRole('textbox',{name:'Component name',exact:true}).fill('Once');await page.evaluate(()=>window.fixture.setCommandDelay(true));await page.getByRole('button',{name:'Save component',exact:true}).click();await expect(page.getByRole('button',{name:'Saving…',exact:true})).toBeDisabled();await page.evaluate(()=>{window.fixture.setCommandDelay(false);window.releaseCommand();});await expect(page.getByRole('treeitem',{name:'Once',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Delete component',exact:true}).click();await page.context().setOffline(true);await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Nothing was queued');await page.context().setOffline(false);await page.getByRole('button',{name:'Cancel deletion',exact:true}).click();
 await page.evaluate(async()=>{window.fixture.setManage(false);await window.fixture.db.context_coverage.put({scope_id:'scope',workspace_id:'workspace',status:'complete',capabilities:{read:true,manage:false}});});await expect(page.getByRole('button',{name:'Add top-level component',exact:true})).toBeHidden();
 const denial=await page.evaluate(async()=>{try{await window.fixture.store.getTowerSyncService().command('context.delete',{scopeId:'scope',componentId:'flight',body:{confirmation_token:'bypass'}});return 200}catch(e){return e.status}});expect(denial).toBe(403);
});
test('neutral inaccessible targets, current title changes and typed artifact links',async({page,baseURL})=>{
 await start(page,baseURL);await page.getByRole('treeitem',{name:'Flight Deck',exact:true}).click();await expect(page.getByRole('button',{name:'Reference unavailable',exact:true})).toBeDisabled();expect(await page.locator('body').innerText()).not.toContain('PRIVATE');
 await page.evaluate(async()=>window.fixture.db.context_reference_resolutions.put({record_id:'doc-ref',workspace_id:'workspace',scope_id:'scope',component_id:'flight',row_version:1,resolution:{status:'available',title:'Updated title'}}));await expect(page.getByRole('button',{name:'Updated title',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Link reference',exact:true}).click();await page.getByRole('combobox',{name:'Reference type',exact:true}).selectOption('artifact');await page.getByRole('textbox',{name:'Artifact origin',exact:true}).fill('https://artifacts.example');await page.getByRole('textbox',{name:'Artifact project',exact:true}).fill('Suite');await page.getByRole('textbox',{name:'Artifact name',exact:true}).fill('Architecture');await page.getByRole('button',{name:'Link artifact',exact:true}).click();
 await page.getByRole('button',{name:'Open latest artifact: Suite / Architecture (latest)',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.fixture.opened)).toContainEqual({url:'https://artifacts.example/artifacts/Suite/Architecture/'});
});

for (const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]) {
 test(`${name} path typeahead, sidebar child, modal focus/keyboard and cancellation keep canvas stable`,async({page,baseURL})=>{
  await start(page,baseURL,viewport);
  await page.getByRole('button',{name:'Collapse Wingman Suite',exact:true}).click();
  const search=page.getByRole('combobox',{name:'Find component',exact:true});await search.fill('Flight Deck');
  await expect(page.getByRole('option',{name:'Tree browser Wingman Suite / Flight Deck / Tree browser'})).toBeVisible();await search.press('ArrowDown');await search.press('Enter');
  await expect(page.getByRole('treeitem',{name:'Tree browser',exact:true})).toBeFocused();
  const canvas=await page.locator('.context-tree-canvas').boundingBox();const transform=await page.evaluate(()=>window.fixture.view.transform);
  const child=page.getByRole('button',{name:'+ New child',exact:true});await child.click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await expect(page.getByRole('textbox',{name:'Component name',exact:true})).toBeFocused();
  await expect(page.getByRole('combobox',{name:'Component parent',exact:true})).toHaveValue('Tree browser');
  expect(await page.locator('.context-tree-canvas').boundingBox()).toEqual(canvas);expect(await page.evaluate(()=>window.fixture.view.transform)).toBe(transform);
  await page.getByRole('textbox',{name:'Component name',exact:true}).fill('Cancelled child');
  await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(child).toBeFocused();
  expect(await page.evaluate(()=>window.fixture.commands)).toEqual([]);expect(await page.evaluate(()=>window.fixture.view.selectedId)).toBe('tree');
  await child.click();await page.getByRole('textbox',{name:'Component name',exact:true}).fill('Keyboard child');
  const parent=page.getByRole('combobox',{name:'Component parent',exact:true});await parent.fill('Operations');await parent.press('ArrowDown');await parent.press('Enter');
  await expect(parent).toHaveValue('Operations');
  await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Tab');
  expect(await page.evaluate(()=>document.querySelector('.context-tree-dialog').contains(document.activeElement))).toBe(true);
  await fs.mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${name}-component-modal.png`),fullPage:true});
  await page.getByRole('button',{name:'Save component',exact:true}).click();
  await page.getByRole('button',{name:'Link reference',exact:true}).click();
  const refs=page.getByRole('combobox',{name:'Find reference',exact:true});await expect(refs).toBeFocused();await refs.fill('Picked');await refs.press('ArrowDown');await refs.press('ArrowDown');
  await expect(page.getByRole('option',{name:'Picked task Task · Other scope channel'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByText('No matching accessible records.',{exact:true})).toBeHidden();await page.screenshot({path:path.join(evidence,`${name}-reference-typeahead.png`),fullPage:true});await refs.press('Enter');
  await expect(dialog).not.toBeVisible();await expect(page.getByRole('button',{name:'Current task title',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.fixture.commands.find(c=>c.name==='context.attach').input.body.target_type)).toBe('task');
  await page.getByRole('button',{name:'Rename or move',exact:true}).click();await parent.fill('Keyboard child');await expect(page.locator('#context-parent-results')).not.toContainText('Keyboard child');await parent.press('Escape');await expect(parent).toHaveValue('Operations');await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(evidence,`${name}-polished-tree.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
}
