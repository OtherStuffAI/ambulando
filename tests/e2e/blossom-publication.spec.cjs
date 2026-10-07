const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');

for (const source of ['file', 'attachment-files', 'attachment-chat']) {
test(`${source} panel uses production API/command/Dexie paths with stubbed Tower responses`, async ({ page, baseURL }, testInfo) => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  const panel = html.match(/<div class="modal-overlay file-blossom-overlay"[\s\S]*?<\/section>\s*<\/div>/)[0];
  const filesButton = html.split('\n').find(line => line.includes('@click="$store.chat.openFileBlossom(row)"'));
  const chatButton = html.split('\n').find(line => line.includes('@click.stop="$store.chat.openMessageAttachmentBlossom(msg, attachment)"'));
  const button = source === 'attachment-chat' ? chatButton : filesButton;
  const bridge = await build({ stdin: { contents: `
    import Alpine from 'alpinejs';
    import { openWorkspaceDb } from './src/db.js';
    import { fileBlossomMixin } from './src/file-blossom.js';
    import { setMemorySecret, setMemoryPubkey } from './src/auth/nostr.js';
    import { storeCredentials } from './src/auth/secure-store.js';
    import { getPublicKey } from 'nostr-tools';
    import { prepareTowerWorkspaceCommand } from './src/tower-command-port.js';
    import { TowerSyncService } from './src/tower-sync-service.js';
    const db = openWorkspaceDb('blossom-browser-' + crypto.randomUUID()); await db.open();
    const secret = new Uint8Array(32).fill(61);
    setMemorySecret(secret); setMemoryPubkey(getPublicKey(secret));
    await storeCredentials({ method: 'ephemeral', pubkey: getPublicKey(secret) });
    const store = { isTowerPgMode: true, currentWorkspace: { workspaceId: 'publication-workspace', directHttpsUrl: location.origin, appNpub: 'npub1test', workspaceOwnerNpub: 'npub1owner' } };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(fileBlossomMixin));
    Alpine.store('chat', store);
    const reactive = Alpine.store('chat');
    const service = new TowerSyncService({ workspaceKey: db.name, ports: { prepareCommand: (name,input) => prepareTowerWorkspaceCommand(reactive,name,input) } });
    reactive.commandTowerWorkspace = (...args) => service.command(...args);
    window.fixture = { db, service, store: reactive }; window.Alpine = Alpine;
    Alpine.start();
  `, resolveDir: path.resolve(__dirname, '../..') }, bundle: true, write: false, format: 'esm', define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') } });
  const row = source !== 'file' ? {source_type:'chat',source_record_id:'chat-message',object_id:'chat-storage',name:'Image.png',workspace_id:'publication-workspace'} : {pg_record_type:'file',source_record_id:'podcast-file',name:'Podcast.mp3',workspace_id:'publication-workspace'};
  const origin = baseURL || 'http://127.0.0.1:41045';
  const publicUrl = `${origin}/${'a'.repeat(64)}`;
  let failMutation = false;
  let failStatus = false;
  const css = fs.readFileSync(path.resolve(__dirname, '../../src/styles.css'), 'utf8');
  let published = false;
  const mutations = [];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__blossom-fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bridge.outputFiles[0].text });
    if (url.pathname.endsWith('/blossom')) {
      if (request.method() === 'GET' && failStatus) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Publication service unavailable' }) });
      if (request.method() !== 'GET') {
        if (failMutation) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Stored bytes changed; attach a new object.' }) });
        mutations.push({ method: request.method(), path: url.pathname, authorization: request.headers().authorization, body: request.postData() });
        published = request.method() === 'PUT';
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(source !== 'file' ? { can_publish: true, attachment: { storage_object_id: 'chat-storage', link_id: 'chat-link', sha256_hex: 'a'.repeat(64), available: true, public: published, published_by_you: published, blossom_url: published ? publicUrl : null } } : { can_publish: true, versions: [
        { version_id: 'new-version', version_number: 2, available: true, public: false, published_by_you: false },
        { version_id: 'old-version', version_number: 1, available: true, public: published, published_by_you: published, blossom_url: published ? publicUrl : null },
      ] }) });
    }
    if (url.pathname === '/' || url.pathname === '/__blossom-fixture') return route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} [x-cloak]{display:none}</style></head><body x-data='${JSON.stringify({row,msg:{record_id:'chat-message',workspace_id:'publication-workspace'},attachment:{storage_object_id:'chat-storage',filename:'Image.png'}})}'><h1>Files</h1>${button}${panel}<script type="module" src="/__blossom-fixture.js"></script></body></html>` });
    return route.abort();
  });
  await page.goto(origin);
  await page.waitForFunction(() => !!window.Alpine?.store('chat'), null, {timeout:10000});
  await page.getByRole('button', { name: source === 'attachment-chat' ? 'Publish to Blossom · Image.png' : 'Publish to Blossom', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to Blossom' });
  await expect(dialog).toBeVisible();
  if (source === 'file') {
    await expect(dialog.locator('select')).toHaveValue('new-version');
    await dialog.locator('select').selectOption('old-version');
  } else await expect(dialog.locator('select')).toBeHidden();
  const publishButton = source === 'file' ? 'Publish selected version' : 'Publish attachment';
  page.once('dialog', dialog => dialog.dismiss());
  await dialog.getByRole('button', { name: publishButton }).click();
  expect(mutations).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept());
  await dialog.getByRole('button', { name: publishButton }).click();
  await expect(dialog.getByLabel('Public Blossom URL')).toHaveValue(publicUrl);
  expect(mutations[0]).toMatchObject(source === 'file' ? { method: 'PUT', path: '/api/v4/flightdeck-pg/workspaces/publication-workspace/files/podcast-file/versions/old-version/blossom', body: '{}' } : { method: 'PUT', path: '/api/v4/flightdeck-pg/workspaces/publication-workspace/messages/chat-message/attachments/chat-storage/blossom', body: JSON.stringify({public:true,expected_link_id:'chat-link',expected_sha256:'a'.repeat(64)}) });
  expect(mutations[0].authorization).toMatch(/^Nostr /);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: 'Copy public URL' }).click();
  await expect(dialog.getByText('Public link copied.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(publicUrl);
  await expect(dialog.getByText('File or channel write permission is required to publish or unpublish.', {exact:true})).toBeHidden();
  await expect(dialog.getByRole('button', {name:'Unpublish my reference'})).toBeEnabled();
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height:800});
    await page.screenshot({path:testInfo.outputPath(`published-${width}.png`)});
  }
  page.once('dialog', dialog => dialog.accept());
  await dialog.getByRole('button', { name: 'Unpublish my reference' }).click();
  await expect(dialog.getByText('Not published', { exact: true })).toBeVisible();
  expect(mutations[1].method).toBe('DELETE');
  failMutation = true;
  page.once('dialog', d => d.accept());
  await dialog.getByRole('button', { name: publishButton }).click();
  await expect(dialog.getByRole('alert')).toContainText('Stored bytes changed');
  await expect(dialog.getByRole('button', { name: publishButton })).toBeEnabled();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: source === 'attachment-chat' ? 'Publish to Blossom · Image.png' : 'Publish to Blossom', exact: true }).click();
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', {name:publishButton})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', {name:'Close',exact:true})).toBeFocused();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: source === 'attachment-chat' ? 'Publish to Blossom · Image.png' : 'Publish to Blossom', exact: true })).toBeFocused();
  failStatus = true;
  await page.getByRole('button', { name: source === 'attachment-chat' ? 'Publish to Blossom · Image.png' : 'Publish to Blossom', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Publication service unavailable');
  await expect(dialog.getByRole('button', { name: publishButton })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.evaluate(async () => { window.fixture.service.dispose(); await window.fixture.db.delete(); });
});

}
