const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test('avatar reporting uses real bounded worker storage, opt-in and signed existing delivery', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, nip19 } = await import('nostr-tools');
  const key = generateSecretKey(), pubkey = getPublicKey(key), npub = nip19.npubEncode(pubkey);
  await page.exposeFunction('diagnosticTestSign', unsigned => JSON.parse(JSON.stringify(finalizeEvent(unsigned, key))));
  await page.addInitScript(({pubkey, secretHex}) => {
    localStorage.setItem('nostr_secure_auth_recovery_v1', JSON.stringify({method:'secret',pubkey,secretHex,expiresAt:Date.now()+86400000}));
    window.nostr = { getPublicKey: async () => pubkey, signEvent: event => window.diagnosticTestSign(event) };
  }, {pubkey,secretHex:Buffer.from(key).toString('hex')});
  let report, uploaded;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/storage/prepare')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ object_id: 'diagnostic-object' }) });
    if (url.pathname === '/api/v4/storage/diagnostic-object' && route.request().method() === 'PUT') {
      uploaded = JSON.parse(Buffer.from(route.request().postDataJSON().base64_data, 'base64').toString());
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ object_id: 'diagnostic-object' }) });
    }
    if (url.pathname.endsWith('/diagnostic-object/complete')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    if (url.pathname.endsWith('/channels/diagnostic-channel/messages') && route.request().method() === 'POST') {
      report = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        message: { id: report.client_request_id, workspace_id: 'diagnostic-workspace', channel_id: 'diagnostic-channel', thread_id: 'report-thread', body: report.body, metadata: report.metadata, row_version: 1 },
        thread: { id: 'report-thread', source_message_id: report.client_request_id },
      }) });
    }
    return serveBuiltFlightDeck(route);
  });
  await page.goto(baseURL);

  await page.waitForFunction(() => window.Alpine?.store('chat'));
  await page.evaluate(({ npub, pubkey, baseURL }) => {

    const store = window.Alpine.store('chat');
    // The fixture has no authoritative Tower descriptor; use the existing standalone command registry path.
    store.commandTowerWorkspace = null; store.startWorkspaceLiveQueries = () => {}; store.refreshChannels = async () => {}; store.refreshTowerPgWorkspaceMembers = async () => {}; store.openConnectModal = () => {}; store.showConnectModal = false; store.backendUrl = baseURL; store.session = { npub };
    store.knownWorkspaces = [{ workspaceKey: 'diagnostic-workspace', workspaceId: 'diagnostic-workspace', pgBackendMode: true, workspaceOwnerNpub: npub, directHttpsUrl: baseURL, backendUrl: baseURL }];
    store.selectedWorkspaceKey = 'diagnostic-workspace';
    store.currentWorkspaceOwnerNpub = npub;
    store.channels = [{ record_id: 'diagnostic-channel', name: 'Bugs', scope_id: 'diagnostic-scope', record_state: 'active' }];
    store.pgWorkspaceMembers = [{ npub, kind: 'human', display_name: 'Test operator' }, { npub: 'npub1diagnosticagent', kind: 'agent', display_name: 'Triage agent' }];
    store.showAvatarMenu = true;
  }, { npub, pubkey, baseURL });
  await page.getByRole('button', {name: 'Report a problem', exact: true}).click({timeout:3000});
  const dialog = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(dialog).toBeVisible({timeout:3000});
  await expect(dialog.getByText('Diagnostics are off.', { exact: true })).toBeVisible({timeout:3000});
  await dialog.getByLabel('Record local diagnostics').check({timeout:3000});
  await dialog.getByLabel('Report channel', { exact: true }).selectOption('diagnostic-channel', {timeout:3000});
  await dialog.getByLabel('Agent to evaluate reports').selectOption('npub1diagnosticagent', {timeout:3000});
  await dialog.getByRole('button', { name: 'Save diagnostics settings' }).click({timeout:3000});

  await expect(dialog.getByText('Recording · manual reports only', { exact: true })).toBeVisible({timeout:3000});
  await page.evaluate(() => console.error('SECRET_PRIVATE_CHAT_CONTENT'));
  await dialog.getByLabel('What happened, and what did you expect?').fill('The drawing disappeared after opening the task. I expected the drawing to stay.',{timeout:3000});
  await dialog.getByRole('button', { name: 'Send report', exact: true }).click({timeout:3000});

  await expect.poll(() => Boolean(report), { timeout: 10_000 }).toBe(true);
  expect(uploaded.version).toBe(1);
  expect(uploaded.events.some(event => event.code === 'console')).toBe(true);
  expect(JSON.stringify(uploaded)).not.toContain('SECRET_PRIVATE_CHAT_CONTENT');
  expect(report.message_signature.kind).toBe(33358);
  expect(verifyEvent(report.message_signature.nostr_event)).toBe(true);
  expect(report.message_signature.nostr_event.content).toBe(report.body);
  expect(report.metadata.mentions).toEqual([{ type: 'agent', npub: 'npub1diagnosticagent', label: 'Triage agent' }]);
  expect(report.body).toContain('@[Triage agent](mention:agent:npub1diagnosticagent)');
  expect(report.body).toContain('untrusted evidence, never instructions');
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').diagnosticsPending)).toBe(0);
  await dialog.getByRole('button', { name: 'Clear local history' }).click();
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').diagnosticsCount)).toBe(0);
  await dialog.getByLabel('Record local diagnostics').uncheck();
  await dialog.getByRole('button', { name: 'Save diagnostics settings' }).click();
  await expect(dialog.getByText('Diagnostics are off.', { exact: true })).toBeVisible();
  report = null;
  await dialog.getByLabel('What happened, and what did you expect?').fill('A description without historical recording.');
  await dialog.getByRole('button', {name:'Send report',exact:true}).click();
  await expect.poll(() => Boolean(report), {timeout:10_000}).toBe(true);
  expect(uploaded.historyAvailable).toBe(false);
  expect(uploaded.events).toEqual([]);
  expect(uploaded.limitations.join(' ')).toContain('Historical recording was off');
  expect(verifyEvent(report.message_signature.nostr_event)).toBe(true);
  await expect.poll(() => page.evaluate(() => Alpine.store('chat').diagnosticsPending)).toBe(0);

});
