import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveQuery } from 'dexie';
const auth = vi.hoisted(() => ({ reader: vi.fn(async () => 'reader-auth'), owner: vi.fn(async () => 'owner-auth') }));
vi.mock('../src/auth/nostr.js', () => ({ createNip98AuthHeader: auth.reader, createNip98AuthHeaderForSecret: auth.owner }));
vi.mock('../src/crypto/workspace-keys.js', () => ({ getActiveWorkspaceKeySecretForAuth: () => new Uint8Array(32).fill(1), getActiveWorkspaceKeyNpub: () => 'owner' }));
vi.mock('../src/crypto/group-keys.js', () => ({ getActiveSessionNpub: () => 'reader' }));
import { openWorkspaceDb } from '../src/db.js';
import { scopesManagerMixin } from '../src/scopes-manager.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import { TowerSyncService } from '../src/tower-sync-service.js';

let db, ui, service, server, requests, failure, subscription;
beforeEach(async () => {
  db = openWorkspaceDb('scope-order-save'); await db.open(); await db.scope_orders.clear();
  server = { workspace_id: 'workspace', actor_id: 'actor', scope_ids: ['a', 'b', 'c'], row_version: 7 };
  requests = []; failure = '';
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(url).toBe('http://127.0.0.1:3100/api/v4/flightdeck-pg/workspaces/workspace/me/scope-order');
    expect(options.headers.Authorization).toBe('reader-auth');
    const body = options.body && JSON.parse(options.body);
    requests.push({ method: options.method, body });
    if (options.method === 'GET') return Response.json({ scope_order: server });
    if (failure) return Response.json({ error: failure }, { status: failure === 'scope_order_conflict' ? 409 : 403 });
    if (body.expected_row_version !== server.row_version) return Response.json({ error: 'scope_order_conflict' }, { status: 409 });
    server = { ...server, scope_ids: body.scope_ids, row_version: server.row_version + 1 };
    return Response.json({ scope_order: server });
  }));
  ui = Object.defineProperties({}, Object.getOwnPropertyDescriptors(scopesManagerMixin));
  Object.assign(ui, { isTowerPgMode: true, session: { npub: 'reader' }, workspaceOwnerNpub: 'owner',
    currentWorkspace: { workspaceId: 'workspace', directHttpsUrl: 'http://127.0.0.1:3100', pgMe: { actor: { id: 'actor', npub: 'reader' } } },
    scopes: ['a', 'b', 'c'].map(record_id => ({ record_id, title: record_id, level: 'l1' })), personalScopeOrder: null });
  Object.defineProperty(ui, 'scopeTree', { get() { return this.personallyOrderedScopes; } });
  service = new TowerSyncService({ workspaceKey: 'scope-order-save', ports: { prepareCommand: (name, input) => prepareTowerWorkspaceCommand(ui, name, input) } });
  ui.commandTowerWorkspace = (name, input, options) => service.command(name, input, options);
});
afterEach(() => { subscription?.unsubscribe(); subscription = null; service.dispose(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('saves menu then drag through reader transport even with an absent or delayed rendered revision', async () => {
  // Existing server preference, no preseeded success in Dexie or the UI.
  await ui.moveScope('b', -1);
  expect(ui.scopeOrderError).toBe('');
  expect(server).toMatchObject({ scope_ids: ['b', 'a', 'c'], row_version: 8 });
  expect((await db.scope_orders.get('actor')).row_version).toBe(8);
  // Deliberately keep the rendered projection behind the acknowledgement.
  ui.startScopeDrag('c'); await ui.dropScopeBefore('a');
  expect(ui.scopeOrderError).toBe('');
  expect(server).toMatchObject({ scope_ids: ['c', 'a', 'b'], row_version: 9 });
  const writes = requests.filter(r => r.method === 'PUT').map(r => r.body);
  expect(writes.map(r => r.expected_row_version)).toEqual([7, 8]);
  expect(new Set(writes.map(r => r.mutation_id)).size).toBe(2);
  expect(service.instrumentation.commandsAcknowledged).toBe(2);
  expect(auth.owner).not.toHaveBeenCalled();
  subscription = liveQuery(() => db.scope_orders.get('actor')).subscribe(row => { ui.personalScopeOrder = row; });
  await vi.waitFor(() => expect(ui.personalScopeOrder?.row_version).toBe(9));
  expect(ui.personalScopeOrderIds).toEqual(server.scope_ids);
  subscription.unsubscribe(); db.close(); await db.open();
  expect(await db.scope_orders.get('actor')).toMatchObject(server);
});

it('clears stale success, refreshes conflicts, and permits a fresh explicit retry after rejection', async () => {
  ui.scopeOrderNotice = 'Personal scope order saved.';
  failure = 'scope_order_conflict';
  await ui.moveScope('b', -1);
  expect(ui.scopeOrderNotice).toBe('');
  expect(ui.scopeOrderError).toContain('another session');
  expect(ui.scopeOrderSaving).toBe(false);
  expect(await db.scope_orders.get('actor')).toMatchObject(server);
  failure = 'permission_denied'; await ui.moveScope('b', -1);
  expect(ui.scopeOrderError).toContain('permission_denied');
  failure = ''; await ui.moveScope('b', -1);
  expect(ui.scopeOrderError).toBe(''); expect(server.row_version).toBe(8);
});

it.each(['actor', 'workspace'])('never submits a save after the %s changes during the revision read', async kind => {
  const transport = fetch;
  vi.stubGlobal('fetch', vi.fn(async (...args) => {
    const response = await transport(...args);
    if (kind === 'actor') ui.session = { npub: 'other-reader' };
    else ui.currentWorkspace = { ...ui.currentWorkspace, workspaceId: 'other-workspace' };
    return response;
  }));
  await ui.moveScope('b', -1);
  expect(requests.map(r => r.method)).toEqual(['GET']);
  expect(ui.scopeOrderNotice).toBeFalsy();
  expect(await db.scope_orders.count()).toBe(0);
});

it.each(['actor', 'workspace', 'database'])('rejects a late acknowledgement after %s changes without contaminating the new partition', async kind => {
  const transport = fetch;
  let newDb;
  vi.stubGlobal('fetch', vi.fn(async (...args) => {
    const response = await transport(...args);
    if (args[1].method === 'PUT') {
      if (kind === 'actor') ui.session = { npub: 'other-reader' };
      if (kind === 'workspace') ui.currentWorkspace = { ...ui.currentWorkspace, workspaceId: 'other-workspace' };
      if (kind === 'database') { newDb = openWorkspaceDb('other-save-partition'); await newDb.open(); await newDb.scope_orders.clear(); }
    }
    return response;
  }));
  await ui.moveScope('b', -1);
  expect(ui.scopeOrderNotice).toBeFalsy();
  expect(ui.scopeOrderError).toContain('changed');
  if (newDb) expect(await newDb.scope_orders.count()).toBe(0);
  else expect((await db.scope_orders.get('actor')).row_version).toBe(7);
});

it('does not accept another reader’s response as a successful save', async () => {
  const transport = fetch;
  vi.stubGlobal('fetch', vi.fn(async (...args) => {
    const response = await transport(...args);
    return args[1].method === 'PUT' ? Response.json({ scope_order: { ...server, actor_id: 'foreign' } }) : response;
  }));
  await ui.moveScope('b', -1);
  expect(ui.scopeOrderNotice).toBeFalsy();
  expect(await db.scope_orders.get('foreign')).toBeUndefined();
  expect((await db.scope_orders.get('actor')).row_version).toBe(7);
});

it('keeps the save busy through the revision read and ignores double moves', async () => {
  const transport = fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (...args) => { await gate; return transport(...args); }));
  const first = ui.moveScope('b', -1);
  expect(ui.scopeOrderSaving).toBe(true);
  await ui.moveScope('c', -1);
  ui.startScopeDrag('c'); await ui.dropScopeBefore('a');
  release(); await first;
  expect(requests.filter(r => r.method === 'PUT')).toHaveLength(1);
  expect(ui.scopeOrderSaving).toBe(false);
});
