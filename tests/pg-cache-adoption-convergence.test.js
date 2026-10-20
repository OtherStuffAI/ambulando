import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import contextFixture from './fixtures/context-record-delta-v1.json';
import { openWorkspaceDb } from '../src/db.js';
import { hydrateTowerPgSyncBundle, resolveTowerPgWorkspaceContext } from '../src/pg-read-hydrator.js';
import { recordDeltaCursorKey } from '../src/pg-record-delta.js';
import { syncDeviceRecords } from '../src/pg-device-checkpoints.js';
import { auxiliarySyncKey, runCacheAdoption, runDeferredRepair } from '../src/pg-priority-sync.js';

// Reproduces Pete's device: a large cache downloaded by Tower snapshot pages,
// whose rows carry the snapshot boundary rather than their own journal
// position, plus server edits, deletes and creates after that download.

const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const families = [...fixture.canonical_upserts.families, 'context_component', 'context_reference'];
const store = { workspaceDbKey: 'adoption-convergence', backendUrl: 'http://localhost:3100', session: { npub: 'viewer' },
  currentWorkspace: { workspaceId, workspaceOwnerNpub: 'owner', pgBackendMode: true } };
let db, context, key;
beforeEach(async () => {
  db = openWorkspaceDb('adoption-convergence'); await db.open(); await Promise.all(db.tables.map(t => t.clear()));
  context = resolveTowerPgWorkspaceContext(store); key = recordDeltaCursorKey(store);
});
const state = async () => (await db.sync_state.get(key))?.value;
const failure = (code, extra = {}) => Object.assign(new Error(code), { code, status: 409,
  payload: { error: code, ...(code.startsWith('adoption_') ? { recovery: { strategy: 'restart_cache_adoption', full_snapshot_required: false } } : {}), ...extra } });

const templates = Object.fromEntries(fixture.canonical_upserts.changes.map(change => [change.family, change]));
const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const prefixes = { scope: '41000000', channel: '31000000', doc: '51000000', audio_note: '52000000', daily_note: '53000000',
  context_component: '54000000', context_reference: '55000000' };

function rowFor(family, id, n, title) {
  if (family.startsWith('context_')) {
    const source = family === 'context_component' ? contextFixture.components[0] : contextFixture.references[0];
    return { ...source, id, workspace_id: workspaceId, title: title || `${family} ${n}` };
  }
  const row = { ...templates[family].row, id, workspace_id: workspaceId };
  if ('title' in row || family === 'doc') row.title = title || `${family} ${n}`;
  if (family === 'channel') row.name = title || `channel ${n}`;
  // Daily notes are unique per owner and date.
  if (family === 'daily_note') row.note_date = new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
  return row;
}

