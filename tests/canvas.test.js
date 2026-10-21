import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { getWorkspaceDb, openWorkspaceDb } from '../src/db.js';
import {
  CANVAS_ACCESS_MESSAGE,
  canvasContext,
  canvasDefinitionKey,
  normalizeCanvasList,
  normalizeCanvasSnapshot,
} from '../src/canvas/projection.js';
import { buildCanvasHtmlDocument, CANVAS_HTML_CSP } from '../src/canvas/sandbox.js';
import {
  arrowGeometry,
  arrowPoints,
  arrowPath,
  canvasItemKey,
  canvasWheelIntent,
  cloneCanvasValue,
  enclosedItemKeys,
  groupBounds,
  groupDelta,
  moveArrowEndpoint,
  movementItems,
  selectionRect,
  worldPoint,
  zoomViewport,
} from '../src/canvas/interactions.js';

const store = () => ({
  session: { npub: 'reader' },
  currentViewerNpub: 'reader',
  currentPgActorId: 'actor',
  currentWorkspaceKey: 'db',
  currentWorkspace: {
    workspaceId: 'workspace', workspaceOwnerNpub: 'owner', directHttpsUrl: 'https://tower.example', appNpub: 'app',
    towerServiceNpub: 'tower', workspaceServiceNpub: 'service', pgBackendMode: true,
  },
});
const identity = { workspace_id: 'workspace', app_npub: 'app', tower_service_npub: 'tower', workspace_service_npub: 'service' };
const definition = (overrides = {}) => ({ id: 'canvas', title: 'Plan', position: 1, row_version: 2, can_manage: true, visibility: { mode: 'restricted', actor_ids: ['actor'], group_ids: ['group'] }, viewport: { x: 4, y: 5, scale: 1.2 }, ...overrides });

afterEach(async () => {
  try { await getWorkspaceDb().delete(); } catch {}
});

it('normalizes only complete identity-bound visible canvas lists', () => {
  const context = canvasContext(store());
  const rows = normalizeCanvasList({ workspace_id: 'workspace', identity, complete: true, canvases: [definition()] }, context);
  expect(rows[0]).toMatchObject({ canvas_id: 'canvas', title: 'Plan', position: 1, viewport: { x: 4, y: 5, scale: 1.2 } });
  for (const mutate of [
    payload => { payload.complete = false; },
    payload => { payload.workspace_id = 'foreign'; },
    payload => { payload.identity.app_npub = 'foreign'; },
    payload => { payload.canvases.push(definition()); },
  ]) {
    const payload = { workspace_id: 'workspace', identity: { ...identity }, complete: true, canvases: [definition()] };
    mutate(payload);
    expect(() => normalizeCanvasList(payload, context)).toThrow();
  }
});

it('drops all protected metadata for denied naplets and whitelists ready content', () => {
  const context = canvasContext(store());
  const payload = {
    workspace_id: 'workspace', identity, complete: true, canvas: definition(),
    naplets: [
      { id: 'denied', row_version: 1, access: 'denied', title: 'Secret title', source: { type: 'document', id: 'secret-id' }, content: { body: 'secret' }, layout: { x: 1, y: 2 } },
      { id: 'ready', row_version: 1, access: 'ready', title: 'Tasks', source: { type: 'task_list', id: 'list' }, content: { tasks: [{ id: 'task', title: 'Allowed', state: 'new', token: 'never' }], credential: 'never' }, layout: {} },
    ],
  };
  const snapshot = normalizeCanvasSnapshot(payload, context, 'canvas', 'request');
  expect(snapshot.naplets[0]).toEqual({ id: 'denied', access: 'denied', row_version: 1, layout: { x: 1, y: 2, width: 360, height: 280, z: 1 } });
  expect(JSON.stringify(snapshot.naplets[0])).not.toMatch(/Secret|secret-id|document|body/);
  expect(snapshot.naplets[1].content).toEqual({ tasks: [{ id: 'task', title: 'Allowed', state: 'new' }] });
  expect(CANVAS_ACCESS_MESSAGE).toBe('Ask your workspace owner for access.');
});

it('persists Canvas in dedicated viewer projections', async () => {
  const db = openWorkspaceDb(`canvas-${crypto.randomUUID()}`);
  await db.open();
  const context = canvasContext(store());
  const snapshot = normalizeCanvasSnapshot({ workspace_id: 'workspace', identity, complete: true, canvas: definition(), naplets: [] }, context, 'canvas', 'request');
  await db.canvas_snapshots.put(snapshot);
  expect(await db.canvas_snapshots.get(canvasDefinitionKey(context, 'canvas'))).toMatchObject({ canvas_id: 'canvas', request_id: 'request' });
  expect(db.canvas_definitions).toBeTruthy();
});

