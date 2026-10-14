import Dexie from 'dexie';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { nip19 } from 'nostr-tools';
import { openWorkspaceDb, createWorkspaceDb, saveSettings, getSettings } from '../src/db.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { prepareThreadPinCommand, synchronizeThreadPins } from '../src/thread-pin-sync.js';
import { applyThreadPinOperation, queueThreadPin, readThreadPinProjection, threadPinContext, threadPinSupportKey } from '../src/thread-pin-store.js';
import { getTowerPgRecordSync, putTowerPgThreadPin, putTowerPgPersonalPin } from '../src/api.js';
import { applyPgRecordChanges, recordDeltaCursorKey } from '../src/pg-record-delta.js';
import { storeCredentials, clearCredentials } from '../src/auth/secure-store.js';
import { setMemoryPubkey, clearMemoryCredentials } from '../src/auth/nostr.js';
import { setActiveSessionNpub } from '../src/crypto/group-keys.js';

// Opt-in integration, never reaches a production database. Production API client,
// NIP-98 authentication, HTTP routes, Postgres and Dexie are all real.
describe.skipIf(!process.env.RECORD_TEST_PORT)('two isolated clients against real Tower pin routes', () => {
  let child, backend, clients, signerActor = 0, serial = 0;
  const signing = new Map();
  const allClients = [];
  beforeAll(async () => {
    const tower = process.env.TOWER_SOURCE_DIR || fileURLToPath(new URL('../../../wm/tower', import.meta.url));
    child = spawn('bun', ['tests/fixtures/thread-pin-client-backend.ts'], { cwd: tower, env: process.env, stdio: ['pipe','pipe','pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    backend = await new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      child.once('exit', code => reject(new Error(`Backend exited ${code}: ${errors}`)));
      lines.on('line', line => {
        let result;
        try { result = JSON.parse(line); } catch { return; }
        if (result.ready) resolve(result);
        else if (result.id) { signing.get(result.id)?.(result.event); signing.delete(result.id); }
      });
    });
    globalThis.window = { nostr: {
      getPublicKey: async () => nip19.decode(backend.npubs[signerActor]).data,
      signEvent: event => new Promise(resolve => { const id = ++serial; signing.set(id, resolve); child.stdin.write(JSON.stringify({ id, actor: signerActor, event })+'\n'); }),
    } };
    clients = [makeClient('device-a'), makeClient('device-b')];
    await login(0);
  }, 30000);
  afterAll(async () => {
    for (const client of allClients) client.service.dispose();
    for (const db of Dexie.connections.filter(db=>db.name.includes('pin-integration-'))) db.close();
    for (const client of allClients) await Dexie.delete(client.db.name);
    await clearCredentials(); clearMemoryCredentials(); setActiveSessionNpub(null); delete globalThis.window;
    if (child?.exitCode === null) { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); }
  });
  async function login(actor) {
    signerActor = actor; const npub = backend.npubs[actor], pubkey = nip19.decode(npub).data;
    setMemoryPubkey(pubkey); setActiveSessionNpub(npub);
    await storeCredentials({ method: 'extension', pubkey });
  }
  function makeClient(name, actor = 0, workspaceId = backend.workspaceId) {
    const workspaceDbKey = `pin-integration-${name}-${Date.now()}`;
    const db = createWorkspaceDb(workspaceDbKey);
    const store = { session: { npub: backend.npubs[actor] }, currentViewerNpub: backend.npubs[actor], backendUrl: backend.baseUrl,
      workspaceDbKey, _workspaceSelectionGeneration: 1, pinnedThreadsPartition: `legacy-${name}`,
      currentWorkspace: { workspaceId, appNpub: backend.npubs[0], directHttpsUrl: backend.baseUrl,
        pgMe: { actor: { actor_id: backend.actorIds[actor], npub: backend.npubs[actor] }, identity: { workspace_id: workspaceId } } },
      buildTowerPgMaterializationStoreSnapshot() { return this; },
      runTowerPgWorkspaceSync: async () => {},
    };
    const service = new TowerSyncService({ workspaceKey: workspaceDbKey, ports: {
      prepareCommand: (name, input) => prepareThreadPinCommand(store, input),
      materialize: async (_family, bundle) => { const activeDb = openWorkspaceDb(workspaceDbKey); await activeDb.open(); return applyThreadPinOperation(store, bundle.thread_pin_operation, activeDb); },
    } });
    store.getTowerSyncService = () => service;
    store.commandTowerWorkspace = (name, input, options) => service.command(name, input, options);
    const client = { store, db, service, context: threadPinContext(store) }; allClients.push(client); return client;
  }
  async function pull(client) {
    openWorkspaceDb(client.store.workspaceDbKey); await client.db.open();
    let cursor = (await client.db.sync_state.get(recordDeltaCursorKey(client.store)))?.value?.cursor || null;
    let page, pages = 0;
    do {
      if (++pages > 30) throw Error("Pin fixture snapshot did not converge");
      page = await getTowerPgRecordSync(client.context.workspaceId, { baseUrl: backend.baseUrl, appNpub: backend.npubs[0], cursor });
      await applyPgRecordChanges(client.store, page);
      cursor = page.next_cursor;
    } while (page.has_more);
    return page;
  }
  async function flush(client) { openWorkspaceDb(client.store.workspaceDbKey); await client.db.open(); await synchronizeThreadPins(client.store); }
  const thread = index => ({ id: backend.threadIds[index], channelId: backend.channelId, rootRecordId: backend.threadIds[index] });
  const projection = async client => { await client.db.open(); return readThreadPinProjection(client.db, client.context, client.store.pinnedThreadsPartition); };

  it('migrates disjoint local pins, propagates unpins and survives reload without stale-device resurrection', async () => {
    const [a,b] = clients;
    console.log('PIN_STEP opening'); await Promise.all(clients.map(c => c.db.open())); console.log('PIN_STEP opened');
    await saveSettings({ threadPins: { [a.store.pinnedThreadsPartition]: { [thread(0).id]: { ...thread(0), pinnedAt: '2026-10-01T00:00:00Z' } },
      [b.store.pinnedThreadsPartition]: { [thread(1).id]: { ...thread(1), pinnedAt: '2026-10-02T00:00:00Z' } } } });
    console.log('PIN_STEP initial pull'); await pull(a); await pull(b); console.log('PIN_STEP initial flush'); await flush(a); await flush(b); console.log('PIN_STEP convergence pull'); await pull(a); await pull(b); console.log('PIN_STEP projected');
    for (const client of clients) expect((await projection(client)).rows.map(r => r.id).sort()).toEqual([thread(0).id,thread(1).id].sort());
    const pinOrder = (await projection(a)).rows.map(r => [r.id,r.pinnedAt]);
    await a.db.open(); await queueThreadPin(a.db,a.context,thread(0),false); await flush(a); await pull(b);
    expect((await projection(b)).rows.map(r => r.id)).toEqual([thread(1).id]);
    console.log('PIN_STEP unpin done'); const stale = makeClient('stale-device');
    await stale.db.open();
    await saveSettings({ threadPins: { ...(await getSettings()).threadPins, [stale.store.pinnedThreadsPartition]: { [thread(0).id]: { ...thread(0), pinnedAt:'2026-09-01T00:00:00Z' } } } });
    // A device that already negotiated support can retry its old local import
    // without first seeing another device's tombstone.
    await stale.db.sync_state.put({ key: threadPinSupportKey(stale.context), value: true });
    console.log('PIN_STEP stale flush'); await flush(stale); console.log('PIN_STEP stale pull'); await pull(stale); console.log('PIN_STEP stale projected'); expect((await projection(stale)).rows.some(r=>r.id===thread(0).id)).toBe(false);
    await flush(stale); expect(await stale.db.thread_pin_outbox.count()).toBe(0);
    stale.service.dispose();
    console.log('PIN_STEP reload'); b.db.close(); await b.db.open(); await pull(b); console.log('PIN_STEP reloaded');
    expect((await projection(b)).rows.map(r => [r.id,r.pinnedAt])).toEqual(pinOrder.filter(r=>r[0]===thread(1).id));
    console.log('PIN_SYNC_REAL_HTTP migration, disjoint imports, unpin propagation, stale migration and reload verified');
  }, 30000);
  it('keeps fixed offline retries and independent mutations; a stale explicit request cannot overwrite a newer unpin', async () => {
    const [a,b]=clients;await pull(a);await pull(b);
    await Promise.all(clients.map(c=>c.db.open()));
    await Promise.all([queueThreadPin(a.db,a.context,thread(0),true),queueThreadPin(b.db,b.context,thread(2),true)]);
    await flush(a);await flush(b);await pull(a);await pull(b);
    expect((await projection(a)).rows).toHaveLength(3);expect((await projection(b)).rows).toHaveLength(3);
    // Uncertain response: apply request remotely, retain its exact local operation.
    await b.db.open(); await queueThreadPin(b.db,b.context,thread(0),false);
    const op=(await b.db.thread_pin_outbox.toArray())[0];
    await putTowerPgThreadPin(backend.workspaceId,op.threadId,op.body,b.context);
    await flush(b);expect(await b.db.thread_pin_outbox.count()).toBe(0);await pull(a);await pull(b);
    // Stale offline device A observes version before B repins/unpins.
    await a.db.open(); await queueThreadPin(a.db,a.context,thread(0),true);
    const fixed=(await a.db.thread_pin_outbox.toArray())[0];
    await applyThreadPinOperation(a.store,{action:'retry',seq:fixed.seq,mutationId:fixed.body.mutation_id},a.db);
    expect((await a.db.thread_pin_outbox.get(fixed.seq)).body).toEqual(fixed.body);
    await b.db.open(); await queueThreadPin(b.db,b.context,thread(0),true);await flush(b);
    await b.db.open(); await queueThreadPin(b.db,b.context,thread(0),false);await flush(b);
    await flush(a);await pull(a);
    expect((await projection(a)).rows.some(r=>r.id===thread(0).id)).toBe(false);
    expect((await projection(a)).error).toContain('another device');expect(await a.db.thread_pin_outbox.count()).toBe(0);
    console.log('PIN_SYNC_REAL_HTTP independent mutations, lost-ack replay, fixed offline retry and CAS conflict verified');
  }, 30000);
  it('retains unavailable imports and allows unpin; actor/backend/workspace projection never leaks', async () => {
    const [a]=clients;const missing={id:crypto.randomUUID(),channelId:'',rootRecordId:''};
    await a.db.open(); await applyThreadPinOperation(a.store,{action:'migrate',partition:'missing-legacy',pins:{[missing.id]:missing}},a.db);
    await flush(a);await pull(a);
    const row=(await projection(a)).rows.find(r=>r.id===missing.id);expect(row).toMatchObject({title:'Thread unavailable',unavailable:true});
    await queueThreadPin(a.db,a.context,missing,false);await flush(a);await pull(a);
    expect((await projection(a)).rows.some(r=>r.id===missing.id)).toBe(false);
    await login(1);const other=makeClient('other-actor',1);await other.db.open();await pull(other);
    expect((await projection(other)).rows).toEqual([]);
    await expect(putTowerPgThreadPin(backend.workspaceId,thread(1).id,{pinned:true,expected_row_version:0,mutation_id:crypto.randomUUID(),actor_id:backend.actorIds[0]},other.context)).rejects.toMatchObject({status:400});
    other.service.dispose();await login(0);await a.db.open();
    const differentBackend={...a.context,key:JSON.stringify(['https://other.example',a.context.appNpub,a.context.workspaceId,a.context.actorId])};
    expect((await readThreadPinProjection(a.db,differentBackend,'no-legacy')).rows).toEqual([]);
    console.log('PIN_SYNC_REAL_HTTP unavailable removal, actor-private records and backend partition verified');
  }, 30000);
  it('syncs tasks and documents in the same list, independently of a thread with the same UUID', async () => {
    const [a,b]=clients;await login(0);await pull(a);await pull(b);
    const task={id:backend.taskId,type:'task',channelId:backend.channelId},doc={id:backend.documentId,type:'document',channelId:backend.channelId};
    const beforeA=await a.db.resource_view_states.toArray();const beforeTasks=await a.db.tasks.toArray();const beforeDocs=await a.db.documents.toArray();
    await Promise.all([queueThreadPin(a.db,a.context,task,true),queueThreadPin(b.db,b.context,doc,true)]);
    await flush(a);await flush(b);await pull(a);await pull(b);
    for(const client of clients){const rows=(await projection(client)).rows;expect(rows.some(r=>r.type==='task'&&r.id===task.id)).toBe(true);expect(rows.some(r=>r.type==='document'&&r.id===doc.id)).toBe(true);expect(rows.some(r=>r.type==='thread'&&r.id===task.id)).toBe(true);}
    const foreign=makeClient('other-workspace',0,backend.otherWorkspaceId);await foreign.db.open();await pull(foreign);expect((await projection(foreign)).rows).toEqual([]);
    for(const type of ['thread','task','document'])await expect(putTowerPgPersonalPin(backend.otherWorkspaceId,type,task.id,{pinned:true,expected_row_version:0,mutation_id:crypto.randomUUID()},foreign.context)).rejects.toMatchObject({status:404});
    foreign.service.dispose();await a.db.open();
    await queueThreadPin(a.db,a.context,task,false);await flush(a);await pull(b);
    expect((await projection(b)).rows.some(r=>r.type==='task'&&r.id===task.id)).toBe(false);
    expect((await projection(b)).rows.some(r=>r.type==='document'&&r.id===doc.id)).toBe(true);
    b.db.close();await b.db.open();await pull(b);expect((await projection(b)).rows.some(r=>r.type==='document'&&r.id===doc.id)).toBe(true);
    await a.db.open();expect(await a.db.resource_view_states.toArray()).toEqual(beforeA);expect(await a.db.tasks.toArray()).toEqual(beforeTasks);expect(await a.db.documents.toArray()).toEqual(beforeDocs);
    // Same-resource stale offline intent conflicts; independent types remain intact.
    await queueThreadPin(a.db,a.context,doc,false);await queueThreadPin(b.db,b.context,doc,false);await flush(b);await flush(a);await pull(a);
    expect((await projection(a)).rows.some(r=>r.type==='document'&&r.id===doc.id)).toBe(false);expect((await projection(a)).error).toContain('another device');
    await login(1);await expect(putTowerPgPersonalPin(backend.workspaceId,'document',doc.id,{pinned:true,expected_row_version:0,mutation_id:crypto.randomUUID()},a.context)).rejects.toMatchObject({status:403});await login(0);
    console.log('PIN_SYNC_REAL_HTTP thread/task/document typed independence, propagation, reload, privacy, conflicts and unchanged read/edit state verified');
  },30000);

});
