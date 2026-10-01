const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

// Execute the real materialization worker and IndexedDB at a loopback origin.
// All probe URLs are fulfilled in memory; this never contacts a Tower or
// starts a second app runtime.
test('progressively publishes eight bounded PG pages in the real worker without losing transaction authority', async ({ page, baseURL }) => {
  const workerBundle = await build({
    entryPoints: [path.resolve(__dirname, '../../src/worker/tower-pg-materialization-worker.js')],
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') },
  });
  const origin = new URL(baseURL).origin;
  await page.route(`${origin}/__pg-console-probe`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PG transaction probe</title>' }));
  await page.route(`${origin}/__pg-console-worker.js`, route => route.fulfill({ contentType: 'text/javascript', body: workerBundle.outputFiles[0].text }));
  await page.goto(`${origin}/__pg-console-probe`);
  const result = await page.evaluate(async ({ fixture, origin }) => {
    const worker = new Worker(`${origin}/__pg-console-worker.js`, { type: 'module' });
    let id = 0;
    const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
    const store = { session: { npub: 'npub1viewer' }, backendUrl: 'http://127.0.0.1:3100',
      currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner', appNpub: 'npub1test', pgBackendMode: true } };
    const workspaceKey = `transaction-probe-${crypto.randomUUID()}`;
    const send = bundle => new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.ok ? resolve(data.value) : reject(new Error(JSON.stringify(data.error)));
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ type: 'tower-pg-materializer:request', id: ++id, workspaceKey,
        workspaceDbKey: workspaceKey, store, bundle });
    });
    try {
      let cursor = null;
      for (let index = 0; index < 8; index++) {
        const changes = Array.from({ length: 200 }, (_, offset) => {
          const change = fixture.one_message_delta.changes[0];
          const messageId = `message-${index}-${offset}`;
          return { ...change, id: messageId, row: { ...change.row, id: messageId } };
        });
        const page = await send({ ...fixture.canonical_upserts, actors: [], changes,
          next_cursor: `snapshot-${index}`, has_more: true, snapshot_complete: index === 7,
          local_apply_options: { incrementalSnapshot: true, expectedCursor: cursor, expectedGeneration: 0 } });
        if (page.applied !== 200) throw new Error('Snapshot page did not publish progressively');
        cursor = page.cursor;
      }
      const published = await send({ ...fixture.one_message_delta, changes: [], next_cursor: 'handover', has_more: false,
        local_apply_options: { incrementalSnapshot: true, expectedCursor: cursor, expectedGeneration: 0 } });
      const replay = await send({ ...fixture.one_message_delta, changes: [], next_cursor: 'handover', has_more: false,
        local_apply_options: { expectedCursor: 'handover', expectedGeneration: 0 } });
      return { published, replay };
    } finally {
      worker.terminate();
      indexedDB.deleteDatabase(`wingman-fd-ws-${workspaceKey}`);
    }
  }, { fixture, origin });
  expect(result.published).toMatchObject({ applied: 0, cursor: 'handover', hasMore: false });
  expect(result.replay).toMatchObject({ applied: 0, cursor: 'handover' });
});

