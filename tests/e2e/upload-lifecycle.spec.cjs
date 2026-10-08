const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

// Production upload/storage methods and browser AbortSignal/DOM, with synthetic
// signing and disposable local API responses. This is not authenticated Tower.
async function setup(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const bundle = await build({ stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
    export {initApp} from './src/app.js';
    export {openWorkspaceDb, getDocumentDraft, upsertDocumentDraft} from './src/db.js';
    export {setBaseUrl} from './src/api.js';
  ` }, bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { 'import.meta.env': '{}', __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') },
    plugins: [{ name: 'controlled-browser', setup(b) {
      b.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-text' }));
      b.onLoad({ filter: /.*/, namespace: 'raw-text' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }));
      b.onResolve({ filter: /^alpinejs$/ }, () => ({ path: 'alpine', namespace: 'controlled' }));
      b.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({ contents: `export default {store(name,value){if(value)window.uploadStore=value;return window.uploadStore},start(){},nextTick(fn){return Promise.resolve().then(fn)}};` }));
      b.onLoad({ filter: /\/src\/api\.js$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8').replace('return createAuthHeaderForIntendedUrl(resolveTowerSigningUrl(requestUrl), method, body, options);', "return 'controlled-test';"), loader: 'js', resolveDir: path.dirname(args.path) }));
    }}],
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route(`${origin}/__upload-probe`, r => r.fulfill({ contentType: 'text/html', body: '<textarea id="editor">source </textarea>' }));
  await page.route(`${origin}/__upload-probe.js`, r => r.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  await page.goto('/__upload-probe');
  await page.evaluate(async origin => {
    window.uploadProbe = await import(`${origin}/__upload-probe.js`);
    uploadProbe.initApp(); uploadProbe.setBaseUrl(origin);
    const s = uploadStore;
    s.session = { npub: 'fixture-actor' };
    s.knownWorkspaces = [{ workspaceKey: 'source', workspaceId: 'source', workspaceOwnerNpub: 'fixture-owner', directHttpsUrl: origin, pgBackendMode: true }];
    s.selectedWorkspaceKey = 'source';
    s.scheduleStorageImageHydration = () => {};
    s.scheduleComposerAutosize = () => {};
    s.messageInput = 'unsent';
  }, origin);
  return origin;
}

test('lost completion response reconciles the same object; removal aborts a real browser transfer', async ({ page, baseURL }) => {
  const origin = await setup(page, baseURL);
  let prepare = 0, transfer = 0, complete = 0, metadata = 0, accepted;
  await page.route(`${origin}/api/v4/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/prepare')) {
      prepare++;
      return route.fulfill({ json: { object_id: 'fixture-object', upload_url: `${origin}/__transfer` } });
    }
    if (url.pathname.endsWith('/complete')) {
      complete++; accepted = request.postDataJSON();
      return route.abort('failed');
    }
    metadata++;
    return route.fulfill({ json: { object_id: 'fixture-object', completed_at: 'now', ...accepted } });
  });
  await page.route(`${origin}/__transfer`, route => { transfer++; return route.fulfill({ status: 200, body: '' }); });
  const outcome = await page.evaluate(async () => {
    const s = uploadStore;
    s.messageFileDrafts = [{ draft_id: 'one', file: new File(['synthetic'], 'fixture.png', { type: 'image/png' }), filename: 'fixture.png', content_type: 'image/png', status: 'error' }];
    await s.uploadChatFileDraft('one');
    const first = s.messageFileDrafts[0].status;
    await s.uploadChatFileDraft('one');
    return { first, status: s.messageFileDrafts[0].status, body: s.messageInput };
  });
  expect(outcome).toEqual({ first: 'error', status: 'ready', body: 'unsent' });
  expect({ prepare, transfer, complete, metadata }).toEqual({ prepare: 1, transfer: 1, complete: 1, metadata: 1 });

  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  await page.route(`${origin}/__transfer`, async route => {
    started(); await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 200, body: '' }).catch(() => {});
  });
  await page.evaluate(() => {
    const s = uploadStore;
    s.messageFileDrafts = [{ draft_id: 'cancel', file: new File(['source'], 'source.png'), filename: 'source.png', content_type: 'image/png', status: 'error' }];
    window.cancelUpload = s.uploadChatFileDraft('cancel');
  });
  await began;
  const cancelled = await page.evaluate(async () => {
    const s = uploadStore, controller = s._chatUploadControllers.get('cancel');
    s.removeChatFileDraft('cancel'); await window.cancelUpload;
    return { aborted: controller.signal.aborted, drafts: s.messageFileDrafts.length, body: s.messageInput };
  });
  release();
  expect(cancelled).toEqual({ aborted: true, drafts: 0, body: 'unsent' });
  expect(complete).toBe(1);
});

test('inline editor completion cannot touch a reused destination input', async ({ page, baseURL }) => {
  await setup(page, baseURL);
  const result = await page.evaluate(async () => {
    const s = uploadStore, el = document.querySelector('#editor');
    s.selectedDocId = 'source-doc'; s.docEditorContent = el.value;
    let resolve;
    s.uploadInlineImageFile = () => new Promise(done => { resolve = done; });
    const event = { target: el, preventDefault() {}, clipboardData: { items: [{ type: 'image/png', getAsFile: () => new File(['source'], 'source.png') }] } };
    const pending = s.handleInlineImagePaste(event, { modelKey: 'docEditorContent', ownerNpub: 'fixture-owner' });
    s.selectedDocId = 'destination-doc'; s.docEditAccessGeneration++;
    s.docEditorContent = el.value = 'destination draft';
    resolve({ markdown: '![fixture](storage://fixture)' }); await pending;
    return { model: s.docEditorContent, input: el.value };
  });
  expect(result).toEqual({ model: 'destination draft', input: 'destination draft' });
});

test('workspace switch while a real IndexedDB draft opens retains the source content', async ({ page, baseURL }) => {
  await setup(page, baseURL);
  expect(await page.evaluate(async () => {
    const key = `upload-draft-${crypto.randomUUID()}`;
    const db = uploadProbe.openWorkspaceDb(key); await db.open(); db.close();
    const open = db.open.bind(db); let started;
    const began = new Promise(resolve => { started = resolve; });
    db.open = () => { const result = open(); started(); return result; };
    const write = uploadProbe.upsertDocumentDraft({ workspace_id: 'source', document_id: 'doc', content: 'preserved synthetic draft' });
    await began; await uploadProbe.openWorkspaceDb(`${key}-destination`).open();
    await write; await uploadProbe.openWorkspaceDb(key).open();
    return (await uploadProbe.getDocumentDraft('source', 'doc')).content;
  })).toBe('preserved synthetic draft');
});