it('normalizes native elements and redacts denied naplet comment anchors', () => {
  const context = canvasContext(store());
  const snapshot = normalizeCanvasSnapshot({
    workspace_id: 'workspace', identity, complete: true, canvas: definition(),
    naplets: [{ id: 'denied', access: 'denied', row_version: 1, layout: {} }],
    elements: [{ id: 'text-1', kind: 'text', row_version: 1, layout: { x: 4, y: 5, width: 30, height: 20, z: 2 }, data: { text: 'Hello' } }],
    comments: [{ id: 'comment-1', row_version: 1, body: 'Discuss', parent_comment_id: null, anchor: { type: 'naplet', naplet_id: 'denied' }, author: { actor_id: 'actor', label: 'Person' }, created_at: '2026-10-20T00:00:00Z' }],
  }, context, 'canvas', 'request');
  expect(snapshot.elements[0]).toMatchObject({ kind: 'text', data: { text: 'Hello' } });
  expect(snapshot.comments[0].anchor).toEqual({ type: 'canvas', x: 0, y: 0 });
  expect(JSON.stringify(snapshot.comments[0].anchor)).not.toContain('denied');
});

it('pans ordinary wheel input and keeps modifier zoom centred under the pointer', () => {
  expect(canvasWheelIntent({ ctrlKey: false, metaKey: false })).toBe('pan');
  expect(canvasWheelIntent({ ctrlKey: true, metaKey: false })).toBe('zoom');
  const viewport = zoomViewport({ x: 10, y: 20, scale: 1 }, 2, { clientX: 110, clientY: 120 });
  expect(worldPoint(viewport, { clientX: 110, clientY: 120 })).toEqual({ x: 100, y: 100 });
  expect(zoomViewport({ x: 0, y: 0, scale: 3 }, 2, { clientX: 0, clientY: 0 }).scale).toBe(3);
});

it('ports BYO Freedom enclosure, multi-move and persisted group expansion', () => {
  const box = selectionRect({ x: 90, y: 80 }, { x: 0, y: 0 });
  expect(enclosedItemKeys([
    { key: 'naplet:a', left: 10, top: 10, right: 40, bottom: 40 },
    { key: 'element:b', left: 50, top: 20, right: 85, bottom: 70 },
    { key: 'element:outside', left: 80, top: 70, right: 110, bottom: 100 },
  ], box)).toEqual(['naplet:a', 'element:b']);

  const items = [
    { key: 'element:group', type: 'element', item: { id: 'group', layout: { x: 0, y: 0, width: 200, height: 160 }, data: { role: 'group', members: ['naplet:a', 'element:b'] } } },
    { key: 'naplet:a', type: 'naplet', item: { id: 'a', layout: { x: 10, y: 20, width: 40, height: 50 } } },
    { key: 'element:b', type: 'element', item: { id: 'b', layout: { x: 70, y: 80, width: 30, height: 20 }, data: {} } },
  ];
  const moving = movementItems(items, ['element:group']);
  expect(moving.map(row => row.key)).toEqual(['element:group', 'naplet:a', 'element:b']);
  expect(groupDelta(moving, -60000, 12)).toEqual({ x: -50000, y: 12 });
  expect(groupBounds(items.slice(1).map(row => row.item), 10)).toEqual({ x: 0, y: 10, width: 110, height: 100 });
  expect(canvasItemKey('naplet', 'a')).toBe('naplet:a');
});

it('creates and edits directional arrow endpoints without changing the Tower element contract', () => {
  const created = arrowGeometry({ x: 90, y: 20 }, { x: 10, y: 70 });
  expect(created).toEqual({
    layout: { x: 10, y: 20, width: 80, height: 50 },
    data: { start: [80, 0], end: [0, 50] },
  });
  const edited = moveArrowEndpoint(created.layout, created.data, 'end', { x: 130, y: 90 });
  expect(edited.layout).toEqual({ x: 90, y: 20, width: 40, height: 70 });
  expect(edited.data).toEqual({ start: [0, 0], end: [40, 70] });
});

it('copies reactive Canvas layout and data into structured-clone-safe history values', () => {
  const reactiveLayout = new Proxy({ x: 12, y: 24, width: 360, height: 280, z: 2 }, {});
  const reactiveData = new Proxy({ text: 'Note', points: [[0, 0], [10, 12]] }, {});
  expect(() => structuredClone(reactiveLayout)).toThrow();
  expect(() => structuredClone(reactiveData)).toThrow();

  const layout = cloneCanvasValue(reactiveLayout);
  const data = cloneCanvasValue(reactiveData);
  expect(layout).toEqual({ x: 12, y: 24, width: 360, height: 280, z: 2 });
  expect(data).toEqual({ text: 'Note', points: [[0, 0], [10, 12]] });
  expect(() => structuredClone({ layout, data, history: { before: layout, after: { ...layout, x: 40 } } })).not.toThrow();
});

