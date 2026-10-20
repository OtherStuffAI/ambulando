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
import { canvasWheelIntent, worldPoint, zoomViewport } from '../src/canvas/interactions.js';

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
