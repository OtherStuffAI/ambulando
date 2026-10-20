const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

const root = path.resolve(__dirname, '../..');

function sliceBalancedDiv(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing markup marker: ${marker}`);
  const start = source.lastIndexOf('<div', markerIndex);
  const tags = /<\/?div\b/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(source); match; match = tags.exec(source)) {
    depth += match[0] === '<div' ? 1 : -1;
    if (depth === 0) return source.slice(start, source.indexOf('>', match.index) + 1);
  }
  throw new Error(`Unbalanced markup for: ${marker}`);
}

async function buildHarness() {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const inboxStart = source.indexOf('<section class="flightdeck-summary-panel flightdeck-summary-panel-inbox');
  const inbox = source.slice(inboxStart, source.indexOf('</section>', inboxStart) + '</section>'.length);
  const modal = sliceBalancedDiv(source, 'class="chat-thread-modal-backdrop"');
  const bundle = await build({
    plugins: [{ name: 'fixture-editor-url', setup(b) {
      b.onResolve({ filter: /^virtual:document-editor-asset$/ }, () => ({ path: 'fixture-editor-url', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: "export default '/unused-editor.js';", loader: 'js' }));
    } }],
    bundle: true, write: false, format: 'esm', logLevel: 'silent', loader: { '.html': 'text' },
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test'), 'import.meta.env': JSON.stringify({ VITE_FLIGHT_DECK_BACKEND_MODE: 'tower-pg' }) },
    stdin: { resolveDir: root, contents: `
      import Alpine from 'alpinejs';
      import {installStableHtml} from './src/stable-html.js';
      import {initApp} from './src/app.js';
      import {openWorkspaceDb,getChannelsByOwner,getRecentChannelActivity} from './src/db.js';
      import {applyPgRecordChanges,recordDeltaCursorKey} from './src/pg-record-delta.js';
      import {normalizeWorkspaceEntry} from './src/workspaces.js';
      window.probe={openWorkspaceDb,getChannelsByOwner,getRecentChannelActivity,applyPgRecordChanges,recordDeltaCursorKey,normalizeWorkspaceEntry};installStableHtml(Alpine);initApp();
    ` },
  });
  return { bundle: bundle.outputFiles[0].text, markup: `${inbox}${modal}` };
}

// A previously viewed thread is fully present in Dexie. Opening it from Home
// must paint the cached title and messages directly; Tower context/history work
// is delayed for the whole test and may only refresh in the background.
test('previously loaded thread opens from cache without an untitled/loading replacement', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  page.on('pageerror', error => console.log('CACHED_THREAD_ERROR', error.message));
  page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) console.log('CACHED_THREAD_CONSOLE', msg.text().slice(0, 300)); });
  const { bundle, markup } = await buildHarness();
  const origin = new URL(baseURL).origin;
  const releases = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/api/delayed') return new Promise(resolve => releases.push(() => route.fulfill({ json: { ok: true } }).then(resolve)));
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>[x-cloak]{display:none!important}</style><script type="module" src="/harness.js"></script><main x-data>${markup}</main>` });
  });

  const threadTitle = 'Cached roadmap thread';
  const setup = async () => {
    await page.goto(`${origin}/fixture`);
    await page.waitForFunction(() => window.probe && window.Alpine?.store('chat'));
    await page.evaluate(async ({ fixture, threadTitle }) => {
      const m = window.probe, s = window.Alpine.store('chat');
      await s.init();
      s.session = { npub: 'reader', method: 'extension' };
      const base = fixture.canonical_upserts.changes;
      const workspace = m.normalizeWorkspaceEntry({ workspaceId: base[0].workspace_id,
        workspaceOwnerNpub: 'owner', workspaceServiceNpub: 'service', towerServiceNpub: 'tower', appNpub: 'flightdeck_pg',
        pgSessionNpub: 'reader', pgBackendMode: true, directHttpsUrl: location.origin, name: 'Cached workspace' });
      s.knownWorkspaces = [workspace]; s.selectedWorkspaceKey = workspace.workspaceKey;
      s.currentWorkspaceOwnerNpub = 'owner'; s.ownerNpub = 'owner'; s.backendUrl = location.origin;
      // Every Tower read (control plane, channel, context and history) stalls.
      const delayed = () => fetch('/api/delayed');
      window.towerRequests = [];
      s.ensureTowerPgControlPlaneHydrated = async () => delayed();
      s.verifyPgWorkspaceForSelection = async candidate => { await delayed(); return candidate; };
      s.refreshWorkspaceSettings = async () => {};
      s.requestTowerSyncFamily = async (family, id) => { window.towerRequests.push(`${family}:${id}`); await delayed(); return { deferred: true }; };
      s.ensureBackgroundSync = () => {}; s.refreshGroups = async () => {};
      s.readStoredTaskBoardId = () => '__all__'; s.readStoredCollapsedSections = () => ({});
      s.applyRouteFromLocation = async () => { s.navSection = 'status'; s.selectedBoardId = '__all__'; s.selectedChannelId = null; s.startWorkspaceLiveQueries(); };
      s.navSection = 'status'; s.selectedBoardId = '__all__'; s.selectedChannelId = null;
      const db = m.openWorkspaceDb(workspace.workspaceKey); await db.open();
      if (!await db.chat_messages.count()) {
        const thread = base.find(row => row.family === 'thread');
        const message = base.find(row => row.family === 'message');
        const seeded = base.filter(row => !['thread', 'message'].includes(row.family));
        seeded.push({ ...thread, row: { ...thread.row, title: threadTitle } });
        for (let index = 0; index < 8; index++) {
          const id = `50000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`;
          seeded.push({ ...message, id, row: { ...message.row, id, thread_id: thread.id,
            body: `Cached reply ${index}`, client_request_id: `cached-reply-${index}`,
            created_at: new Date(Date.parse(message.row.created_at) + index * 60_000).toISOString(),
            updated_at: new Date(Date.parse(message.row.updated_at) + index * 60_000).toISOString() } });
        }
        await m.applyPgRecordChanges(s, { ...fixture.canonical_upserts, changes: seeded }, { expectedCursor: null });
      }
      window.db = db; window.s = s;
      s.channels = await m.getChannelsByOwner('owner');
      s.recentChannelMessages = await m.getRecentChannelActivity('owner');
      window.activation = (async () => {
        await s.selectWorkspace(workspace.workspaceKey, { refresh: false });
        await s.bootstrapSelectedWorkspace();
      })();

    }, { fixture, threadTitle });
  };

  const threadId = fixture.canonical_upserts.changes.find(row => row.family === 'thread').id;
  const channelId = fixture.canonical_upserts.changes.find(row => row.family === 'channel').id;
  // Drive the production Home card handler with the card's cached shape. The
  // cold variant drops Home's downloaded rows so Dexie detail is the only source.
  const openAndTrace = async ({ cold = false, localDelayMs = 0 } = {}) => {
    await page.waitForFunction(() => window.s?.workspaceOwnerNpub && window.s.navSection === 'status');
    await page.evaluate(({ cold, localDelayMs, threadId, channelId, threadTitle }) => {
      if (cold) {
        window.s.fileMessages = [];
        window.s.messages = [];
      }
      if (localDelayMs) {
        const startWorkspaceLiveQueries = window.s.startWorkspaceLiveQueries.bind(window.s);
        window.s.startWorkspaceLiveQueries = () => {
          clearTimeout(window.delayedLocalDetailTimer);
          window.delayedLocalDetailTimer = setTimeout(() => {
            window.s.startWorkspaceLiveQueries = startWorkspaceLiveQueries;
            startWorkspaceLiveQueries();
          }, localDelayMs);
        };
      }
      window.threadFrames = [];
      const sample = () => {
        const panel = document.querySelector('.chat-thread-modal-backdrop');
        const visible = Boolean(panel && getComputedStyle(panel).display !== 'none');
        if (panel) {
          const statuses = [...panel.querySelectorAll('.thread-replies > p[role="status"]')]
            .filter(el => getComputedStyle(el).display !== 'none').map(el => el.textContent.trim());
          window.threadFrames.push({ at: performance.now(), visible, title: panel.querySelector('.thread-title-display')?.textContent?.trim() || '',
            replies: panel.querySelectorAll('[data-thread-reply]').length, statuses,
            store: { loading: window.s.threadHistoryLoading, ready: window.s.threadLocalDetailReady, local: window.s.threadHasLocalContent,
              thread: window.s.threadMessages.length, msgs: window.s.messages.length, channel: window.s.deckThreadChannelState } });
        }
        window.threadFrameRaf = requestAnimationFrame(sample);
      };
      window.threadClickAt = performance.now();
      sample();
      void window.s.openAutopilotOverviewThread({ id: threadId, rootRecordId: threadId, channelId, title: threadTitle, inboxKind: 'chat' });
    }, { cold, localDelayMs, threadId, channelId, threadTitle });
    await expect(page.locator('.thread-title-display')).toHaveText(threadTitle);
    await expect(page.locator('[data-thread-reply]', { hasText: 'Cached reply 7' })).toBeVisible();
    await page.waitForTimeout(1000);
    const result = await page.evaluate(() => {
      cancelAnimationFrame(window.threadFrameRaf);
      const frames = window.threadFrames;
      const ready = frames.find(frame => frame.visible && frame.title && frame.replies > 0);
      return { frames, readyMs: ready ? ready.at - window.threadClickAt : null,
        hiddenPendingFrames: frames.filter(frame => !frame.visible && !frame.store.ready).length };
    });
    await page.evaluate(() => window.s.closeDeckThread({ syncRoute: false, fromRoute: true }));
    await expect(page.locator('.chat-thread-modal-backdrop')).toBeHidden();
    return result;
  };

  try {
    await setup();
    const first = await openAndTrace();
    const cold = await openAndTrace({ cold: true, localDelayMs: 350 });
    // Reload with the same Dexie cache: the thread was loaded before.
    await page.evaluate(() => window.s?.stopAllLiveQueries());
    for (const release of releases.splice(0)) await release();
    await setup();
    const reloaded = await openAndTrace({ cold: true, localDelayMs: 350 });
    // Reopen while a large unrelated catch-up keeps committing to the same
    // Dexie tables, as on the reported device.
    await page.evaluate(async fixture => {
      const sample = fixture.one_message_delta.changes[0];
      let cursor = (await window.db.sync_state.get(window.probe.recordDeltaCursorKey(window.s)))?.value?.cursor || null;
      window.catchupApplied = 0; window.catchupRunning = true;
      window.catchup = (async () => {
        for (let page = 0; page < 20 && window.catchupRunning; page++) {
          const changes = Array.from({ length: 190 }, (_, index) => {
            const n = page * 190 + index;
            const id = `62000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
            const channel = `71000000-0000-4000-8000-${String(page).padStart(12, '0')}`;
            return { ...sample, id, channel_id: channel, version: String(1000 + n), row: { ...sample.row, id, channel_id: channel,
              body: `Historical message ${n}`, client_request_id: `historical-${n}`, row_version: 1000 + n } };
          });
          const next = `catchup-${page}`;
          await window.probe.applyPgRecordChanges(window.s, { ...fixture.one_message_delta, changes, next_cursor: next }, { expectedCursor: cursor });
          cursor = next; window.catchupApplied += changes.length;
        }
      })().catch(error => { window.catchupError = error?.message || String(error); });
    }, fixture);
    await expect.poll(() => page.evaluate(() => window.catchupError || window.catchupApplied)).toBeGreaterThan(0);
    const duringCatchup = await openAndTrace({ cold: true, localDelayMs: 350 });
    const catchup = await page.evaluate(async () => { const applied = window.catchupApplied; window.catchupRunning = false; await window.catchup; return { applied, error: window.catchupError || null }; });
    expect(catchup.error).toBeNull();
    for (const run of [first, cold, reloaded, duringCatchup]) {
      const degraded = run.frames.filter(frame => frame.visible && (frame.title === 'Untitled thread'
        || frame.statuses.some(text => text.startsWith('Loading conversation history'))
        || frame.replies === 0));
      console.log('CACHED_THREAD_FRAMES', JSON.stringify({ readyMs: run.readyMs, frames: run.frames.length,
        degraded: degraded.length, sample: degraded.slice(0, 3) }));
      expect(degraded).toEqual([]);
      expect(run.readyMs).not.toBeNull();
    }
    for (const run of [cold, reloaded, duringCatchup]) expect(run.hiddenPendingFrames).toBeGreaterThan(5);
    console.log('CACHED_THREAD_TIMING', JSON.stringify({ firstReadyMs: Math.round(first.readyMs), coldReadyMs: Math.round(cold.readyMs), reloadReadyMs: Math.round(reloaded.readyMs),
      catchupReadyMs: Math.round(duringCatchup.readyMs), catchupRowsWhileOpening: catchup.applied, networkDelayed: true }));
  } finally {
    await page.evaluate(() => window.s?.stopAllLiveQueries()).catch(() => {});
    for (const release of releases.splice(0)) await release();
  }
});
