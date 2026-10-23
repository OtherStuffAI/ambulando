import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getTowerPgCanvasSnapshot: vi.fn(),
  getTowerPgFile: vi.fn(),
  getTowerPgCanvasNapletHtml: vi.fn(),
  updateTowerPgCanvasNaplet: vi.fn(),
  getTowerPgFileVersionObjectBytes: vi.fn(),
}));
vi.mock('../src/api.js', () => api);

import { getWorkspaceDb, openWorkspaceDb } from '../src/db.js';
import { CANVAS_HTML_ASSET_LIMITS, normalizeCanvasNaplet, normalizeHtmlAssets } from '../src/canvas/projection.js';
import { buildCanvasHtmlDocument, CANVAS_HTML_CSP, splitCanvasHtmlDocument } from '../src/canvas/sandbox.js';
import { CanvasHtmlAssetStore } from '../src/canvas/html-assets.js';
import { CanvasSyncRuntime } from '../src/canvas/sync-service.js';
import { HtmlViewSequencer, htmlPolicyKey, reconcileHtmlViews } from '../src/canvas/html-views.js';
import { registerCanvasHtml } from '../src/canvas/html-naplet.js';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const context = { baseUrl: 'https://tower.example', tower: 'tower', service: 'service', workspaceId: 'workspace', appNpub: 'app', viewer: 'reader', actorId: 'actor', dbKey: 'db' };
const identity = { workspace_id: 'workspace', app_npub: 'app', tower_service_npub: 'tower', workspace_service_npub: 'service' };
const readyAsset = (overrides = {}) => ({ name: 'hero.png', status: 'ready', file_id: uuid(1), version_id: uuid(2), sha256: sha(png), size_bytes: png.byteLength, content_type: 'image/png', ...overrides });

afterEach(async () => {
  vi.clearAllMocks();
  try { await getWorkspaceDb().delete(); } catch {}
});