it('builds an opaque-origin HTML boundary with no host, network, form, frame or popup capability', () => {
  const html = buildCanvasHtmlDocument('<a href="https://evil.example">leave</a><script>fetch("https://evil.example");window.open("https://evil.example")</script>');
  expect(CANVAS_HTML_CSP).toContain("default-src 'none'");
  expect(CANVAS_HTML_CSP).toContain("connect-src 'none'");
  expect(CANVAS_HTML_CSP).toContain("form-action 'none'");
  expect(CANVAS_HTML_CSP).toContain("frame-src 'none'");
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('fetch('));
  expect(html.indexOf('window.open=()=>null')).toBeLessThan(html.lastIndexOf('window.open('));
  expect(html).toContain("closest('a[href],form')");
});


it('retains board marker coordinates independently of an explicit readable naplet subject', () => {
  const context = canvasContext(store());
  const snapshot = normalizeCanvasSnapshot({ workspace_id: 'workspace', identity, complete: true, canvas: definition(),
    naplets: [{ id: 'naplet', access: 'ready', row_version: 1, layout: {}, source: { type: 'task_list', id: 'channel' }, content: {} }],
    comments: [{ id: 'comment', row_version: 1, body: 'Discuss', anchor: { type: 'naplet', naplet_id: 'naplet', x: 80, y: 400 }, author: { actor_id: 'actor' } }],
  }, context, 'canvas', 'request');
  expect(snapshot.comments[0].anchor).toEqual({ type: 'naplet', naplet_id: 'naplet', x: 80, y: 400 });
});

it('bends legacy and directional arrows with a handle on the curve and fixed opposite endpoints', () => {
  const layout = { x: 100, y: 200, width: 200, height: 80, z: 3 };
  const data = { direction: 'forward', custom: 'preserved' };
  expect(arrowPath(layout, data)).toBe('M 0 80 L 200 0');
  const bent = moveArrowEndpoint(layout, data, 'middle', { x: 200, y: 160 });
  const world = (row, key) => arrowPoints(row.layout, row.data)[key].map((v, i) => v + (i ? row.layout.y : row.layout.x));
  expect(world(bent, 'start')).toEqual([100, 280]);
  expect(world(bent, 'end')).toEqual([300, 200]);
  expect(world(bent, 'middle')).toEqual([200, 160]);
  expect(bent.data.custom).toBe('preserved');
  expect(arrowPath(bent.layout, bent.data)).toContain(' Q ');
  const moved = moveArrowEndpoint(bent.layout, bent.data, 'start', { x: 350, y: 300 });
  expect(world(moved, 'start')).toEqual([350, 300]);
  expect(world(moved, 'end')).toEqual([300, 200]);
  expect(moved.layout.z).toBe(3);
  expect(moved.data.curve.map((v, i) => v + (i ? moved.layout.y : moved.layout.x))).toEqual(bent.data.curve.map((v, i) => v + (i ? bent.layout.y : bent.layout.x)));
});

it('keeps horizontal, vertical, and reversed arrow geometry finite', () => {
  for (const end of [{ x: 100, y: 0 }, { x: 0, y: -100 }, { x: -100, y: -50 }]) {
    const row = arrowGeometry({ x: 0, y: 0 }, end);
    expect(row.layout.width).toBeGreaterThanOrEqual(8);
    expect(row.layout.height).toBeGreaterThanOrEqual(8);
    expect(arrowPoints(row.layout, row.data).end.map((v, i) => v + (i ? row.layout.y : row.layout.x))).toEqual([end.x, end.y]);
  }
});

it('keeps Canvas Link projections title-only and strips denied destination metadata', async () => {
  const { normalizeCanvasNaplet } = await import('../src/canvas/projection.js');
  const row = { id: 'link', access: 'ready', source: { type: 'canvas', id: 'destination' }, title: 'Optional label', content: { title: 'Destination title', html: 'secret', thumbnail: 'secret.png', naplets: [{ content: 'nested' }] }, layout: {}, row_version: 1 };
  expect(normalizeCanvasNaplet(row)).toMatchObject({ title: 'Optional label', source: { type: 'canvas', id: 'destination' }, content: { title: 'Destination title' } });
  expect(Object.keys(normalizeCanvasNaplet(row).content)).toEqual(['title']);
  const denied = normalizeCanvasNaplet({ ...row, access: 'denied' });
  expect(Object.keys(denied).sort()).toEqual(['access', 'id', 'layout', 'row_version']);
});