test('retains a seeded cache through paged delta, interrupted 85-page replacement and confirmed deletion', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const workerBundle = await build({
    entryPoints: [path.resolve(__dirname, '../../src/worker/tower-pg-materialization-worker.js')],
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') },
  });
  const origin = new URL(baseURL).origin;
  await page.route(`${origin}/__pg-cache-probe`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Seeded cache probe</title>' }));
  await page.route(`${origin}/__pg-cache-worker.js`, route => route.fulfill({ contentType: 'text/javascript', body: workerBundle.outputFiles[0].text }));
  await page.goto(`${origin}/__pg-cache-probe`);
  const result = await page.evaluate(async ({ fixture, origin }) => {
    const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
    const store = { session: { npub: 'npub1viewer' }, currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner' } };
    const workspaceKey = `cache-probe-${crypto.randomUUID()}`;
    let worker, id = 0, db;
    const start = () => { worker = new Worker(`${origin}/__pg-cache-worker.js`, { type: 'module' }); };
    const send = bundle => new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.ok ? resolve(data.value) : reject(new Error(JSON.stringify(data.error)));
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ type: 'tower-pg-materializer:request', id: ++id, workspaceKey, workspaceDbKey: workspaceKey, store, bundle });
    });
    const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
    const counts = async () => {
      const tx = db.transaction(['scopes', 'channels', 'chat_messages'], 'readonly');
      return Promise.all(['scopes', 'channels', 'chat_messages'].map(name => request(tx.objectStore(name).count())));
    };
    const visible = async () => { const values = await counts(); if (values.some(n => n === 0)) throw new Error(`Cache erased: ${values}`); return values; };
    const delta = (cursor, hasMore = false, changes = []) => ({ ...fixture.one_message_delta, next_cursor: cursor, has_more: hasMore, changes });
    start();
    try {
      await send({ ...fixture.canonical_upserts, has_more: true, local_apply_options: { incrementalSnapshot: true } });
      await send(delta('seeded'));
      db = await request(indexedDB.open(`wingman-fd-ws-${workspaceKey}`));
      const seeded = await visible();
      // Reproduce typed view replacement independently of the canonical journal.
      const tx = db.transaction(['scopes', 'channels', 'chat_messages'], 'readwrite');
      const committed = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      for (const name of ['scopes', 'channels', 'chat_messages']) {
        const table = tx.objectStore(name);
        const cursorRequest = table.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const row = cursor.value;
          delete row.pg_delta_generation; delete row.pg_delta_family;
          cursor.update(row); cursor.continue();
        };
      }
      await committed;
      await send(delta('catchup', true)); await visible();
      // Interrupt ordinary catch-up and resume with the same persistent authority.
      worker.terminate(); start();
      await send(delta('caught-up')); await visible();
      await send({ protocol_version: 1, reset_authority: true, local_apply_options: { preserveViews: true } });
      await visible();
      for (let index = 0; index < 85; index++) {
        const changes = index === 0 ? fixture.canonical_upserts.changes : Array.from({ length: 200 }, (_, offset) => {
          const change = fixture.one_message_delta.changes[0];
          const messageId = `replacement-${index}-${offset}`;
          return { ...change, id: messageId, row: { ...change.row, id: messageId } };
        });
        await send({ ...fixture.canonical_upserts, snapshot_id: 'replacement-generation', actors: [], changes, next_cursor: `replacement-${index}`, has_more: true,
          snapshot_complete: index === 84, local_apply_options: { incrementalSnapshot: true } });
        await visible();
        if (index === 40 || index === 84) { worker.terminate(); start(); }
      }
      const published = await send(delta('replacement-handover'));
      const replaced = await visible();
      await send(delta('deleted', false, fixture.explicit_delete.changes));
      const deleted = await counts();
      // Confirmed authorized empty replacement retires omissions at handover only.
      await send({ protocol_version: 1, reset_authority: true, local_apply_options: { preserveViews: true } });
      await send({ ...fixture.canonical_upserts, snapshot_id: 'empty-generation', changes: [], next_cursor: 'empty-snapshot', has_more: true,
        local_apply_options: { incrementalSnapshot: true } });
      await visible();
      await send(delta('empty-handover'));
      return { seeded, replaced, deleted, retired: await counts(), applied: published.applied };
    } finally {
      worker.terminate(); db?.close(); indexedDB.deleteDatabase(`wingman-fd-ws-${workspaceKey}`);
    }
  }, { fixture, origin });
  expect(result.seeded).toEqual([1, 1, 2]);
  expect(result.replaced).toEqual([1, 1, 16802]);
  expect(result.deleted).toEqual([1, 1, 16801]);
  expect(result.retired).toEqual([0, 0, 0]);
  console.log('Seeded canonical cache lifecycle:', JSON.stringify(result));
});

