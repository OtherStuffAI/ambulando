const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

// Execute the real materialization worker and IndexedDB at a loopback origin.
// All probe URLs are fulfilled in memory; this never contacts a Tower or
// starts a second app runtime.
test('publishes eight staged PG pages in the real worker without losing transaction authority', async ({ page, baseURL }) => {
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
          local_apply_options: { stageSnapshot: true, expectedCursor: cursor, expectedGeneration: 0 } });
        if (!page.staged || page.applied !== 0) throw new Error('Snapshot published before handover');
        cursor = page.cursor;
      }
      const published = await send({ ...fixture.one_message_delta, changes: [], next_cursor: 'handover', has_more: false,
        local_apply_options: { stageSnapshot: true, expectedCursor: cursor, expectedGeneration: 0 } });
      const replay = await send({ ...fixture.one_message_delta, changes: [], next_cursor: 'handover', has_more: false,
        local_apply_options: { expectedCursor: 'handover', expectedGeneration: 0 } });
      return { published, replay };
    } finally {
      worker.terminate();
      indexedDB.deleteDatabase(`wingman-fd-ws-${workspaceKey}`);
    }
  }, { fixture, origin });
  expect(result.published).toMatchObject({ applied: 1600, cursor: 'handover', hasMore: false });
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
      await send({ ...fixture.canonical_upserts, has_more: true, local_apply_options: { stageSnapshot: true } });
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
          snapshot_complete: index === 84, local_apply_options: { stageSnapshot: true } });
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
        local_apply_options: { stageSnapshot: true } });
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
