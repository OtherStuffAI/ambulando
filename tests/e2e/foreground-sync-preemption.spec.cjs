const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * ratio))] || 0;

test('Inbox paging and cached threads pre-empt a production-scale recovery', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const root = path.resolve(__dirname, '../..');
  const [harness, worker] = await Promise.all([
    build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', loader: { '.html': 'text' },
      define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test'), 'import.meta.env': JSON.stringify({ VITE_FLIGHT_DECK_BACKEND_MODE: 'tower-pg' }) },
      stdin: { resolveDir: root, contents: `
        import Alpine from 'alpinejs'; import {liveQuery} from 'dexie';
        import {openWorkspaceDb} from './src/db.js';
        import {applyPgRecordChanges} from './src/pg-record-delta.js';
        import {materializeAuxiliaryChanges} from './src/pg-priority-sync.js';
        import {syncManagerMixin} from './src/sync-manager.js';
        import {TowerPgMaterializationWorkerClient} from './src/tower-pg-materialization-worker-client.js';
        window.probe={Alpine,liveQuery,openWorkspaceDb,applyPgRecordChanges,materializeAuxiliaryChanges,syncManagerMixin,TowerPgMaterializationWorkerClient};
      ` } }),
    build({ entryPoints: [path.join(root, 'src/worker/tower-pg-materialization-worker.js')], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
      define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test'), 'import.meta.env': JSON.stringify({ VITE_FLIGHT_DECK_BACKEND_MODE: 'tower-pg' }) } }),
  ]);
  const origin = new URL(baseURL).origin;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: harness.outputFiles[0].text });
    if (url.pathname.endsWith('/worker/tower-pg-materialization-worker.js')) return route.fulfill({ contentType: 'text/javascript', body: worker.outputFiles[0].text });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <script type="module" src="/harness.js"></script>
      <main x-data>
        <section data-inbox-page>
          <button data-inbox-previous @click="$store.cache.previousPage()">Previous</button>
          <output data-inbox-page-index x-text="$store.cache.pageIndex + 1"></output>
          <button data-inbox-next @click="$store.cache.nextPage()">Next</button>
          <div data-inbox-rows><template x-for="row in $store.cache.visibleRoots" :key="row.record_id"><span :data-inbox-row="row.record_id" x-text="row.body"></span></template></div>
        </section>
        <nav><template x-for="row in $store.cache.roots" :key="row.record_id"><button :data-thread="row.record_id" @click="$store.cache.open(row.record_id)" x-text="row.body"></button></template></nav>
        <section data-thread-ready x-text="$store.cache.active?.body || ''"></section>
        <textarea data-composer x-model="$store.cache.draft"></textarea>
        <output data-progress x-text="$store.cache.backgroundApplied"></output>
      </main>` });
  });
  await page.goto(`${origin}/fixture`);
  await page.waitForFunction(() => window.probe);
  const results = await page.evaluate(async fixture => {
    const p = window.probe;
    const workspaceDbKey = `foreground-preemption-${crypto.randomUUID()}`;
    const db = p.openWorkspaceDb(workspaceDbKey); await db.open();
    const sample = fixture.one_message_delta.changes[0];
    const workspaceId = sample.workspace_id;
    const channelId = sample.channel_id;
    const cached = Array.from({ length: 24 }, (_, index) => ({
      ...sample,
      id: `51000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      version: String(index + 1),
      row: { ...sample.row, id: `51000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        body: `Cached thread ${index}`, row_version: index + 1,
        updated_at: new Date(Date.parse(sample.row.updated_at) + index * 1000).toISOString() },
    }));
    const storeIdentity = { workspaceOwnerNpub: 'npub1owner', session: { npub: 'npub1viewer' },
      currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner' } };
    await p.applyPgRecordChanges(storeIdentity, { ...fixture.one_message_delta, changes: cached, next_cursor: 'cached-seed' }, { expectedCursor: null });
    const client = new p.TowerPgMaterializationWorkerClient({ workspaceKey: `tower|${workspaceDbKey}|${workspaceId}` });
    const state = p.Alpine.reactive({ roots: [], visibleRoots: [], pageIndex: 0, pageSize: 4, active: null, draft: '', backgroundApplied: 0,
      renderPage() { this.visibleRoots = this.roots.slice(this.pageIndex * this.pageSize, (this.pageIndex + 1) * this.pageSize); },
      nextPage() { this.pageIndex = (this.pageIndex + 1) % Math.ceil(this.roots.length / this.pageSize); this.renderPage(); },
      previousPage() { this.pageIndex = (this.pageIndex + Math.ceil(this.roots.length / this.pageSize) - 1) % Math.ceil(this.roots.length / this.pageSize); this.renderPage(); },
      open(id) { this.active = this.roots.find(row => row.record_id === id) || null; } });
    window.Alpine = p.Alpine; p.Alpine.store('cache', state); p.Alpine.start();
    const governor = {
      markTowerPgForegroundActivity(reason) { client.prioritizeForeground({ durationMs: 1250, reason }); },
    };
    p.syncManagerMixin.ensureTowerPgForegroundActivityGovernor.call(governor);
    const subscription = p.liveQuery(() => db.chat_messages.where('channel_id').equals(channelId).toArray()).subscribe(rows => {
      state.roots = rows.filter(row => row.body?.startsWith('Cached thread')).sort((left, right) => left.updated_at.localeCompare(right.updated_at));
      state.renderPage();
      if (state.active) state.active = state.roots.find(row => row.record_id === state.active.record_id) || state.active;
    });
    await new Promise(resolve => {
      const poll = () => state.roots.length === cached.length ? resolve() : setTimeout(poll, 10);
      poll();
    });
    state.open(cached[0].id);
    const longTasks = [];
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(entry.duration); });
    try { observer.observe({ entryTypes: ['longtask'] }); } catch {}
    const background = Array.from({ length: 12_000 }, (_, index) => {
      const id = `62000000-0000-4000-${(0x8000 + Math.floor(index / 200)).toString(16).padStart(4, '0')}-${String(index).padStart(12, '0')}`;
      const backgroundChannel = `71000000-0000-4000-8000-${String(Math.floor(index / 200)).padStart(12, '0')}`;
      return { ...sample, id, channel_id: backgroundChannel, version: String(1000 + index), row: { ...sample.row,
        id, channel_id: backgroundChannel, body: `Historical message ${index}`, row_version: 1000 + index,
        updated_at: new Date(Date.parse(sample.row.updated_at) - index * 1000).toISOString() } };
    });
    const timings = [];
    const startedAt = performance.now();
    window.catchupDone = (async () => {
      for (let offset = 0; offset < background.length; offset += 200) {
        const result = await p.materializeAuxiliaryChanges(storeIdentity, background.slice(offset, offset + 200), {
          context: { workspaceId },
          materialize: bundle => client.materialize({ workspaceDbKey, store: storeIdentity, bundle }),
        });
        state.backgroundApplied += result.applied || 0;
        if (result.materializationTiming) timings.push(result.materializationTiming);
      }
      return performance.now() - startedAt;
    })();
    let emptyInboxFrames = 0, monitoring = true;
    const monitorInbox = () => {
      if (!monitoring) return;
      if (state.visibleRoots.length && document.querySelectorAll('[data-inbox-rows] [data-inbox-row]').length === 0) emptyInboxFrames++;
      requestAnimationFrame(monitorInbox);
    };
    requestAnimationFrame(monitorInbox);
    window.testState = { state, cached, client, governor, subscription, observer, longTasks, timings, startedAt,
      get emptyInboxFrames() { return emptyInboxFrames; }, stopMonitoring() { monitoring = false; } };
    return { cachedIds: cached.map(row => row.id) };
  }, fixture);

  await expect.poll(() => page.locator('[data-progress]').textContent()).not.toBe('12000');
  const inboxLatencies = [];
  for (let index = 0; index < 30; index++) {
    const expectedPage = (index + 1) % 6;
    const startedAt = performance.now();
    await page.locator('[data-inbox-next]').click();
    await expect(page.locator('[data-inbox-page-index]')).toHaveText(String(expectedPage + 1));
    await expect(page.locator('[data-inbox-rows] [data-inbox-row]')).toHaveCount(4);
    inboxLatencies.push(performance.now() - startedAt);
  }
  const pausedAt = await page.locator('[data-progress]').textContent();
  await page.waitForTimeout(200);
  await expect(page.locator('[data-progress]')).toHaveText(pausedAt);
  const threadLatencies = [];
  for (let index = 0; index < 30; index++) {
    const id = results.cachedIds[index % results.cachedIds.length];
    const startedAt = performance.now();
    await page.locator(`[data-thread="${id}"]`).click();
    await expect(page.locator('[data-thread-ready]')).toHaveText(`Cached thread ${index % results.cachedIds.length}`);
    threadLatencies.push(performance.now() - startedAt);
  }
  const inputLatencies = [];
  for (const character of 'foreground typing remains exact') {
    const startedAt = performance.now();
    await page.locator('[data-composer]').press(character === ' ' ? 'Space' : character);
    inputLatencies.push(performance.now() - startedAt);
  }
  const backgroundMs = await page.evaluate(() => window.catchupDone);
  const metrics = await page.evaluate(() => {
    const t = window.testState;
    t.stopMonitoring(); t.observer.disconnect(); t.subscription.unsubscribe();
    window.probe.syncManagerMixin.disposeTowerPgForegroundActivityGovernor.call(t.governor);
    t.client.dispose('test-complete');
    return { applied: t.state.backgroundApplied, draft: t.state.draft, longTasks: t.longTasks,
      emptyInboxFrames: t.emptyInboxFrames,
      maxTransactionMs: Math.max(0, ...t.timings.map(row => row.maxTransactionMs || 0)),
      transactionCount: t.timings.reduce((sum, row) => sum + (row.transactionCount || 0), 0),
      foregroundWaitMs: t.timings.reduce((sum, row) => sum + (row.foregroundWaitMs || 0), 0) };
  });
  const report = {
    rows: metrics.applied,
    backgroundMs: Math.round(backgroundMs),
    throughputRowsPerSecond: Math.round(metrics.applied / (backgroundMs / 1000)),
    threadReadyP95Ms: Number(percentile(threadLatencies, 0.95).toFixed(1)),
    inboxPageReadyP95Ms: Number(percentile(inboxLatencies, 0.95).toFixed(1)),
    inputP95Ms: Number(percentile(inputLatencies, 0.95).toFixed(1)),
    maxLongTaskMs: Number(Math.max(0, ...metrics.longTasks).toFixed(1)),
    maxTransactionMs: Number(metrics.maxTransactionMs.toFixed(1)),
    transactionCount: metrics.transactionCount,
    foregroundWaitMs: Math.round(metrics.foregroundWaitMs),
  };
  console.log('FOREGROUND_SYNC_TIMING', JSON.stringify(report));
  expect(metrics.applied).toBe(12_000);
  expect(metrics.draft).toBe('foreground typing remains exact');
  expect(metrics.emptyInboxFrames).toBe(0);
  expect(report.inboxPageReadyP95Ms).toBeLessThan(250);
  expect(report.threadReadyP95Ms).toBeLessThan(250);
  expect(report.inputP95Ms).toBeLessThan(100);
  expect(report.maxLongTaskMs).toBeLessThan(200);
  expect(report.maxTransactionMs).toBeLessThan(150);
  expect(report.foregroundWaitMs).toBeGreaterThan(0);
  expect(report.throughputRowsPerSecond).toBeGreaterThan(250);
});