test('recovers an existing canonical cache through typed reads, interrupted replacement and repeated multi-page catchup', async ({ page, baseURL }) => {
  const root = path.resolve(__dirname, '../..');
  const options = { bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') } };
  const worker = await build({ ...options, entryPoints: [path.join(root, 'src/worker/tower-pg-materialization-worker.js')] });
  const main = await build({ ...options, stdin: { resolveDir: root, contents: `
    export { openWorkspaceDb, replacePgMessagesForChannel } from './src/db.js';
    export { recordDeltaCursorKey } from './src/pg-record-delta.js';
    export { syncTowerPgWorkspace, hydrateTowerPgScopes, hydrateTowerPgChannels, hydrateTowerPgEventUpdates, hydrateTowerPgChannelMessages } from './src/pg-read-hydrator.js';
    export { TowerPgMaterializationWorkerClient } from './src/tower-pg-materialization-worker-client.js';
    export { syncManagerMixin } from './src/sync-manager.js';
    export { default as Alpine } from 'alpinejs';
    export { resolvePgReaderActorId } from './src/pg-reader-identity.js';` } });
  const origin = new URL(baseURL).origin;
  await page.route(`${origin}/__canonical/**`, route => {
    const url = route.request().url();
    return route.fulfill({ contentType: url.endsWith('.js') ? 'text/javascript' : 'text/html',
      body: url.endsWith('worker.js') ? worker.outputFiles[0].text : url.endsWith('main.js') ? main.outputFiles[0].text : '<title>Canonical lifecycle</title>' });
  });
  await page.goto(`${origin}/__canonical/index`);
  const result = await page.evaluate(async fixture => {
    const m = await import('/__canonical/main.js');
    const key = `canonical-lifecycle-${crypto.randomUUID()}`; let db = m.openWorkspaceDb(key);
    await db.open();
    const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
    const proxy = value => m.Alpine.reactive(value);
    const store = proxy({ backendUrl: 'http://127.0.0.1:3100', session: { npub: 'npub1viewer' },
      currentWorkspace: proxy({ workspaceId, workspaceOwnerNpub: 'npub1owner', appNpub: 'npub1test', pgBackendMode: true,
        pgMe: proxy({ actor: proxy({ actor_id: 'viewer-actor', npub: 'npub1viewer' }), identity: proxy({ workspace_id: workspaceId }), permissions: proxy(['workspace.read', 'channel.read']) }) }),
      workspaceHarnessAgents: proxy([proxy({ agent_npub: 'npub1agent', url: 'https://agent.example' })]) });
    const snapshotStore = () => m.syncManagerMixin.buildTowerPgMaterializationStoreSnapshot.call(store);
    let client;
    const start = () => { client = new m.TowerPgMaterializationWorkerClient({ workspaceKey: key,
      workerFactory: () => new Worker('/__canonical/worker.js', { type: 'module' }) }); };
    const apply = bundle => client.materialize({ workspaceDbKey: key, store: snapshotStore(), bundle });
    const state = () => db.sync_state.get(m.recordDeltaCursorKey(store)).then(row => row?.value);
    const counts = () => Promise.all(['scopes', 'channels', 'chat_messages'].map(name => db.table(name).count()));
    const delta = (cursor, more = false) => ({ ...fixture.one_message_delta, changes: [], next_cursor: cursor, has_more: more });
    start(); const started = performance.now();
    try {
      await apply(fixture.canonical_upserts); await apply(delta('seeded'));
      await db.chat_messages.put({ record_id: 'unsent-draft', channel_id: fixture.one_message_delta.changes[0].channel_id, body: 'keep local intent', sync_status: 'pending' });
      await db.pending_writes.add({ record_id: 'unsent-draft', envelope: { body: 'keep local intent' } });
      const feed = { schema_version: 1, id: 'subscription-1', workspace_id: workspaceId, reader_actor_id: 'viewer-actor', row_version: 1,
        status: 'active', source: { kind: 'public', url: 'https://feed.example/feed.json', format: 'json' } };
      await m.hydrateTowerPgEventUpdates(store, [{ entity_type: 'feed_subscription', payload: feed }]);
      await db.feed_items.put({ key: 'cached-feed-body', context: 'fixture', subscription_id: feed.id, title: 'Retained source history' });
      const before = await counts(), cached = await state();
      // A real old cache with erased projections and retained canonical versions.
      delete cached.snapshotReconciliationPending;
      await db.sync_state.put({ key: m.recordDeltaCursorKey(store), value: cached });
      await db.scopes.clear();
      const c = fixture.one_message_delta.changes[0], local = await db.chat_messages.get(c.id);
      await db.pg_record_conflicts.put({ key: `message:${c.id}`, family: 'message', record_id: c.id, local, reason: 'unresolved_local_command' });
      const replacement = [
        { ...fixture.canonical_upserts, changes: [], snapshot_complete: false, next_cursor: 'repair-1' },
        { ...fixture.canonical_upserts, changes: [], snapshot_complete: false, next_cursor: 'repair-2' },
        { ...fixture.canonical_upserts, next_cursor: 'repair-3' }, delta('repaired') ];
      const requests = [], timings = [], progress = [];
      let interrupt = true, expired = false;
      const deps = { hydrateTowerPgSyncBundle: (_store, bundle) => apply(bundle),
        getTowerPgResourceViewStates: async () => ({ states: [] }),
        getTowerPgWorkspaceMembers: async () => ({ members: [] }), getTowerPgWorkspaceGroups: async () => ({ groups: [] }),
        getTowerPgRecordSync: async (_id, options) => {
          requests.push(options.cursor);
          if (expired && options.cursor === 'repaired') {
            expired = false; throw Object.assign(new Error('reset_required'), { status: 409, responseText: JSON.stringify({ code: 'reset_required' }) });
          }
          if (interrupt && options.cursor === 'repair-2') throw Object.assign(new Error('interrupted'), { status: 503 });
          const index = options.cursor ? replacement.findIndex(p => p.next_cursor === options.cursor) + 1 : 0;
          return replacement[index];
        } };
      try { await m.syncTowerPgWorkspace(store, { onProgress: p => progress.push(p.stage) }, deps); throw new Error('missing interruption'); }
      catch (error) { if (error.message !== 'interrupted') throw error; }
      if ((await state()).cursor !== 'repair-2') throw new Error('lost interrupted cursor');
      client.dispose(); start(); interrupt = false;
      await m.syncTowerPgWorkspace(store, {}, deps);
      if ((await counts()).join() !== before.join() || await db.pg_record_conflicts.count()) throw new Error('damaged cache failed to recover');
      // Exercise the exact Firefox failure boundary: saved cursor -> 409 ->
      // worker reset with genuine nested reactive identity -> fresh snapshot.
      expired = true;
      await m.syncTowerPgWorkspace(store, {}, deps);
      if ((await state()).localGeneration !== 2 || (await counts()).join() !== before.join()) throw new Error('expired cursor failed to recover');
      if (await db.pending_writes.count() !== 1 || (await db.chat_messages.get('unsent-draft')).body !== 'keep local intent') throw new Error('lost local pending intent');
      const scope = fixture.canonical_upserts.changes.find(c => c.family === 'scope').row;
      const channel = fixture.canonical_upserts.changes.find(c => c.family === 'channel').row;
      for (let pass = 0; pass < 3; pass++) {
        await m.hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => ({ scopes: [scope] }) });
        await m.hydrateTowerPgChannels(store, { getTowerPgWorkspaceScopes: async () => ({ scopes: [scope] }), getTowerPgScopeChannels: async () => ({ channels: [channel] }) });
        await m.replacePgMessagesForChannel(channel.id, (await db.chat_messages.toArray()).map(({ pg_delta_generation, pg_delta_family, ...row }) => row));
        let index = 0; const t = performance.now();
        await m.syncTowerPgWorkspace(store, {}, { ...deps, getTowerPgRecordSync: async () => {
          index++;
          return { ...delta(`catchup-${pass}-${index}`, index < 4), changes: [{ ...c, version: String(1000 + pass * 4 + index),
            row: { ...c.row, row_version: 1000 + pass * 4 + index, body: `caught up ${pass}/${index}` } }] };
        } });
        timings.push(Math.round(performance.now() - t));
        if ((await counts()).join() !== before.join() || !(await state()).converged) throw new Error('typed catchup lost navigation/history');
        if ((await db.chat_messages.get(c.id)).body !== `caught up ${pass}/4`) throw new Error('catchup did not converge to latest content');
      }
      // Real SSE target hydrator + real native Dexie/worker, alongside a valid
      // core event. Missing targets require journal reconciliation, not an empty
      // target replacement. A malformed Feed event keeps its error/history.
      const missing = Object.assign(new Error('missing channel'), { status: 400, payload: { code: 'resource-not-found', required_permission: 'channel.read', identity: { workspace_id: workspaceId } } });
      let coreWrites = 0;
      store.requestTowerSyncFamily = async (family) => {
        if (family !== 'channel-messages') throw new Error('unexpected targeted family');
        await m.hydrateTowerPgChannelMessages({ ...store, requestTowerSyncFamily: undefined }, channel.id, {
          getTowerPgChannelThreads: async () => ({ threads: fixture.canonical_upserts.changes.filter(row => row.family === 'thread').map(row => row.row) }),
          getTowerPgChannelMessages: async () => ({ messages: [{ ...c.row, row_version: 2000, body: 'valid SSE message' }] }),
          getTowerPgResponseActivities: async () => { throw missing; },
          getTowerPgAgentActivities: async () => ({ agent_activities: [] }),
        }); coreWrites++;
      };
      const eventResult = await m.hydrateTowerPgEventUpdates(store, [
        { entity_type: 'workroom', entity_id: 'missing-room' },
        { entity_type: 'response_activity', payload: { response_activity: { id: 'activity', target_type: 'chat_thread', target_id: 'missing-thread', channel_id: channel.id, status: 'working' } } },
        { entity_type: 'feed_subscription', payload: { ...feed, reader_actor_id: 'wrong-reader' } },
        { entity_type: 'message', entity_id: c.id, channel_id: channel.id },
      ], { getTowerPgWorkroom: async () => { throw missing; }, getTowerPgResponseActivities: async () => { throw missing; } });
      if (eventResult.absentTargets.length !== 2 || eventResult.optionalFailures.length !== 1 || coreWrites !== 1 || (await db.chat_messages.get(c.id)).body !== 'valid SSE message') throw new Error('optional target poisoned core writes');
      await m.syncTowerPgWorkspace(store, {}, { ...deps, getTowerPgRecordSync: async () => delta('stale-target-reconciled') });
      if (!(await state()).converged || await db.feed_subscriptions.count() !== 1 || await db.feed_items.count() !== 1) throw new Error('lost Feed history during sync recovery');
      const snapshot = snapshotStore(); structuredClone(snapshot);
      if (!snapshot.currentWorkspace.pgMe.permissions.includes('workspace.read') || m.resolvePgReaderActorId(snapshot) !== 'viewer-actor') throw new Error('worker identity/permission lost');
      store.session.npub = 'another-reader';
      if (m.resolvePgReaderActorId(snapshotStore())) throw new Error('reader switch admitted stale identity');
      store.session.npub = 'npub1viewer'; store.currentWorkspace.pgMe.identity.workspace_id = 'another-workspace';
      if (m.resolvePgReaderActorId(snapshotStore())) throw new Error('workspace switch admitted stale identity');
      store.currentWorkspace.pgMe.identity.workspace_id = workspaceId;
      // A different partition must not inherit this canonical cursor or views.
      const other = m.openWorkspaceDb(`${key}-other`); await other.open();
      if (await other.pg_record_rows.count() || await other.sync_state.count()) throw new Error('workspace leak');
      other.close(); await other.delete(); db = m.openWorkspaceDb(key); await db.open();
      return { before, after: await counts(), requests, timings, optionalTargets: eventResult.absentTargets.length, optionalErrors: eventResult.optionalFailures.length, coreWrites, elapsedMs: Math.round(performance.now() - started), progress };
    } catch (error) { throw new Error(`${error.name}: ${error.message}\n${error.stack}`); } finally { client.dispose(); db.close(); await db.delete(); }
  }, fixture);
  expect(result.after).toEqual(result.before);
  expect(result.requests).toEqual([null, 'repair-1', 'repair-2', 'repair-2', 'repair-3', 'repaired', null, 'repair-1', 'repair-2', 'repair-3']);
  expect(result.timings).toHaveLength(3);
  expect(Math.max(...result.timings)).toBeLessThan(5000);
  console.log('canonical lifecycle evidence', JSON.stringify(result));
});
