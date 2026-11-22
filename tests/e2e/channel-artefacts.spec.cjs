const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const root = path.resolve(__dirname, '../..');
let bundle, html;
test.use({ serviceWorkers: 'block', actionTimeout: 15000 });
test.beforeAll(async () => {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dialog = source.slice(source.indexOf('<dialog id="artefact-dialog"'), source.indexOf('</dialog>', source.indexOf('<dialog id="artefact-dialog"')) + 9);
  html = `<!doctype html><html><head><meta charset="utf-8"><style>${fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8')}</style></head><body><div x-data><button @click="$store.chat.openArtefact(window.row)">Open shared artefact</button>${dialog}</div><script type="module" src="/__artefact-harness.js"></script></body></html>`;
  bundle = (await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1testapp') },
    plugins: [{ name: 'fake-file-api', setup(b) {
      b.onResolve({ filter: /api\.js$/ }, args => /(?:artefacts|board-sync|html-assets|artifact-picker)\.js$/.test(args.importer) ? { path: 'mock-api', namespace: 'mock-api' } : null);
      b.onLoad({ filter: /.*/, namespace: 'mock-api' }, () => ({ resolveDir: root, contents: `export * from '${root}/src/api.js'; ${['getTowerPgFile','getTowerPgFileVersions','getTowerPgFileVersionObjectBytes','prepareTowerPgStorageObject','uploadStorageObject','completeStorageObject','createTowerPgFileVersion'].map(name => `export const ${name} = (...args) => window.fakeApi.${name}(...args);`).join('\n')}` }));
    } }],
    stdin: { resolveDir: root, contents: `
      import Alpine from 'alpinejs';
      import { artefactsMixin } from './src/artefacts.js';
      import { openWorkspaceDb } from './src/db.js';
      import { registerCanvasHtml } from './src/canvas/html-naplet.js';
      import { registerCanvasBoard } from './src/canvas/board-naplet.js';
      const ws='20000000-0000-4000-8000-000000000071', id='60000000-0000-4000-8000-000000000001';
      let counter=1, bytes=new TextEncoder().encode('<h1>Shared source</h1><button onclick="this.textContent=\\'Works\\'">Try</button><script>try{parent.document.body.dataset.escaped="yes"}catch{}</'+'script>');
      let mime='text/html';let head='60000000-0000-4000-8000-000000000002', versions=[];
      const sha=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
      const add=async()=>{versions.unshift({id:head,file_id:id,version_number:++counter,content_type:mime,size_bytes:bytes.length,sha256_hex:await sha(bytes)})}; await add();
      window.fakeApi={
        configureBoard:async()=>{mime='application/vnd.excalidraw+json';bytes=new TextEncoder().encode(JSON.stringify({type:'excalidraw',version:2,elements:[],appState:{},files:{}}));versions=[];await add();window.row.title='Shared.excalidraw';},
        getTowerPgFile:async()=>({file:{id,workspace_id:ws,display_name:'Shared tool',can_write:!window.readOnly}}),
        getTowerPgFileVersions:async()=>({current_version_id:head,versions}),
        getTowerPgFileVersionObjectBytes:async()=>({bytes}),
        prepareTowerPgStorageObject:async()=>({object_id:'upload',is_public:false}),
        uploadStorageObject:async(_p,value)=>{window.uploaded=value}, completeStorageObject:async()=>({}),
        createTowerPgFileVersion:async(_ws,_id,body)=>{if(window.stale||body.base_version_id!==head)throw Object.assign(new Error('stale'),{status:409});bytes=window.uploaded;head='60000000-0000-4000-8000-'+String(counter+2).padStart(12,'0');await add();return {version:versions[0]}}
      };
      const db=openWorkspaceDb('artefact-e2e');await db.open();await db.sync_state.clear();
      Alpine.store('chat',{...artefactsMixin,$nextTick:Alpine.nextTick,session:{npub:'alice'},currentViewerNpub:'alice',currentWorkspaceKey:'artefact-e2e',currentWorkspace:{workspaceId:ws,directHttpsUrl:location.origin},isPersonalPinned:()=>false,togglePersonalPin:()=>{},copyArtefactLink:()=>{}});
      registerCanvasHtml(Alpine,{name:'artefact-html',assetStore:()=>Alpine.store('chat').artefactAssetStore()});
      registerCanvasBoard(Alpine,{controllerFor:id=>Alpine.store('chat').artefactBoardController(id)});
      window.row={record_id:id,pg_record_type:'file',title:'Shared.html'};window.Alpine=Alpine;Alpine.start();`
    } })).outputFiles[0].text;
});
async function open(page, board = false) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__artefact-harness.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/__artefact-harness.html') return route.fulfill({ contentType: 'text/html', body: html });
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/__artefact-harness.html');
  await page.waitForFunction(() => window.fakeApi && window.Alpine);
  if (board) await page.evaluate(() => window.fakeApi.configureBoard());
  await page.getByRole('button', { name: 'Open shared artefact' }).click();
  await expect(page.locator('#artefact-dialog')).toBeVisible();
}
test('direct HTML stays isolated, edits saved source, retains stale drafts and reopens saved content', async ({ page }) => {
  await open(page);
  const frame = page.frameLocator('iframe[title="Interactive HTML artefact"]');
  await expect(frame.getByRole('heading')).toHaveText('Shared source');
  await frame.getByRole('button', { name: 'Try' }).click();
  await expect(frame.getByRole('button', { name: 'Works' })).toBeVisible();
  expect(await page.locator('body').getAttribute('data-escaped')).toBeNull();
  await page.getByRole('button', { name: 'Edit source' }).click();
  await expect(page.getByRole('textbox', { name: 'HTML source' })).toContainText('');
  await page.getByRole('textbox', { name: 'HTML source' }).fill('<h1>Updated shared source</h1>');
  await page.evaluate(() => { window.stale = true; });
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByRole('alert')).toContainText('newer version');
  await expect(page.getByRole('textbox', { name: 'HTML source' })).toHaveValue('<h1>Updated shared source</h1>');
  await page.evaluate(() => { window.stale = false; });
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(frame.getByRole('heading')).toHaveText('Updated shared source');
  await page.getByRole('button', { name: 'Close artefact' }).click();
  await page.getByRole('button', { name: 'Open shared artefact' }).click();
  await expect(frame.getByRole('heading')).toHaveText('Updated shared source');
});
test('read-only HTML exposes preview and revisions without source editing', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Close artefact' }).click();
  await page.evaluate(() => { window.readOnly = true; });
  await page.getByRole('button', { name: 'Open shared artefact' }).click();
  await expect(page.frameLocator('iframe[title="Interactive HTML artefact"]').getByRole('heading')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit source' })).toBeHidden();
  await expect(page.getByLabel('HTML revision')).toBeVisible();
});

