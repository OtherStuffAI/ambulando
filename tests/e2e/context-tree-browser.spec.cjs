const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const evidence = path.resolve(__dirname, '../../tmp/docs/handoffs/context-wp3');
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
      const calls=[],opened=[]; let fail=false, delay=false;
      const service={disposed:false,async ensureLoaded(family,id,options){calls.push({family,id,options}); const current=getWorkspaceDb();
        if(fail) throw Object.assign(Error('PRIVATE server error'),{status:500});
        if(family==='context-tree') await current.context_coverage.put({scope_id:id,workspace_id:Alpine.store('chat').currentWorkspace.workspaceId,status:'complete'});
        if(family==='context-references'){
          await current.context_reference_resolutions.where('component_id').equals(id).delete();
          if(delay) await new Promise(r=>window.releaseReferences=r);
          const rows=await current.context_references.where('component_id').equals(id).toArray();
          for(const row of rows) await current.context_reference_resolutions.put({record_id:row.id,workspace_id:row.workspace_id,scope_id:row.scope_id,component_id:id,row_version:row.row_version,resolution:row.id==='hidden-ref'?{status:'unavailable'}:row.target_type==='artifact'?{status:'external'}:{status:'available',title:'Current '+row.target_type+' title'}});
        }
        if(family==='documents') await current.documents.put({record_id:'file',pg_record_type:'file',record_state:'active',pg_storage_object_id:'authorized-storage',title:'Authorized file'});
      }};
      Alpine.store('chat',{isLoggedIn:true,isTowerPgMode:true,workspaceDbKey:dbKey,currentWorkspace:{workspaceId:'workspace'},pgContextScope:{record_id:'scope',title:'Wingman Suite'},selectedBoardScope:null,
        getTowerSyncService(){return service},handleMentionNavigate(type,id){opened.push({type,id})},navigateTo(section){opened.push({section})},downloadFileBrowserRow(row){opened.push(row)}});
      Alpine.data('contextTreeView',()=>createContextTreeView({openExternal:url=>opened.push({url})}));
      window.Alpine=Alpine;window.fixture={db,components,references,calls,opened,store:Alpine.store('chat'),get view(){return Alpine.$data(document.querySelector('.context-tree-view'))},setFailure(value){fail=value},setDelay(value){delay=value},async switchWorkspace(){this.view.suspend();const other=openWorkspaceDb(dbKey+'-other');await other.open();this.store.currentWorkspace={workspaceId:'other'};this.store.workspaceDbKey=dbKey+'-other';this.store.pgContextScope={record_id:'otherScope',title:'Other scope'};},async cleanup(){Alpine.$data(document.querySelector('.context-tree-view')).destroy();const current=getWorkspaceDb(),names=[db.name,current.name];db.close();current.close();for(const name of new Set(names))await Dexie.delete(name);}};
      Alpine.start();` } });
  bundle = result.outputFiles[0].text;
});
async function start(page, baseURL, viewport) {
  if (viewport) await page.setViewportSize(viewport);
  const origin = new URL(baseURL).origin;
  await page.route(`${origin}/__context-ui`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>[x-cloak]{display:none!important}body{margin:0;font-family:system-ui}${css}</style>${markup}<script type="module" src="/__context-ui.js"></script>` }));
  await page.route(`${origin}/__context-ui.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.goto(`${origin}/__context-ui`); await page.waitForFunction(() => window.fixture?.view.status === 'complete');
  await expect(page.getByRole('treeitem', { name: 'Flight Deck', exact: true })).toBeVisible();
}
test.afterEach(async ({ page }) => { await page.evaluate(() => window.fixture?.cleanup()).catch(() => {}); });
for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${name} automatic roots, selection/references, keyboard, collapse, zoom/pan, deletion and workspace disposal`, async ({ page, baseURL }) => {
    console.log('starting',name); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await start(page, baseURL, viewport); console.log(name,'started');
    const flight = page.getByRole('treeitem', { name: 'Flight Deck', exact: true });
    console.log(name,'selecting'); await flight.click(); await expect(page.getByRole('button', { name: 'Current doc title', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Reference unavailable', exact: true })).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Flight Deck', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Current doc title', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.fixture.opened)).toContainEqual({ type: 'doc', id: 'doc' });
    await page.getByRole('button', { name: 'Current task title', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.fixture.opened)).toContainEqual({ type: 'task', id: 'task' });
    await page.getByRole('button', { name: 'Open artifact site: Suite / Design (latest)', exact: true }).click();
    expect(await page.evaluate(() => window.fixture.opened)).toContainEqual({ url: 'https://artifacts.example' });
    await page.getByRole('button', { name: 'Current file title', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.fixture.opened)).toContainEqual({ object_id: 'authorized-storage', name: 'Authorized file', kind: 'file' });
    console.log(name,'openers done'); const before = await page.evaluate(() => window.fixture.calls.length);
    await flight.focus(); await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('treeitem', { name: 'Tree browser', exact: true })).toHaveCount(0);
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Tree browser', exact: true })).toBeVisible();
    await expect(page.getByText('No direct references.', { exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.fixture.calls.slice(-1)))[0].family).toBe('context-references');
    expect(await page.evaluate(() => window.fixture.calls.slice(0, -1).length)).toBe(before);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const scale = await page.evaluate(() => window.fixture.view.scale);
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    expect(await page.evaluate(() => window.fixture.view.scale)).toBeLessThan(scale);
    const canvas = await page.getByRole('tree').boundingBox();
    await page.mouse.move(canvas.x + 20, canvas.y + 20); await page.mouse.down(); await page.mouse.move(canvas.x + 80, canvas.y + 55); await page.mouse.up();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const geometry = await page.evaluate(() => {const tree=document.querySelector('.context-tree-canvas').getBoundingClientRect(),panel=document.querySelector('.context-tree-panel').getBoundingClientRect();return {tree:{x:tree.x,y:tree.y,width:tree.width,height:tree.height},panel:{x:panel.x,y:panel.y,width:panel.width,height:panel.height},overflow:document.documentElement.scrollWidth>innerWidth};});
    expect(geometry.overflow).toBe(false);
    if(name==='mobile') expect(geometry.panel.y).toBeGreaterThanOrEqual(geometry.tree.y+geometry.tree.height);
    else expect(geometry.panel.x).toBeGreaterThanOrEqual(geometry.tree.x+geometry.tree.width);
    await flight.click(); await expect(page.getByRole('button', { name: 'Current doc title', exact: true })).toBeEnabled();
    console.log(name,'geometry done'); await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
    await page.evaluate(async () => {const {db}=window.fixture;await db.transaction('rw',db.context_components,db.context_references,db.context_reference_resolutions,async()=>{await db.context_components.bulkDelete(['flight','tree']);await db.context_references.clear();await db.context_reference_resolutions.clear();});});
    await expect(page.getByRole('heading', { name: 'Flight Deck', exact: true })).toHaveCount(0);
    await expect(page.getByText('The selected component is no longer available.', { exact: true })).toBeVisible();
    console.log(name,'deletion done'); await page.evaluate(() => window.fixture.switchWorkspace());
    await expect(page.getByText('No components in this scope yet.', { exact: true })).toBeVisible();
    await expect(page.getByRole('treeitem')).toHaveCount(0); expect(errors).toEqual([]);
  });
}
test('loading/unloaded/empty/denied/error and reference loading/failure remain distinct and neutral', async ({ page, baseURL }) => {
  await start(page, baseURL);
  await page.evaluate(() => window.fixture.setDelay(true));
  await page.getByRole('treeitem', { name: 'Flight Deck', exact: true }).click();
  await expect(page.getByText('Checking references…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Checking reference…', exact: true }).first()).toBeDisabled();
  await page.evaluate(() => {window.fixture.setDelay(false); window.releaseReferences();});
  await expect(page.getByRole('button', { name: 'Current doc title', exact: true })).toBeEnabled();
  await page.evaluate(() => window.fixture.setFailure(true));
  await page.getByRole('button', { name: 'Current doc title', exact: true }).click();
  await expect(page.getByText('References could not be checked. Try again.', { exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE');
  await page.evaluate(() => window.fixture.setFailure(false)); await page.getByRole('button', { name: 'Retry references', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Current doc title', exact: true })).toBeEnabled();
  await page.evaluate(async()=>window.fixture.db.context_coverage.put({scope_id:'scope',workspace_id:'workspace',status:'denied'}));
  await expect(page.getByText('This context is unavailable for your access.', { exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem')).toHaveCount(0);
  await page.evaluate(() => window.fixture.setFailure(true)); await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.getByText('Context could not be loaded. Try again.', { exact: true })).toBeVisible();
  await page.evaluate(() => {window.fixture.store.pgContextScope=null;});
  await expect(page.getByText('Choose a scope to browse its context.', { exact: true })).toBeVisible();
});
test('representative wide/deep scope lays out and remains keyboard navigable with bounded zoomed DOM', async ({ page, baseURL }) => {
  await start(page, baseURL);
  const timing = await page.evaluate(async () => {
    const {db}=window.fixture,rows=[];
    for(let i=0;i<1500;i++)rows.push({id:'wide-'+i,record_id:'wide-'+i,title:'Wide '+i,parent_id:'suite',sort_order:i,workspace_id:'workspace',scope_id:'scope',row_version:1});
    for(let i=0;i<500;i++)rows.push({id:'deep-'+i,record_id:'deep-'+i,title:'Deep '+i,parent_id:i?'deep-'+(i-1):'ops',sort_order:i,workspace_id:'workspace',scope_id:'scope',row_version:1});
    const start=performance.now();await db.context_components.bulkPut(rows);await new Promise(resolve=>{const check=()=>window.fixture.view.layout.nodes.length===2005?resolve():requestAnimationFrame(check);check();});
    const elapsed=performance.now()-start;window.fixture.view.focusNode('deep-499');return elapsed;
  });
  await expect(page.getByRole('treeitem', { name: 'Deep 499', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Deep 499', exact: true })).toBeVisible();
  expect(await page.getByRole('treeitem').count()).toBeLessThan(100);
  console.log(JSON.stringify({contextTree2005RowsLayoutMs:timing,zoomedRenderedNodes:await page.getByRole('treeitem').count()}));
  expect(timing).toBeLessThan(2500);
});
