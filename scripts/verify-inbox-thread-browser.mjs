// Offline browser verification of the real Inbox action, production store and
// actual conversation modal. No preview server, auth, or external Tower calls.
import { chromium, webkit } from 'playwright';
import { JSDOM } from 'jsdom';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(process.env.FLIGHTDECK_VERIFY_DIST || 'dist');
const built = await readFile(path.join(root, 'index.html'), 'utf8');
const html = process.env.FLIGHTDECK_VERIFY_BUILT_WORKER === '1' ? built : await readFile('index.html', 'utf8');
const document = new JSDOM(html).window.document;
const find = (node, selector) => node.querySelector(selector) || [...node.querySelectorAll('template')].map(t => find(t.content, selector)).find(Boolean);
const inbox = find(document, '[data-deck-column="inbox"]').outerHTML;
const modal = find(document, '.chat-thread-modal-backdrop').outerHTML;
const stylesheet = [...new JSDOM(built).window.document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.outerHTML).join('');
const temporary = await mkdtemp(path.join(tmpdir(), 'fd-thread-browser-'));
const build = (source, output) => execFileSync('bun', ['build', source, '--target=browser', `--outfile=${temporary}/${output}`, '--define', '__FLIGHT_DECK_PG_APP_NPUB__="npub1fixture"', '--define', 'import.meta.env={"DEV":false}'], { stdio: 'pipe' });
build('scripts/browser-inbox-thread-entry.js', 'probe.js');
let worker = 'thread-worker.js';
if (process.env.FLIGHTDECK_VERIFY_BUILT_WORKER === '1') {
  const entry = built.match(/src="(\/assets\/index-[^"]+\.js)"/)[1];
  worker = (await readFile(path.join(root, entry), 'utf8')).match(/tower-pg-materialization-worker-[\w-]+\.js/)[0];
} else build('src/worker/tower-pg-materialization-worker.js', worker);
const browserType = process.env.FLIGHTDECK_VERIFY_BROWSER === 'chromium' ? chromium : webkit;
const browser = await browserType.launch();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">${stylesheet}<style>body{display:block;padding:20px}.deck-column{height:750px;width:450px;overflow:auto}[x-cloak]{display:none!important}</style></head><body x-data><main class="content-scroll-area">${inbox}</main>${modal}<script type="module" src="/probe.js"></script></body></html>` });
    const file = p === '/probe.js' || p === '/assets/thread-worker.js' ? path.join(temporary, path.basename(p)) : path.resolve(root, `.${p}`);
    if (!file.startsWith(temporary + path.sep) && !file.startsWith(root + path.sep)) return route.abort();
    try { await route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(file) }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  page = await context.newPage();
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto('http://flightdeck-thread.test/');
  await page.waitForFunction(() => typeof window.startThreadProbe === 'function');
  const fixture = JSON.parse(await readFile('tests/fixtures/flightdeck-record-delta-v1.json', 'utf8'));
  const bundle = fixture.canonical_upserts;
  const workspaceId = bundle.changes[0].workspace_id;
  await page.evaluate(async ({ worker, bundle, workspaceId }) => {
    await window.prepareInboxV25(bundle.changes.find(row => row.family === 'message').row);
    // Upgrade the real v25 ownerless row before using the module worker.
    await window.startThreadProbe({ worker, workspaceId });
    await window.materializeThreadProbe(bundle);
  }, { worker, bundle, workspaceId });
  await page.waitForFunction(() => window.probeStore.channels.length > 0);
  await page.evaluate(async ({ bundle }) => {
    const originals = Object.fromEntries(['thread', 'message'].map(family => [family, bundle.changes.find(change => change.family === family)]));
    const channel = window.probeStore.channels[0];
    const changes = [];
    window.threadFixtures = {};
    for (const [id, count] of [['history-a', 241], ['history-b', 151], ['cold-thread', 251]]) {
      const thread = { ...originals.thread.row, id, channel_id: channel.record_id, title: `Conversation ${id}`, source_message_id: `${id}-source`, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z', row_version: 1 };
      const messages = Array.from({ length: count }, (_, n) => ({ ...originals.message.row, client_request_id: null, id: n === 0 ? `${id}-source` : `${id}-${n}`, thread_id: id, channel_id: channel.record_id, body: `${id} reply ${n}`, row_version: 1, created_at: new Date(Date.UTC(2030, 0, 1, 0, n)).toISOString(), updated_at: new Date(Date.UTC(2030, 0, 1, 0, n)).toISOString() }));
      window.threadFixtures[id] = { thread, messages };
      changes.push({ ...originals.thread, id, channel_id: channel.record_id, row: thread });
      if (id !== 'cold-thread') changes.push(...messages.map(row => ({ ...originals.message, id: row.id, channel_id: channel.record_id, row })));
    }
    // More unrelated threads than the Inbox source prefix.
    for (let i = 0; i < 125; i++) {
      const id = `unrelated-${i}`;
      const row = { ...originals.message.row, client_request_id: null, id, thread_id: id, channel_id: channel.record_id, body: `Unrelated ${i}`, updated_at: new Date(Date.UTC(2029, 0, 1, 0, i)).toISOString() };
      changes.push({ ...originals.message, id, channel_id: channel.record_id, row });
    }
    for (let i = 0; i < changes.length; i += 100) await window.materializeThreadProbe({ ...bundle, mode: 'delta', snapshot_id: null, changes: changes.slice(i, i + 100), next_cursor: `thread-probe-${i}` });
    await window.probeDb.chat_messages.toCollection().modify(row => { delete row.owner_npub; });
    window.threadRemote['cold-thread'] = window.threadFixtures['cold-thread'];
    window.probeStore.setDeckInboxType('chat');
  }, { bundle });
  await page.waitForFunction(() => !window.probeStore.inboxActivityLoading && window.probeStore.visibleAutopilotOverviewInbox.some(row => row.id === 'history-a'));
  // Title metadata is not authored content. Read the newest local record while
  // fixture Tower transport is deliberately stalled; measure real Chromium DOM.
  await page.evaluate(async ({ bundle }) => {
    const originalThread = bundle.changes.find(change => change.family === 'thread').row;
    const originalMessage = bundle.changes.find(change => change.family === 'message').row;
    const channelId = window.probeStore.channels[0].record_id;
    const thread = { ...originalThread, id: 'single-content', channel_id: channelId, title: 'Metadata only title', source_message_id: 'single-source', row_version: 1 };
    const message = { ...originalMessage, id: 'single-source', client_request_id: null, thread_id: thread.id, channel_id: channelId, body: 'Latest cached first message', row_version: 1 };
    await window.materializeThreadProbe({ thread_history_page: { channelId, thread, messages: [message], nextCursor: null } });
    await window.probeDb.sync_state.delete('thread-history-page:single-content');
    window.threadRemote[thread.id] = { thread, messages: [message], delay: 3000 };
    window.singleThreadTiming = {};
    const apply = window.probeStore.applyMessages.bind(window.probeStore);
    window.probeStore.applyMessages = (rows, options) => {
      if (rows.some(row => row.record_id === 'single-source')) window.singleThreadTiming.localApplyMs = performance.now() - window.singleThreadTiming.clickAt;
      return apply(rows, options);
    };
  }, { bundle });
  const singleCard = page.locator('.attention-card').filter({ hasText: 'Metadata only title' });
  await singleCard.waitFor();
  assert.match(await singleCard.innerText(), /1 message/);
  await singleCard.evaluate(el => { window.singleThreadTiming.clickAt = performance.now(); el.click(); });
  await page.locator('[data-thread-message-id="single-source"]').waitFor({ state: 'visible' });
  const localFirstEvidence = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { clickToPaintMs: performance.now() - window.singleThreadTiming.clickAt,
      localApplyMs: window.singleThreadTiming.localApplyMs, refreshPending: window.probeStore.threadHistoryLoading,
      bubbles: document.querySelectorAll('[data-thread-message-id]').length };
  });
  assert.equal(localFirstEvidence.bubbles, 1);
  assert.equal(localFirstEvidence.refreshPending, true);
  assert(localFirstEvidence.clickToPaintMs < 1000, JSON.stringify(localFirstEvidence));
  await page.locator('[data-thread-replies]').getByText('Refreshing conversation…', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('[data-thread-replies]').getByText('Loading conversation history…', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(() => window.probeStore.closeDeckThread({ fromRoute: true, syncRoute: false }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const card = page.locator('.attention-card').filter({ hasText: 'Conversation history-a' });
  const selectedChannel = await page.evaluate(() => { const s = window.probeStore; s.selectedChannelId = s.channels.at(-1).record_id; return s.selectedChannelId; });
  await page.locator('[data-deck-column="inbox"]').evaluate(el => { el.style.height = '240px'; el.style.display = 'block'; const body = el.querySelector('.deck-card-scroll'); if (body) { body.style.height = 'auto'; body.style.overflow = 'visible'; } el.scrollTop = 40; });
  await card.evaluate(el => el.click());
  const returnScroll = await page.evaluate(() => window.probeStore.deckThreadReturnContext.deckInboxScrollTop);
  assert(returnScroll > 0);
  await page.waitForFunction(() => window.probeStore.visibleThreadMessages.at(-1)?.body === 'history-a reply 240');
  await page.locator('[data-thread-message-id="history-a-240"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-thread-message-id]').count(), 7);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.chat-thread-modal-backdrop')).opacity === '1');
  await page.screenshot({ path: 'tmp/docs/handoffs/flightdeck-open-thread-recent-browser.png', fullPage: true });
  assert.equal(await page.evaluate(() => window.probeStore.selectedChannelId), selectedChannel);
  await page.getByRole('button', { name: 'Load all messages in thread', exact: true }).click();
  await page.waitForFunction(() => window.probeStore.visibleThreadMessages.length === 240);
  await page.waitForFunction(() => window.probeStore.visibleThreadMessages.some(row => row.body === 'history-a reply 1'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  await page.locator('[data-thread-message-id="history-a-120"]').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const warmScrollOffset = await page.locator('[data-thread-message-id="history-a-120"]').evaluate(el => el.getBoundingClientRect().top);
  await page.evaluate(async () => {
    await window.probeDb.chat_messages.update('history-a-240', { body: 'History edited', version: 2 });
  });
  await page.locator('.chat-thread-modal-backdrop').getByText('History edited', { exact: true }).waitFor();
  await page.evaluate(() => window.probeDb.chat_messages.delete('history-a-240'));
  await page.locator('.chat-thread-modal-backdrop').getByText('History edited', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const { messages } = window.threadFixtures['history-a'];
    await window.materializeThreadProbe({ thread_history_page: { channelId: messages[0].channel_id, thread: window.threadFixtures['history-a'].thread,
      messages: [{ ...messages.at(-1), id: 'live-new-reply', body: 'New live reply', created_at: '2030-02-01T00:00:00Z', updated_at: '2030-02-01T00:00:00Z' }], nextCursor: null } });
  });
  await page.locator('.chat-thread-modal-backdrop').getByText('New live reply', { exact: true }).waitFor();
  await page.waitForFunction(expected => Math.abs(document.querySelector('[data-thread-message-id="history-a-120"]').getBoundingClientRect().top - expected) < 2, warmScrollOffset);
  await page.screenshot({ path: 'tmp/docs/handoffs/flightdeck-open-thread-browser.png', fullPage: true });
  // Real next/previous handlers, including overlapping remote completion.
  await page.evaluate(async () => {
    const rows = ['history-a', 'history-b'].map(id => ({ id, rootRecordId: id, channelId: window.threadFixtures[id].thread.channel_id, inboxKind: 'chat' }));
    window.probeStore.deckThreadNavigationRows = rows;
    await window.probeStore.openAutopilotOverviewThread(rows[0], { preserveNavigationRows: true });
    const next = window.probeStore.navigateDeckThread('older');
    const previous = window.probeStore.navigateDeckThread('newer');
    await Promise.all([next, previous]);
  });
  await page.waitForFunction(() => window.probeStore.activeThreadId === 'history-a' && window.probeStore.visibleThreadMessages.at(-1)?.body === 'New live reply');
  await page.evaluate(() => window.probeStore.closeDeckThread({ fromRoute: true, syncRoute: false }));
  await page.waitForFunction(() => !window.probeStore.activeThreadId);
  assert.deepEqual(await page.evaluate(() => window.probeStore.deckInboxType), ['chat']);
  await page.waitForFunction(expected => Math.abs(document.querySelector('[data-deck-column="inbox"]').scrollTop - expected) < 1, returnScroll);
  assert.equal(await page.evaluate(() => window.probeStore.selectedChannelId), selectedChannel);
  if (process.env.FLIGHTDECK_VERIFY_LOCAL_FIRST_ONLY === '1') {
    const evidence = { localFirstEvidence, warmScrollPreserved: true, warmHistoryCount: 241,
      cachedEditsAndDeletes: true, latestLocalUpdate: true, rapidSwitches: true, inboxReturnScroll: returnScroll,
      browser: browserType.name(), transport: 'fixture with stalled/offline Tower', templates: process.env.FLIGHTDECK_VERIFY_BUILT_WORKER === '1' ? 'built' : 'source', worker, errors };
    assert.equal(errors.length, 0, errors.join('\n'));
    await writeFile('tmp/docs/handoffs/thread-local-first-browser.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
    process.exitCode = 0;
  } else {
  await page.locator('.attention-card').filter({ hasText: 'Conversation cold-thread' }).click();
  await page.waitForFunction(() => !window.probeStore.threadHistoryLoading);
  await page.waitForFunction(() => window.probeStore.threadHistoryCursor === '100');
  await page.locator('[data-thread-message-id="cold-thread-99"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.chat-thread-panel')).opacity === '1');
  await page.waitForTimeout(200);
  await page.locator('[data-thread-replies]').evaluate(async el => {
    el.scrollTop = el.scrollHeight;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const coldAnchorOffset = await page.locator('[data-thread-message-id="cold-thread-99"]').evaluate(el => el.getBoundingClientRect().top);
  // Invoke the visible action without Playwright scrolling to its top-of-history button.
  await page.getByRole('button', { name: 'Load all messages in thread', exact: true }).evaluate(button => button.click());
  await page.waitForFunction(() => !window.probeStore.threadHistoryLoading && !window.probeStore.threadHistoryCursor && window.probeStore.visibleThreadMessages.at(-1)?.body === 'cold-thread reply 250');
  await page.waitForFunction(expected => Math.abs(document.querySelector('[data-thread-message-id="cold-thread-99"]').getBoundingClientRect().top - expected) < 2, coldAnchorOffset);
  const coldMessageCount = await page.evaluate(() => window.probeStore.visibleThreadMessages.length);
  assert.equal(coldMessageCount, 251);
  const coldAnchorDelta = await page.locator('[data-thread-message-id="cold-thread-99"]').evaluate((el, expected) => el.getBoundingClientRect().top - expected, coldAnchorOffset);
  // A fully cached inherited transcript must survive the first partial refresh
  // and a real close/reopen, using the selected production worker and templates.
  await page.evaluate(async ({ bundle }) => {
    const originalThread = bundle.changes.find(change => change.family === 'thread');
    const originalMessage = bundle.changes.find(change => change.family === 'message');
    const channelId = window.probeStore.channels[0].record_id;
    const thread = { ...originalThread.row, id: 'inherited-branch', source_message_id: 'inherited-source', channel_id: channelId,
      parent_thread_id: 'inherited-origin', branch_point_message_id: 'inherited-origin-240', row_version: 1 };
    const messages = Array.from({ length: 241 }, (_, n) => ({ ...originalMessage.row, client_request_id: null, id: `inherited-origin-${n}`, thread_id: 'inherited-origin',
      channel_id: channelId, body: `Inherited reply ${n}`, created_at: new Date(Date.UTC(2031, 0, 1, 0, n)).toISOString(),
      updated_at: new Date(Date.UTC(2031, 0, 1, 0, n)).toISOString(), row_version: 1, inherited: true, read_only: true, effective_thread_id: thread.id }));
    const changes = [{ ...originalThread, id: thread.id, row: thread }, ...messages.map(row => ({ ...originalMessage, id: row.id, row }))];
    for (let i = 0; i < changes.length; i += 100) await window.materializeThreadProbe({ ...bundle, mode: 'delta', snapshot_id: null, changes: changes.slice(i, i + 100), next_cursor: `inherited-${i}` });
    await window.probeDb.chat_messages.update(thread.id, { pg_effective_message_ids: messages.map(row => row.id) });
    window.threadRemote[thread.id] = { thread, messages };
    await window.probeStore.openAutopilotOverviewThread({ id: thread.id, rootRecordId: thread.id, channelId });
  }, { bundle });
  await page.waitForFunction(() => !window.probeStore.threadHistoryLoading && window.probeStore.threadHistoryCursor === '100');
  await page.locator('[data-thread-message-id="inherited-origin-240"]').waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    window.probeStore.closeDeckThread({ fromRoute: true, syncRoute: false });
    await window.probeStore.openAutopilotOverviewThread({ id: 'inherited-branch', rootRecordId: 'inherited-source', channelId: window.probeStore.channels[0].record_id });
  });
  await page.waitForFunction(() => !window.probeStore.threadHistoryLoading && window.probeStore.threadHistoryCursor === '100');
  await page.locator('[data-thread-message-id="inherited-origin-240"]').waitFor({ state: 'visible' });
  const evidence = await page.evaluate(async () => ({
    inheritedReopenLatest: window.probeStore.visibleThreadMessages.at(-1)?.body,
    coldReads: window.threadReads.filter(row => row.threadId === 'cold-thread').map(({ cursor, limit }) => ({ cursor, limit })),
    channels: window.probeStore.channels.length,
    draftPreserved: !!(await window.probeDb.document_drafts.get('upgrade-proof')),
    openThread: window.probeStore.activeThreadId,
  }));
  Object.assign(evidence, { coldMessageCount, coldAnchorDelta, localFirstEvidence });
  assert.deepEqual(evidence.coldReads, [{ cursor: null, limit: 100 }, { cursor: '100', limit: 100 }, { cursor: '200', limit: 100 }]);
  assert(await page.evaluate(async () => !!(await window.probeDb.document_drafts.get('upgrade-proof'))));
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile('tmp/docs/handoffs/flightdeck-open-thread-browser.json', JSON.stringify({ ...evidence, errors, browser: browserType.name(), assetRoot: root, templates: process.env.FLIGHTDECK_VERIFY_BUILT_WORKER === '1' ? 'built' : 'source', store: 'real source with fixture transport', coldCacheLimit: 'Tower oldest-first contract: newest cold reply appears only after explicit forward pages', worker }, null, 2));
  console.log(JSON.stringify(evidence));
  }
} catch (error) {
  console.error('Thread probe failure state', await page?.evaluate(async () => ({
    persisted: await window.probeDb?.sync_state.get('thread-history-page:cold-thread'),
    databaseCount: await window.probeDb?.chat_messages.where('channel_id').equals(window.probeStore.deckThreadChannelId).count(),
    active: window.probeStore?.activeThreadId, nav: window.probeStore?.navSection,
    count: window.probeStore?.threadVisibleReplyCount,
    history: { cursor: window.probeStore?.threadHistoryCursor, error: window.probeStore?.threadHistoryError, loading: window.probeStore?.threadHistoryLoading, all: window.probeStore?.threadHistoryLoadAll, generation: window.probeStore?.threadHistoryGeneration },
    reads: window.threadReads?.map(({threadId, cursor}) => ({threadId, cursor})),
    rows: window.probeStore?.messages?.slice(-3).map(row => [row.record_id, row.body]),
    visible: window.probeStore?.visibleThreadMessages?.slice(-3).map(row => [row.record_id, row.body]),
    modal: document.querySelector('.chat-thread-modal-backdrop')?.getAttribute('style'),
  })));
  await page?.screenshot({ path: 'tmp/docs/handoffs/flightdeck-thread-probe-failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); await rm(temporary, { recursive: true, force: true }); }