test('opens a whiteboard directly in the existing editor without a canvas', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await open(page, true);
  const editor = page.frameLocator('iframe[title="Whiteboard editor"]');
  await expect(editor.locator('canvas.interactive')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save whiteboard' })).toBeDisabled();
  await expect(page.getByLabel('Whiteboard revision')).toBeVisible();
  const box = await page.locator('iframe[title="Whiteboard editor"]').boundingBox();
  await editor.locator('canvas.interactive').click({ position: { x: 300, y: 250 } });
  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 60, { steps: 5 }); await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Save whiteboard' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save whiteboard' }).click();
  await expect(page.getByRole('button', { name: 'Save whiteboard' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close artefact' }).click();
  await page.getByRole('button', { name: 'Open shared artefact' }).click();
  await expect(editor.locator('canvas.interactive')).toBeVisible();
  await expect(editor.locator('#board-root')).toHaveAttribute('data-board-element-count', '1');
});

test('channel list includes documents and rich Files with type and title filters', async ({ page }) => {
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
  const results = await page.evaluate(() => {
    const store = Alpine.store('chat'); store.selectedBoardId = '__all__';
    store.documents = [
      { record_id: 'doc', title: 'Notes', record_state: 'active' },
      { record_id: 'board', title: 'Architecture.excalidraw', pg_record_type: 'file', record_state: 'active' },
      { record_id: 'html', title: 'Interactive.html', pg_record_type: 'file', record_state: 'active' },
      { record_id: 'photo', title: 'photo.png', pg_record_type: 'file', record_state: 'active' }
    ];
    store.docFilter = ''; store.artefactTypeFilter = 'all'; const all = store.filteredDocBrowserItems.map(row => row.item.record_id);
    store.artefactTypeFilter = 'excalidraw'; const boards = store.filteredDocBrowserItems.map(row => row.item.record_id);
    store.docFilter = 'missing'; const missing = store.filteredDocBrowserItems.length;
    return { all, boards, missing };
  });
  expect(results).toEqual({ all: ['board', 'html', 'doc'], boards: ['board'], missing: 0 });
});