describe('HTML artefact document normalization', () => {
  const artefact = '<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><title>Daily</title><style>h1{color:red}</style><script>window.early=1</script></head><body class="report" onload="steal()"><h1>Hello</h1><img data-asset="hero.png" alt="Hero"></body></html>';

  it('keeps title, styles, scripts and body attributes while stripping navigation and rebasing', () => {
    const parts = splitCanvasHtmlDocument(artefact);
    expect(parts.head).toContain('<title>Daily</title>');
    expect(parts.head).toContain('<style>h1{color:red}</style>');
    expect(parts.head).toContain('<script>window.early=1</script>');
    expect(parts.head).not.toMatch(/refresh|<base|charset/i);
    expect(parts.htmlAttributes).toBe(' lang="en" class="dark"');
    expect(parts.bodyAttributes).toBe(' class="report"');
    expect(parts.body).toBe('<h1>Hello</h1><img data-asset="hero.png" alt="Hero">');
    expect(splitCanvasHtmlDocument('<p>fragment</p>')).toEqual({ htmlAttributes: '', head: '', bodyAttributes: '', body: '<p>fragment</p>' });
  });

  it('puts policy, guard and asset bridge before any artefact head content and default style first', () => {
    const html = buildCanvasHtmlDocument(artefact, { nonce: 'n0nce', hostOrigin: 'https://app.example' });
    const csp = html.indexOf('Content-Security-Policy'), guard = html.indexOf('window.open=()=>null'), bridge = html.indexOf('wingman-artifact-assets');
    const defaultStyle = html.indexOf('font:14px system-ui'), artefactStyle = html.indexOf('h1{color:red}'), artefactScript = html.indexOf('window.early=1');
    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(guard);
    expect(guard).toBeLessThan(bridge);
    expect(bridge).toBeLessThan(artefactScript);
    expect(defaultStyle).toBeLessThan(artefactStyle);
    expect(html.match(/<head>/g)).toHaveLength(1);
    expect(html.match(/<body/g)).toHaveLength(1);
    expect(html).toContain(`content="${CANVAS_HTML_CSP}"`);
    expect(html).toContain('e.source!==P||e.origin!==O');
    expect(html).toContain('"n0nce"');
    expect(html).not.toMatch(/Authorization|Nostr |nsec|signedTowerPgFetch/);
  });

  it('cannot be broken out of by a hostile nonce or origin string', () => {
    const html = buildCanvasHtmlDocument('<p>x</p>', { nonce: '</script><script>alert(1)</script>', hostOrigin: 'https://a.example' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script\\u003e');
  });
});

describe('HTML artefact projection', () => {
  it('keeps only bounded, exact image references and the version policy', () => {
    const naplet = normalizeCanvasNaplet({
      id: 'html', access: 'ready', row_version: 2, title: 'Daily', layout: {},
      source: { type: 'html', id: uuid(9), version_id: null },
      content: { html: '<p>x</p>', version: '3', digest: 'a'.repeat(64), file_id: uuid(9), version_id: uuid(8), version_number: 3, current_version_id: uuid(8), current_version_number: 3, follows_latest: true,
        assets: [readyAsset(), readyAsset({ name: 'hero.png' }), { name: '../x.png', status: 'ready' }, readyAsset({ name: 'script.js', content_type: 'text/javascript' }), { name: 'gone.png', status: 'unavailable', file_id: 'leak' }] },
    });
    expect(naplet.source).toEqual({ type: 'html', id: uuid(9), version_id: null });
    expect(naplet.content).toMatchObject({ version_number: 3, current_version_number: 3, follows_latest: true, manifest_error: null });
    expect(naplet.content.assets).toEqual([readyAsset(), { name: 'script.js', status: 'unavailable' }, { name: 'gone.png', status: 'unavailable' }]);
  });

  it('enforces per-asset and total byte budgets client-side too', () => {
    const big = CANVAS_HTML_ASSET_LIMITS.assetBytes;
    const rows = normalizeHtmlAssets([
      readyAsset({ name: 'a.png', size_bytes: big }), readyAsset({ name: 'b.png', size_bytes: big }), readyAsset({ name: 'c.png', size_bytes: big }),
      readyAsset({ name: 'd.png', size_bytes: big }), readyAsset({ name: 'e.png', size_bytes: 1 }), readyAsset({ name: 'f.png', size_bytes: big + 1 }),
    ]);
    expect(rows.map(row => `${row.name}:${row.status}`)).toEqual(['a.png:ready', 'b.png:ready', 'c.png:ready', 'd.png:ready', 'e.png:unavailable', 'f.png:unavailable']);
  });

  it('drops version policy and assets from denied naplets', () => {
    expect(normalizeCanvasNaplet({ id: 'x', access: 'denied', row_version: 1, layout: {}, source: { type: 'html', id: uuid(9), version_id: uuid(8) }, content: { assets: [readyAsset()] } }))
      .toEqual({ id: 'x', access: 'denied', layout: { x: 0, y: 0, width: 360, height: 280, z: 1 }, row_version: 1 });
  });
});

describe('private asset store', () => {
  it('fetches through the typed route, verifies size and sha256 and caches in memory only', async () => {
    const fetchBytes = vi.fn(async () => ({ bytes: png.slice().buffer, contentType: 'image/png' }));
    const store = new CanvasHtmlAssetStore(context, { fetchBytes });
    const [first] = await store.resolve([readyAsset(), { name: 'gone.png', status: 'unavailable' }]);
    expect(first.name).toBe('hero.png');
    expect(first.blob.type).toBe('image/png');
    expect(first.blob.size).toBe(png.byteLength);
    await store.resolve([readyAsset()]);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(fetchBytes).toHaveBeenCalledWith('workspace', uuid(1), uuid(2), expect.objectContaining({ baseUrl: 'https://tower.example', appNpub: 'app' }));
    store.retain([]);
    expect(await store.resolve([readyAsset()])).toEqual([]);
    store.retain([readyAsset()]);
    await store.resolve([readyAsset()]);
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    store.clear();
    expect(store.blobs.size).toBe(0);
  });

  it('omits bytes whose digest, size or type does not match the authorized manifest', async () => {
    const tampered = Uint8Array.from(png); tampered[11] = 9;
    const store = new CanvasHtmlAssetStore(context, { fetchBytes: async () => ({ bytes: tampered.buffer }) });
    expect(await store.resolve([readyAsset()])).toEqual([]);
    const short = new CanvasHtmlAssetStore(context, { fetchBytes: async () => ({ bytes: png.slice(0, 4).buffer }) });
    expect(await short.resolve([readyAsset()])).toEqual([]);
    const fetchBytes = vi.fn();
    expect(await new CanvasHtmlAssetStore(context, { fetchBytes }).resolve([readyAsset({ content_type: 'text/html' })])).toEqual([]);
    expect(fetchBytes).not.toHaveBeenCalled();
  });
});

describe('private asset store retries', () => {
  it('retries a transient proxy failure once but never an authority answer', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(Object.assign(new Error('bad gateway'), { status: 502 })).mockResolvedValue({ bytes: png.slice().buffer });
    expect(await new CanvasHtmlAssetStore(context, { fetchBytes: flaky }).resolve([readyAsset()])).toHaveLength(1);
    expect(flaky).toHaveBeenCalledTimes(2);
    const denied = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    expect(await new CanvasHtmlAssetStore(context, { fetchBytes: denied }).resolve([readyAsset()])).toEqual([]);
    expect(denied).toHaveBeenCalledTimes(1);
  });
});

describe('HTML version commands', () => {
  const snapshotPayload = () => ({
    workspace_id: 'workspace', identity, complete: true,
    canvas: { id: 'canvas', title: 'Plan', row_version: 1, position: 1, visibility: { mode: 'workspace' }, viewport: {} },
    naplets: [{ id: 'html', access: 'ready', row_version: 4, title: 'Daily', layout: {}, source: { type: 'html', id: uuid(9), version_id: null }, content: { html: '<p>x</p>', version_id: uuid(8), version_number: 2, current_version_number: 2, follows_latest: true, assets: [] } }],
  });

  it('pins and follows latest with CAS and browses without touching the projection', async () => {
    openWorkspaceDb(`canvas-html-${crypto.randomUUID()}`);
    api.getTowerPgCanvasSnapshot.mockResolvedValue(snapshotPayload());
    api.updateTowerPgCanvasNaplet.mockResolvedValue({});
    api.getTowerPgCanvasNapletHtml.mockResolvedValue({ workspace_id: 'workspace', identity, naplet_id: 'html', content: { html: '<p>old</p>', version_id: uuid(7), version_number: 1, assets: [readyAsset()] }, versions: [{ id: uuid(7), version_number: 1 }, { id: uuid(8), version_number: 2 }] });
    const runtime = new CanvasSyncRuntime(context, 'canvas');
    await runtime.refresh();
    const before = await getWorkspaceDb().canvas_snapshots.toArray();
    const browsed = await runtime.readNapletHtml('html', uuid(7));
    expect(api.getTowerPgCanvasNapletHtml).toHaveBeenCalledWith('workspace', 'canvas', 'html', expect.objectContaining({ versionId: uuid(7), baseUrl: 'https://tower.example', appNpub: 'app' }));
    expect(browsed.content).toMatchObject({ version_number: 1, assets: [readyAsset()] });
    expect(browsed.versions.map(row => row.version_number)).toEqual([2, 1]);
    expect(await getWorkspaceDb().canvas_snapshots.toArray()).toEqual(before);

    await runtime.setNapletVersionPolicy('html', uuid(7));
    expect(api.updateTowerPgCanvasNaplet).toHaveBeenLastCalledWith('workspace', 'canvas', 'html', { source_version_id: uuid(7), expected_row_version: 4 }, expect.anything());
    await runtime.setNapletVersionPolicy('html', null);
    expect(api.updateTowerPgCanvasNaplet).toHaveBeenLastCalledWith('workspace', 'canvas', 'html', { source_version_id: null, expected_row_version: 4 }, expect.anything());
    runtime.stop();
  });

  it('rejects foreign-authority browse responses', async () => {
    openWorkspaceDb(`canvas-html-${crypto.randomUUID()}`);
    api.getTowerPgCanvasSnapshot.mockResolvedValue(snapshotPayload());
    api.getTowerPgCanvasNapletHtml.mockResolvedValue({ workspace_id: 'workspace', identity: { ...identity, tower_service_npub: 'other' }, naplet_id: 'html', content: {} });
    const runtime = new CanvasSyncRuntime(context, 'canvas');
    await runtime.refresh();
    await expect(runtime.readNapletHtml('html', uuid(7))).rejects.toThrow('Invalid Canvas authority response');
    runtime.stop();
  });
});

describe('authority changes while browsing', () => {
  const htmlNaplet = (assets, overrides = {}) => ({ id: 'html', access: 'ready', source: { type: 'html', id: uuid(9), version_id: null }, content: { version_id: uuid(8), current_version_id: uuid(8), assets }, ...overrides });
  const older = readyAsset({ name: 'old.png', version_id: uuid(3) });

  it('strips assets a fresh snapshot does not vouch for and asks for a re-read', () => {
    const naplet = htmlNaplet([readyAsset()]);
    const views = { html: { policyKey: htmlPolicyKey(naplet), authority: 'a1', versions: [{ id: uuid(7) }], content: { version_id: uuid(7), assets: [readyAsset(), older] } } };
    const { views: next, revalidate, keep } = reconcileHtmlViews(views, [naplet], 'a2');
    expect(next.html.content.assets).toEqual([readyAsset(), { name: 'old.png', status: 'unavailable' }]);
    expect(revalidate).toEqual([{ napletId: 'html', versionId: uuid(7) }]);
    expect(keep.map(asset => asset.name)).toEqual(['hero.png', 'hero.png']);
    // The duplicate liveQuery emission of the same snapshot is not a new authority.
    expect(reconcileHtmlViews(next, [naplet], 'a2').revalidate).toEqual([]);
  });

  it('drops views of denied naplets and resets views when policy or latest changes', () => {
    const naplet = htmlNaplet([]);
    const views = { html: { policyKey: htmlPolicyKey(naplet), authority: 'a1', versions: [{ id: uuid(7) }], content: { version_id: uuid(7), assets: [older] } } };
    expect(reconcileHtmlViews(views, [{ id: 'html', access: 'denied' }], 'a2')).toEqual({ views: {}, revalidate: [], keep: [] });
    const published = htmlNaplet([], { content: { version_id: uuid(6), current_version_id: uuid(6), assets: [] } });
    const reset = reconcileHtmlViews(views, [published], 'a2');
    expect(reset.views.html).toMatchObject({ content: null, versions: [] });
    expect(reset.keep).toEqual([]);
  });

  it('orders browse reads per naplet and detects authority moving mid-flight', () => {
    const sequencer = new HtmlViewSequencer();
    const first = sequencer.begin('html'), second = sequencer.begin('html'), versions = sequencer.begin('html:versions');
    expect(sequencer.superseded(first)).toBe(true);
    expect(sequencer.superseded(second)).toBe(false);
    expect(sequencer.superseded(versions)).toBe(false);
    sequencer.advance();
    expect(sequencer.authorityMoved(second)).toBe(true);
    expect(sequencer.authorityMoved(sequencer.begin('html'))).toBe(false);
  });

  it('never caches or returns an in-flight asset revoked before its bytes arrive', async () => {
    let release;
    const fetchBytes = vi.fn(() => new Promise(resolve => { release = () => resolve({ bytes: png.slice().buffer }); }));
    const store = new CanvasHtmlAssetStore(context, { fetchBytes });
    store.retain([readyAsset()]);
    const pending = store.resolve([readyAsset()]);
    await vi.waitFor(() => expect(fetchBytes).toHaveBeenCalled());
    store.retain([]);
    release();
    expect(await pending).toEqual([]);
    expect(store.blobs.size).toBe(0);
    expect(await store.resolve([readyAsset()])).toEqual([]);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it('replaces the iframe document when only asset authority changes', async () => {
    let directive;
    const alpine = { directive: (name, fn) => { directive = fn; } };
    const store = new CanvasHtmlAssetStore(context, { fetchBytes: async () => ({ bytes: png.slice().buffer }) });
    registerCanvasHtml(alpine, { assetStore: () => store });
    const listeners = [];
    vi.stubGlobal('addEventListener', (type, fn) => listeners.push(fn));
    vi.stubGlobal('removeEventListener', () => {});
    vi.stubGlobal('location', { origin: 'https://app.example' });
    const writes = [];
    const iframe = { dataset: {}, contentWindow: null, set srcdoc(value) { writes.push(value); } };
    let value = { version_id: uuid(8), digest: 'd', html: '<img data-asset="hero.png">', assets: [readyAsset()] }, rerun;
    directive(iframe, { expression: 'x' }, {
      evaluateLater: () => callback => callback(value),
      effect: fn => { rerun = fn; fn(); },
      cleanup: () => {},
    });
    expect(writes).toHaveLength(1);
    value = { ...value };
    rerun();
    expect(writes).toHaveLength(1);
    value = { ...value, assets: [{ name: 'hero.png', status: 'unavailable' }] };
    rerun();
    expect(writes).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