// Tower's journal: one event per write. Snapshot pages read current rows and
// label them with the boundary; delta pages, the manifest and selective repair
// use each row's own position.
function tower({ exact = false } = {}) {
  const journal = [];
  let position = 0;
  const write = (family, id, row, deleted = false) => journal.push({ family, id, position: ++position, deleted, row: deleted ? null : row });
  const keyOf = (family, id) => `${family}:${id}`;
  const at = head => {
    const latest = new Map();
    for (const event of journal) if (event.position <= head) latest.set(keyOf(event.family, event.id), event);
    return latest;
  };
  const current = () => at(position);
  const sorted = map => [...map.values()].sort((a, b) => a.family < b.family ? -1 : a.family > b.family ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const change = (event, version = String(event.position)) => ({ family: event.family, id: event.id,
    operation: event.deleted ? 'delete' : 'upsert', version, workspace_id: workspaceId,
    scope_id: event.row?.scope_id ?? null, channel_id: event.family === 'channel' ? event.id : event.row?.channel_id ?? null,
    row: event.deleted ? null : event.row });
  const clients = new Map(), tokens = new Map(), manifests = new Map(), sessions = new Map(), starts = new Map();
  const unavailable = new Set();
  let sequence = 0;
  const calls = { registers: [], snapshotPages: 0, deltaPages: 0, adoptionStarts: [], repairedKeys: [], retired: [] };
  const checkpoint = id => { const c = clients.get(id); return { protocol_version: 2, client_id: id, authority_epoch: 'epoch',
    initial_cursor: c.initial, checkpoint_cursor: c.cursor, checkpoint_revision: String(c.revision) }; };
  const client = vi.fn(async (_workspace, id, request) => {
    if (request.operation === 'retire') { clients.delete(id); calls.retired.push(id); return { retired: true }; }
    if (request.operation === 'register') {
      calls.registers.push(id);
      if (!clients.has(id)) {
        const initial = `initial:${id}:${++sequence}`;
        clients.set(id, { revision: 0, cursor: null, initial });
        tokens.set(initial, { clientId: id, kind: 'snapshot', offset: 0, boundary: position, snapshotId: `snapshot:${sequence}` });
      }
    }
    if (!clients.has(id)) throw failure('client_not_registered');
    const c = clients.get(id);
    if (request.operation === 'ack') {
      if (c.cursor === request.cursor) return checkpoint(id);
      if (!tokens.get(request.cursor) || request.expectedRevision !== String(c.revision)) throw failure('checkpoint_conflict');
      c.cursor = request.cursor; c.revision += 1;
    }
    return checkpoint(id);
  });
  const page = vi.fn(async (_workspace, request) => {
    const token = tokens.get(request.cursor);
    if (!token || token.clientId !== request.clientId) throw failure('page_token_invalid');
    const limit = request.limit || 200;
    const next = `token:${++sequence}`;
    const base = { protocol_version: 2, client_id: request.clientId, checkpoint_revision: String(clients.get(request.clientId).revision),
      families, actors: [], next_cursor: next, bounds: { max_rows: 200, max_bytes: 1048576 } };
    if (token.kind === 'snapshot') {
      calls.snapshotPages += 1;
      const rows = sorted(at(token.boundary)).filter(event => !event.deleted);
      const slice = rows.slice(token.offset, token.offset + limit);
      const complete = token.offset + limit >= rows.length;
      tokens.set(next, complete ? { clientId: request.clientId, kind: 'delta', after: token.boundary }
        : { ...token, offset: token.offset + limit });
      return { ...base, mode: 'snapshot', changes: slice.map(event => change(event, String(token.boundary))),
        has_more: true, snapshot_id: token.snapshotId, snapshot_complete: complete, partitions_complete: complete ? families : [] };
    }
    calls.deltaPages += 1;
    const events = journal.filter(event => event.position > token.after);
    const slice = events.slice(0, limit);
    tokens.set(next, { clientId: request.clientId, kind: 'delta', after: slice.at(-1)?.position ?? token.after });
    return { ...base, mode: 'delta', changes: slice.map(event => change(event)), has_more: events.length > limit,
      snapshot_id: null, snapshot_complete: false, partitions_complete: [] };
  });
  const readManifest = vi.fn(async () => { const cursor = `manifest:${++sequence}`; manifests.set(cursor, position);
    return { coverage: 'authorized_manifest', next_cursor: cursor, entries: [], has_more: true }; });
  const matches = (local, authoritative) => exact ? local === authoritative : BigInt(local) >= BigInt(authoritative);
  const respond = (session, extra) => ({ protocol_version: 2, adoption_id: session.id, captured_head: String(session.head),
    authority_epoch: 'epoch', access_revision: '1', checkpoint_revision: String(session.base),
    bounds: { max_rows: 200, max_bytes: 1048576 }, retention_policy: 'retain_downloaded', ...extra });
  const challengePage = session => {
    const entries = sorted(at(session.head)).slice(session.offset, session.offset + 200);
    session.challenge = entries.map(event => ({ family: event.family, id: event.id, version: String(event.position),
      state: event.deleted ? 'deleted' : 'active', relationships: {} }));
    session.offset += entries.length;
    session.hasMore = session.offset < at(session.head).size;
  };
  const advance = (session, deferred) => {
    const cursor = `adoption:${++sequence}`;
    sessions.set(cursor, session);
    const extra = deferred?.length ? { deferred } : {};
    if (session.mismatches?.length) return respond(session, { ...extra, status: 'repair_required', cursor, records: session.mismatches });
    if (session.hasMore || !session.challenge) { challengePage(session); return respond(session, { ...extra, status: 'inventory_required', cursor, challenge: session.challenge, has_more: session.hasMore }); }
    const c = clients.get(session.clientId);
    if (c.revision !== session.base) throw failure('adoption_checkpoint_conflict');
    const adopted = `adopted:${++sequence}`;
    tokens.set(adopted, { clientId: session.clientId, kind: 'delta', after: session.head });
    c.revision += 1; c.cursor = adopted; c.initial = adopted; session.committed = true;
    return respond(session, { ...extra, status: 'adopted', checkpoint: checkpoint(session.clientId) });
  };
  const adopt = vi.fn(async (_workspace, clientId, body) => {
    if (body.request_id) {
      calls.adoptionStarts.push(body);
      const prior = starts.get(`${clientId}:${body.request_id}`);
      if (prior) return prior;
      if (!clients.has(clientId)) throw failure('client_not_registered');
      if (String(clients.get(clientId).revision) !== body.expected_checkpoint_revision) throw failure('adoption_checkpoint_conflict');
      const session = { id: `session:${++sequence}`, clientId, head: manifests.get(body.manifest_cursor), base: clients.get(clientId).revision, offset: 0 };
      const response = advance(session);
      starts.set(`${clientId}:${body.request_id}`, response);
      return response;
    }
    const session = sessions.get(body.cursor);
    if (!session || session.clientId !== clientId) throw failure('adoption_cursor_invalid');
    sessions.delete(body.cursor);
    if (body.inventory) {
      expect(body.inventory.map(entry => entry.id)).toEqual(session.challenge.map(entry => entry.id));
      session.mismatches = session.challenge.filter((expected, index) => {
        const actual = body.inventory[index];
        return actual.state !== expected.state || actual.state === 'missing' || !matches(actual.version, expected.version);
      });
      return advance(session);
    }
    const receipts = new Map(body.repaired.map(entry => [`${entry.family}:${entry.id}`, entry]));
    const now = current(), deferred = [];
    for (const expected of session.mismatches) {
      const head = now.get(`${expected.family}:${expected.id}`);
      if (head.position > session.head) continue;
      const receipt = receipts.get(`${expected.family}:${expected.id}`);
      const ok = receipt && receipt.state === (head.deleted ? 'deleted' : 'active') && matches(receipt.version, String(head.position));
      if (ok) continue;
      if (exact) throw failure('adoption_repair_incomplete');
      deferred.push({ family: expected.family, id: expected.id, version: String(head.position), state: head.deleted ? 'deleted' : 'active' });
    }
    session.mismatches = [];
    return advance(session, deferred);
  });
  const repair = vi.fn(async (_workspace, records) => {
    const now = current(), changes = [], unresolved = [];
    for (const record of records) {
      const recordKey = `${record.family}:${record.id}`;
      calls.repairedKeys.push(recordKey);
      if (unavailable.has(recordKey)) { unavailable.delete(recordKey); unresolved.push({ family: record.family, id: record.id, reason: 'not_available' }); continue; }
      changes.push(change(now.get(recordKey)));
    }
    return { protocol_version: 1, captured_head: String(position), changes, unresolved };
  });
  return { write, current, journal, client, page, readManifest, adopt, repair, unavailable, calls, clients, get position() { return position; } };
}

function seed(remote) {
  const ids = Object.fromEntries(Object.keys(prefixes).map(family => [family, []]));
  const counts = { scope: 1, channel: 150, doc: 700, audio_note: 400, daily_note: 150, context_component: 500, context_reference: 300 };
  let n = 0;
  for (const [family, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) {
      const id = uuid(prefixes[family], ++n);
      ids[family].push(id);
      remote.write(family, id, rowFor(family, id, n));
    }
  }
  // Older edits: rows whose own position is far below the later snapshot boundary.
  for (const id of ids.doc.slice(0, 200)) remote.write('doc', id, rowFor('doc', id, 0, `edited ${id}`));
  return ids;
}

function harness(remote, { exact = false } = {}) {
  const deviceMaterialize = bundle => hydrateTowerPgSyncBundle(store, bundle, { migrateLegacyAutopilotLaunchers: async () => {} });
  const deps = { context, adopt: remote.adopt, readManifest: remote.readManifest, repair: remote.repair };
  const options = { cacheAdoption: true, adoptionBackoffMs: 0,
    adopt: device => runCacheAdoption(store, device, deps),
    repairDeferred: () => runDeferredRepair(store, {}, deps) };
  return {
    exact,
    run: (extra = {}) => syncDeviceRecords({ context, cursorKey: key, options: { ...options, ...extra },
      readState: async k => (await db.sync_state.get(k))?.value, materialize: deviceMaterialize,
      readPage: remote.page, client: remote.client, assertCurrent: () => {} }),
  };
}

async function downloadInterruptedSnapshot(remote, h, pages) {
  const read = remote.page.getMockImplementation();
  let served = 0;
  remote.page.mockImplementation(async (...args) => {
    if (++served > pages) throw new Error('device went to sleep');
    return read(...args);
  });
  await expect(h.run()).rejects.toThrow('device went to sleep');
  remote.page.mockImplementation(read);
}

describe('populated-cache adoption convergence', () => {
  it('adopts a realistic snapshot-labelled cache under the same client id without another snapshot', async () => {
    const remote = tower();
    const ids = seed(remote);
    const h = harness(remote);
    // The device downloaded most of a snapshot and was interrupted.
    await downloadInterruptedSnapshot(remote, h, 10);
    const interrupted = await state();
    const clientId = interrupted.device.clientId;
    expect(interrupted.snapshotReconciliationPending).toBe(true);
    const cachedKeys = new Set((await db.pg_record_rows.toArray()).map(row => row.key));
    expect(cachedKeys.size).toBe(2000);
    const boundaries = new Set((await db.pg_record_rows.toArray()).map(row => row.version));
    expect(boundaries.size).toBe(1);
    const snapshotPagesBefore = remote.calls.snapshotPages;

    // Server writes after the download: edits, tombstones and new rows.
    const stale = ids.doc.slice(300, 330), deleted = ids.doc.slice(330, 340);
    for (const id of stale) remote.write('doc', id, rowFor('doc', id, 0, `server ${id}`));
    for (const id of deleted) remote.write('doc', id, null, true);
    const created = Array.from({ length: 20 }, (_, i) => uuid('56000000', i + 1));
    for (const id of created) remote.write('doc', id, rowFor('doc', id, 0, `new ${id}`));
    // A typed read hydrated a view without a canonical row (the snapshot
    // tail the interrupted download never reached).
    const typedOnly = ids.doc.at(-1);
    expect(cachedKeys.has(`doc:${typedOnly}`)).toBe(false);
    await db.documents.put({ record_id: typedOnly, title: 'typed read', sync_status: 'synced' });
    // A pending local edit on a server-edited document is preserved.
    const edited = stale[0];
    await db.documents.update(edited, { title: 'my unsent edit', sync_status: 'pending' });
    await db.pending_writes.add({ record_id: edited, envelope: { title: 'my unsent edit' } });
    // One repair is temporarily unavailable and must be deferred, not fatal.
    const flaky = `doc:${stale[1]}`;
    remote.unavailable.add(flaky);

    const result = await h.run();

    const converged = await state();
    expect(converged.device.clientId).toBe(clientId);
    expect(converged.converged).toBe(true);
    expect(converged.snapshotReconciliationPending).toBe(false);
    expect(remote.calls.snapshotPages).toBe(snapshotPagesBefore);
    expect(remote.calls.registers.every(id => id === clientId)).toBe(true);
    expect(remote.calls.retired).toEqual([]);
    expect(remote.clients.size).toBe(1);
    expect(result.clientId).toBe(clientId);
    expect(remote.calls.adoptionStarts).toHaveLength(1);

    // Boundary-labelled rows are adopted as they are; only genuine gaps transfer.
    const repaired = new Set(remote.calls.repairedKeys);
    for (const keyName of cachedKeys) {
      const id = keyName.split(':')[1];
      if (!stale.includes(id) && !deleted.includes(id)) expect(repaired.has(keyName)).toBe(false);
    }
    const missing = [...remote.current().keys()].filter(keyName => !cachedKeys.has(keyName));
    expect(missing.length).toBeGreaterThan(150);
    for (const keyName of missing) expect(repaired.has(keyName)).toBe(true);

    for (const id of deleted) expect(await db.pg_record_rows.get(`doc:${id}`)).toMatchObject({ operation: 'delete' });
    for (const id of created) expect(await db.documents.get(id)).toMatchObject({ title: `new ${id}` });
    expect(await db.documents.get(typedOnly)).toBeTruthy();
    expect(await db.pg_record_rows.get(`doc:${typedOnly}`)).toMatchObject({ operation: 'upsert' });
    // The deferred key was repaired lazily after adoption committed.
    expect((await db.pg_record_rows.get(flaky)).version).toBe(String(remote.current().get(flaky).position));
    expect((await db.sync_state.get(auxiliarySyncKey(store, 'adoption-deferred'))).value).toMatchObject({ status: 'complete', entries: [] });
    // Local intent survives: pending command and unsent edit are untouched.
    expect(await db.pending_writes.where('record_id').equals(edited).count()).toBe(1);
    expect(await db.documents.get(edited)).toMatchObject({ title: 'my unsent edit' });

    // Later writes arrive by ordinary delta under the same id.
    remote.write('doc', ids.doc[5], rowFor('doc', ids.doc[5], 0, 'after adoption'));
    await h.run();
    expect((await db.documents.get(ids.doc[5])).title).toBe('after adoption');
    expect((await state()).device.clientId).toBe(clientId);
    expect(remote.calls.snapshotPages).toBe(snapshotPagesBefore);
  }, 180_000);

  it('the exact-match adoption that stranded Pete converges once repairs land at the real position', async () => {
    const remote = tower({ exact: true });
    seed(remote);
    const h = harness(remote, { exact: true });
    await downloadInterruptedSnapshot(remote, h, 4);
    const clientId = (await state()).device.clientId;
    const snapshotPagesBefore = remote.calls.snapshotPages;

    await h.run();

    expect(remote.calls.adoptionStarts).toHaveLength(1);
    expect((await state())).toMatchObject({ converged: true, device: { clientId } });
    expect(remote.calls.snapshotPages).toBe(snapshotPagesBefore);
    expect(remote.calls.registers.every(id => id === clientId)).toBe(true);
    expect(remote.clients.size).toBe(1);
  }, 180_000);

  it('a repeatedly rejected adoption restarts boundedly and never mints an id or snapshots', async () => {
    const remote = tower({ exact: true });
    seed(remote);
    const h = harness(remote, { exact: true });
    await downloadInterruptedSnapshot(remote, h, 4);
    const clientId = (await state()).device.clientId;
    const snapshotPagesBefore = remote.calls.snapshotPages;
    const adopt = remote.adopt.getMockImplementation();
    remote.adopt.mockImplementation(async (workspace, id, body) => {
      if (body.repaired) throw failure('adoption_repair_incomplete');
      return adopt(workspace, id, body);
    });

    await expect(h.run()).rejects.toMatchObject({ code: 'adoption_repair_incomplete' });

    expect(remote.calls.adoptionStarts).toHaveLength(4);
    expect(new Set(remote.calls.adoptionStarts.map(start => start.request_id)).size).toBe(4);
    expect((await state()).device.clientId).toBe(clientId);
    expect(remote.calls.snapshotPages).toBe(snapshotPagesBefore);
    expect(remote.calls.registers.every(id => id === clientId)).toBe(true);
    expect(remote.clients.size).toBe(1);
  }, 180_000);
});

describe('device identity across recovery', () => {
  const small = () => {
    const remote = tower();
    for (let i = 1; i <= 30; i++) { const id = uuid(prefixes.doc, i); remote.write('doc', id, rowFor('doc', id, i)); }
    return remote;
  };

  it.each(['history_pruned', 'client_expired', 'client_not_registered', 'page_token_invalid'])(
    'a preserved-rows reset after %s keeps the client id and adopts instead of snapshotting', async code => {
      const remote = small(), h = harness(remote);
      await h.run();
      const clientId = (await state()).device.clientId;
      const snapshotPages = remote.calls.snapshotPages;
      if (code === 'client_not_registered') remote.clients.delete(clientId);
      remote.page.mockRejectedValueOnce(failure(code));
      await h.run();
      expect((await state()).device.clientId).toBe(clientId);
      expect((await state()).converged).toBe(true);
      expect(remote.calls.snapshotPages).toBe(snapshotPages);
      expect(remote.calls.adoptionStarts).toHaveLength(1);
      expect(remote.calls.retired).toEqual([]);
    });

  it('an authority-epoch reset is an identity boundary and registers a new cache', async () => {
    const remote = small(), h = harness(remote);
    await h.run();
    const clientId = (await state()).device.clientId;
    remote.page.mockRejectedValueOnce(failure('reset_required'));
    await h.run();
    expect((await state()).device.clientId).not.toBe(clientId);
    expect(remote.calls.retired).toEqual([clientId]);
  });

  it('restarts adoption after a 409 with a new request id and rebases a checkpoint race', async () => {
    const remote = small(), h = harness(remote);
    await h.run();
    const clientId = (await state()).device.clientId;
    const adopt = remote.adopt.getMockImplementation();
    let rejected = 0;
    remote.adopt.mockImplementation(async (workspace, id, body) => {
      if (body.request_id && rejected++ === 0) {
        remote.calls.adoptionStarts.push(body);
        remote.clients.get(id).revision += 1;
        throw failure('adoption_checkpoint_conflict');
      }
      return adopt(workspace, id, body);
    });
    remote.page.mockRejectedValueOnce(failure('page_token_invalid'));
    const progress = vi.fn();
    await h.run({ onProgress: progress });
    expect((await state()).device.clientId).toBe(clientId);
    expect((await state()).converged).toBe(true);
    const startRequests = remote.calls.adoptionStarts;
    expect(startRequests).toHaveLength(2);
    expect(startRequests[0].request_id).not.toBe(startRequests[1].request_id);
    expect(Number(startRequests[1].expected_checkpoint_revision)).toBe(Number(startRequests[0].expected_checkpoint_revision) + 1);
    expect(progress.mock.calls.some(([event]) => event.stage === 'recovery' && event.recoveryReason === 'adoption_checkpoint_conflict')).toBe(true);
  });

  it('a deferred repair lands a lower real position over a snapshot boundary label, never over a newer row', async () => {
    const remote = small(), h = harness(remote);
    await h.run();
    const [labelled, newer] = [uuid(prefixes.doc, 3), uuid(prefixes.doc, 4)];
    const boundary = (await db.pg_record_rows.get(`doc:${labelled}`)).version;
    expect(boundary).toBe(String(remote.position));
    // The newer row was since delivered by delta above the repair's head.
    const ahead = String(Number(boundary) + 5);
    await db.pg_record_rows.update(`doc:${newer}`, { version: ahead });
    await db.sync_state.put({ key: auxiliarySyncKey(store, 'adoption-deferred'), value: { lane: 'adoption-deferred', status: 'pending',
      entries: [{ family: 'doc', id: labelled }, { family: 'doc', id: newer }] } });
    const repaired = id => ({ family: 'doc', id, operation: 'upsert', version: '3', workspace_id: workspaceId, scope_id: null,
      channel_id: null, row: rowFor('doc', id, 0, `repaired ${id}`) });
    const repair = vi.fn(async () => ({ protocol_version: 1, captured_head: boundary, changes: [repaired(labelled), repaired(newer)], unresolved: [] }));
    await runDeferredRepair(store, {}, { context, repair });
    expect(await db.pg_record_rows.get(`doc:${labelled}`)).toMatchObject({ version: '3' });
    expect((await db.documents.get(labelled)).title).toBe(`repaired ${labelled}`);
    expect(await db.pg_record_rows.get(`doc:${newer}`)).toMatchObject({ version: ahead });
    expect((await db.documents.get(newer)).title).not.toBe(`repaired ${newer}`);
  });

  it('an empty cache still registers a fresh id and downloads by snapshot', async () => {
    const remote = small(), h = harness(remote);
    await h.run();
    const clientId = (await state()).device.clientId;
    await db.pg_record_rows.clear();
    await h.run();
    expect((await state()).device.clientId).not.toBe(clientId);
    expect(remote.calls.adoptionStarts).toHaveLength(0);
  });
});
