const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

// Isolated local contract fixture: real requests, service, materializer worker,
// IndexedDB, liveQuery and Alpine. No live workspace or signing credentials.
for (const protocol of [1, 2]) test(`v${protocol}: two caches retain UI and intent through additive channel, catchup, reconnect and access loss`, async ({ browser, baseURL }) => {
  const root = path.resolve(__dirname, '../..');
  const opts = { bundle: true, write: false, format: 'esm', logLevel: 'silent', loader: { '.html': 'text' }, define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') } };
  const [worker, harness] = await Promise.all([
    build({ ...opts, entryPoints: [path.join(root, 'src/worker/tower-pg-materialization-worker.js')] }),
    build({ ...opts, stdin: { resolveDir: root, contents: `
      import Alpine from 'alpinejs'; import {liveQuery} from 'dexie';
      import {openWorkspaceDb} from './src/db.js';
      import {TowerSyncService} from './src/tower-sync-service.js';
      import {TowerPgMaterializationWorkerClient} from './src/tower-pg-materialization-worker-client.js';
      import {syncTowerPgWorkspace,resolveTowerPgWorkspaceContext} from './src/pg-read-hydrator.js';
      import {syncDeviceRecords} from './src/pg-device-checkpoints.js';
      import {recordDeltaCursorKey} from './src/pg-record-delta.js';
      import {readPgNavigationProjection,applyPgNavigationProjection} from './src/section-live-queries.js';
      import {projectPgDownloadedAccess} from './src/pg-access-state.js';
      window.probe={Alpine,liveQuery,openWorkspaceDb,TowerSyncService,TowerPgMaterializationWorkerClient,syncTowerPgWorkspace,resolveTowerPgWorkspaceContext,syncDeviceRecords,recordDeltaCursorKey,readPgNavigationProjection,applyPgNavigationProjection,projectPgDownloadedAccess};
    ` } }),
  ]);
  const origin = new URL(baseURL).origin, contexts = [], clients = [];
  try {
    for (let n = 0; n < 2; n++) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(), requests = [], serverClients = new Map();
      const queue = [], ackFault = { once: false };
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.endsWith('harness.js')) return route.fulfill({ contentType: 'text/javascript', body: harness.outputFiles[0].text });
        if (url.pathname.endsWith('worker.js')) return route.fulfill({ contentType: 'text/javascript', body: worker.outputFiles[0].text });
        if (url.pathname.startsWith('/api/')) {
          requests.push({ path: url.pathname, cursor: url.searchParams.get('cursor'), method: route.request().method() });
          const clientId = url.pathname.match(/clients\/([^/]+)/)?.[1];
          if (clientId) {
            let c = serverClients.get(clientId);
            if (!c) { c = { cursor: null, revision: 0 }; serverClients.set(clientId, c); }
            if (url.pathname.endsWith('/ack')) {
              const body = route.request().postDataJSON(); if (c.cursor !== body.cursor) { c.cursor = body.cursor; c.revision++; }
              if (ackFault.once) { ackFault.once = false; return route.abort(); }
            }
            return route.fulfill({ json: { protocol_version: 2, client_id: clientId, authority_epoch: 'stable-epoch', initial_cursor: `initial:${clientId}`, checkpoint_cursor: c.cursor, checkpoint_revision: String(c.revision) } });
          }
          const next = queue.shift();
          if (!next) return route.fulfill({ status: 500, json: { error: 'unexpected unrelated request' } });
          if (next.error) return route.fulfill({ status: next.status || 503, json: { code: next.error, identity: { workspace_id: fixture.one_message_delta.changes[0].workspace_id } } });
          Object.assign(requests.at(-1), { mode: next.mode, changedFamilies: next.changes.map(c => c.family), changedIds: next.changes.map(c => c.id), bytes: Buffer.byteLength(JSON.stringify(next)) });
          const id = url.searchParams.get('client_id');
          return route.fulfill({ json: { ...next, protocol_version: protocol, ...(id ? { client_id: id, checkpoint_revision: String(serverClients.get(id).revision) } : {}) } });
        }
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script type="module" src="/harness.js"></script><main x-data><nav x-text="$store.cache.selectedChannelId"></nav><textarea aria-label="Retained editor" x-model="$store.cache.messageInput"></textarea><div id="history" style="height:120px;overflow:auto"><div style="height:1000px"><template x-for="row in $store.cache.messages" :key="row.record_id"><p x-text="row.body"></p></template></div></div><output x-text="$store.cache.accessLost ? 'Access lost; retained download' : 'Current'"></output></main>` });
      });
      await page.goto(`${origin}/fixture`); await page.waitForFunction(() => window.probe);
      await page.evaluate(async ({ fixture, origin, protocol }) => {
        const m = window.probe, key = `additive-browser-${crypto.randomUUID()}`;
        const db = m.openWorkspaceDb(key); await db.open();
        const channelId = fixture.one_message_delta.changes[0].channel_id;
        const store = m.Alpine.reactive({ workspaceOwnerNpub: 'owner', currentWorkspaceKey: key, workspaceDbKey: key, _workspaceSelectionGeneration: 1,
          backendUrl: origin, session: { npub: 'fixture-reader' }, currentWorkspace: { workspaceId: fixture.one_message_delta.changes[0].workspace_id, workspaceOwnerNpub: 'owner', pgBackendMode: true },
          selectedChannelId: channelId, selectedBoardId: 'all', activeThreadId: 'fixture-thread', navSection: 'chat', messageInput: 'unsent editor text', threadInput: 'unsent reply', messages: [], scopes: [], channels: [],
          async applyScopes(rows) { this.scopes = rows; }, async applyChannels(rows) { this.channels = rows; }, validateSelectedBoardId() {},
        });
        window.Alpine = m.Alpine; m.Alpine.store('cache', store); m.Alpine.start();
        const context = m.resolveTowerPgWorkspaceContext(store), cursorKey = m.recordDeltaCursorKey(store);
        let materializer;
        const start = () => { materializer = new m.TowerPgMaterializationWorkerClient({ workspaceKey: key, workerFactory: () => new Worker('/worker.js', { type: 'module' }) }); };
        start();
        const apply = bundle => materializer.materialize({ workspaceDbKey: key, store: JSON.parse(JSON.stringify({ session: store.session, backendUrl: origin, currentWorkspace: store.currentWorkspace })), bundle });
        const state = async () => (await db.sync_state.get(cursorKey))?.value;
        const json = async (url, init) => { const response = await fetch(url, init), body = await response.json(); if (!response.ok) throw Object.assign(Error(body.code || body.error), { status: response.status, code: body.code, payload: body }); return body; };
        const base = `${origin}/api/v4/flightdeck-pg/workspaces/${context.workspaceId}/record-sync`;
        const readPage = (_workspace, options) => json(`${base}?protocol_version=${protocol}&cursor=${encodeURIComponent(options.cursor || '')}${options.clientId ? '&client_id=' + options.clientId : ''}`);
        const client = async (_workspace, id, options) => {
          if (options.operation === 'ack') { const local = await state(); if (local.cursor !== options.cursor || local.device.pendingAck.cursor !== options.cursor) throw Error('ack before durable commit'); }
          return json(`${base}/clients/${id}${options.operation === 'ack' ? '/ack' : ''}`, { method: options.operation === 'read' ? 'GET' : options.operation === 'retire' ? 'DELETE' : 'POST', ...(options.operation === 'ack' ? { body: JSON.stringify({ cursor: options.cursor, expected_revision: options.expectedRevision }) } : {}) });
        };
        const service = new m.TowerSyncService({ workspaceKey: key, ports: { recoverCursor: () => protocol === 2
          ? m.syncDeviceRecords({ context, cursorKey, options: {}, readState: state, materialize: apply, readPage, client, assertCurrent() {} })
          : m.syncTowerPgWorkspace(store, {}, { getTowerPgRecordSync: readPage, hydrateTowerPgSyncBundle: (_s, b) => apply(b), getTowerPgResourceViewStates: async () => ({ states: [] }), getTowerPgWorkspaceMembers: async () => ({ members: [] }), getTowerPgWorkspaceGroups: async () => ({ groups: [] }) }) } });
        const sub = m.liveQuery(async () => ({ navigation: await m.readPgNavigationProjection(store), messages: m.projectPgDownloadedAccess(await db.chat_messages.toArray(), await state()) })).subscribe(async result => { await m.applyPgNavigationProjection(store, result.navigation); store.accessLost = result.navigation.accessLost; store.messages = result.messages; });
        window.run = () => service.recoverCursor();
        window.snapshot = async () => ({ state: await state(), counts: await Promise.all(['pg_record_rows','chat_messages','documents','tasks','channels'].map(name => db.table(name).count())), outbox: await db.pending_writes.toArray(), drafts: await db.document_drafts.toArray(), unrelatedContent: JSON.stringify(await Promise.all(['chat_messages','documents','tasks'].map(name => db.table(name).toArray()))), selection: store.selectedChannelId, thread: store.activeThreadId, editor: store.messageInput, reply: store.threadInput, scroll: document.querySelector('#history').scrollTop, messages: store.messages });
        window.seedIntent = async () => { store.selectedChannelId = channelId; store.activeThreadId = 'fixture-thread'; store.messageInput = 'unsent editor text'; store.threadInput = 'unsent reply'; await db.pending_writes.add({ record_id: 'pending-local', envelope: { body: 'retained intent' } }); await db.document_drafts.put({ draft_key: 'draft', workspace_id: context.workspaceId, document_id: 'doc', content: 'retained document draft' }); document.querySelector('#history').scrollTop = 333; };
        window.restartWorker = () => { materializer.dispose(); start(); };
        window.cleanup = () => { sub.unsubscribe(); materializer.dispose(); service.dispose(); db.close(); };
      }, { fixture, origin, protocol });
      const wire = (changes, cursor, extra = {}) => ({ ...fixture.one_message_delta, changes, next_cursor: cursor, has_more: false, access_revision: '1', access_changes: [], retention_policy: 'retain_downloaded', ...extra });
      if (protocol === 2) queue.push({ ...fixture.canonical_upserts, next_cursor: 'snapshot-end', access_revision: '1', access_changes: [], retention_policy: 'retain_downloaded' }, wire([], 'seed'));
      else queue.push(wire(fixture.canonical_upserts.changes, 'seed'));
      await page.evaluate(() => window.run()); await page.waitForFunction(() => window.Alpine.store('cache').messages.length > 0);
      await page.evaluate(() => window.seedIntent());
      clients.push({ page, queue, requests, ackFault, wire });
    }
    const baseline = await Promise.all(clients.map(c => c.page.evaluate(() => window.snapshot())));
    const channel = fixture.canonical_upserts.changes.find(c => c.family === 'channel');
    for (const [i, c] of clients.entries()) {
      c.requests.length = 0;
      c.queue.push(c.wire([{ ...channel, id: 'new-empty-channel', row: { ...channel.row, id: 'new-empty-channel', name: 'New empty channel' } }], 'channel-added'));
      await c.page.evaluate(() => window.run());
      const after = await c.page.evaluate(() => window.snapshot());
      expect(after.counts).toEqual(baseline[i].counts.map((count, index) => count + ([0,4].includes(index) ? 1 : 0)));
      expect(after.editor).toBe(baseline[i].editor); expect(after.selection).toBe(baseline[i].selection); expect(after.thread).toBe(baseline[i].thread); expect(after.scroll).toBe(333); expect(after.outbox).toEqual(baseline[i].outbox); expect(after.drafts).toEqual(baseline[i].drafts); expect(after.unrelatedContent).toBe(baseline[i].unrelatedContent);
      expect(after.state.localGeneration || 0).toBe(baseline[i].state.localGeneration || 0);
      if (protocol === 2) expect(after.state.device.clientId).toBe(baseline[i].state.device.clientId);
      expect(c.requests.filter(r => r.path.endsWith('/record-sync'))).toHaveLength(1);
      expect(c.requests.every(r => r.path.includes('/record-sync'))).toBe(true);
      expect(c.requests.filter(r => r.path.endsWith('/record-sync'))[0]).toMatchObject({ cursor: 'seed', mode: 'delta', changedFamilies: ['channel'], changedIds: ['new-empty-channel'] });
    }
    const c = clients[1], message = fixture.one_message_delta.changes[0];
    const older = { ...message, id: 'newly-granted-older-history', version: '1', row: { ...message.row, id: 'newly-granted-older-history', body: 'Old newly authorized history', created_at: '2020-01-01T00:00:00Z' } };
    c.queue.push({ error: 'interrupted', status: 503 }); await expect(c.page.evaluate(() => window.run())).rejects.toThrow();
    await c.page.evaluate(() => window.restartWorker());
    c.queue.push(c.wire([older], 'catchup-page', { has_more: true, catchup: { family: 'message', resource_type: 'channel', resource_id: message.channel_id }, access_revision: '2', access_changes: [{ family: 'message', resource_type: 'channel', resource_id: message.channel_id, status: 'granted' }] }), c.wire([], 'caught-up', { access_revision: '2' }));
    if (protocol === 2) c.ackFault.once = true;
    else c.queue.splice(1, 0, { error: 'paging interrupted', status: 503 });
    await expect(c.page.evaluate(() => window.run())).rejects.toThrow();
    const interrupted = await c.page.evaluate(() => window.snapshot());
    expect(interrupted.state.cursor).toBe('catchup-page');
    await c.page.evaluate(() => window.restartWorker());
    await c.page.evaluate(() => window.run());
    expect((await c.page.evaluate(() => window.snapshot())).counts[1]).toBe(baseline[1].counts[1] + 1);
    c.queue.push(c.wire([], 'lost', { access_revision: '3', access_changes: [{ family: 'message', resource_type: 'channel', resource_id: message.channel_id, status: 'lost' }] }));
    await c.page.evaluate(() => window.run());
    await c.page.waitForFunction(() => window.Alpine.store('cache').messages.some(row => row.pg_access_status === 'access-lost'));
    c.queue.push({ error: 'workspace_membership_required', status: 403 }); await expect(c.page.evaluate(() => window.run())).rejects.toThrow();
    await expect(c.page.locator('output')).toHaveText('Access lost; retained download');
    const lost = await c.page.evaluate(() => window.snapshot());
    expect(lost.editor).toBe(baseline[1].editor); expect(lost.outbox).toEqual(baseline[1].outbox); expect(lost.drafts).toEqual(baseline[1].drafts); expect(lost.scroll).toBe(333);
    expect(lost.state.cursor).toBe('lost'); expect(lost.state.localGeneration || 0).toBe(baseline[1].state.localGeneration || 0);
    expect((await clients[0].page.evaluate(() => window.snapshot())).messages.some(row => row.record_id === older.id)).toBe(false);
    c.queue.push(c.wire([{ ...older, version: '99', operation: 'delete', row: null }], 'deleted', { access_revision: '3' }));
    await c.page.evaluate(() => window.run());
    expect((await c.page.evaluate(() => window.snapshot())).counts[1]).toBe(baseline[1].counts[1]);
    await test.info().attach('request-evidence', { body: JSON.stringify(clients.map(c => c.requests), null, 2), contentType: 'application/json' });
  } finally { for (const c of clients) await c.page.evaluate(() => window.cleanup()).catch(() => {}); for (const c of contexts) await c.close(); }
});
