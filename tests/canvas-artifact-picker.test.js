import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getTowerPgWorkspaceScopes: vi.fn(),
  getTowerPgScopeChannels: vi.fn(),
  getTowerPgChannelFiles: vi.fn(),
  getTowerPgFileVersions: vi.fn(),
  getTowerPgFileVersionObjectBytes: vi.fn(),
}));
vi.mock('../src/api.js', () => api);

import { ARTIFACT_LIST_LIMIT, ArtifactCatalog, artifactKind, artifactTitle, canvasArtifactPickerStore, parseArtifactManifest } from '../src/canvas/artifact-picker.js';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const context = { baseUrl: 'https://tower.example', workspaceId: 'workspace', appNpub: 'app' };
const png = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
const manifest = assets => `<script type="application/json" id="wingman-artifact-assets">${JSON.stringify({ version: 1, assets })}</script>`;
const htmlFile = (id, channel, name, extra = {}) => ({ id, channel_id: channel, display_name: name, metadata: { html_artifact: true }, current_version_id: `${id}-v`, updated_at: '2026-10-21T00:00:00Z', ...extra });

afterEach(() => { vi.clearAllMocks(); });

describe('artefact classification', () => {
  it('recognises HTML Files by Tower marker or name, boards by kind, type or extension', () => {
    expect(artifactKind({ id: 'a', display_name: 'Team daily catch-up — HTML example', metadata: { html_artifact: true } })).toBe('html');
    expect(artifactKind({ id: 'a', display_name: 'report.HTML', metadata: {} })).toBe('html');
    expect(artifactKind({ id: 'a', display_name: 'photo.png', metadata: {} })).toBeNull();
    expect(artifactKind({ id: 'a', display_name: 'Plan.excalidraw' })).toBe('excalidraw');
    expect(artifactKind({ id: 'a', display_name: 'x', metadata: { kind: 'excalidraw_board' } })).toBe('excalidraw');
    expect(artifactKind({ id: 'a', display_name: 'old.html', metadata: { html_artifact: true }, archived_at: '2026-01-01' })).toBeNull();
    expect(artifactTitle({ display_name: 'Plan.excalidraw', metadata: { title: 'Roadmap' } }, 'excalidraw')).toBe('Roadmap');
    expect(artifactTitle({ display_name: 'Plan.excalidraw' }, 'excalidraw')).toBe('Plan');
  });

  it('mirrors Tower manifest validation', () => {
    const entry = { name: 'hero.png', file_id: uuid(1), version_id: uuid(2), sha256: 'a'.repeat(64) };
    expect(parseArtifactManifest(manifest([entry]))).toEqual([entry]);
    expect(parseArtifactManifest(manifest([entry, entry]))).toEqual([]);
    expect(parseArtifactManifest(manifest([{ ...entry, name: '../x' }]))).toEqual([]);
    expect(parseArtifactManifest(manifest([entry]) + manifest([entry]))).toEqual([]);
    expect(parseArtifactManifest('<p>none</p>')).toEqual([]);
  });
});

describe('ArtifactCatalog', () => {
  it('lists visible scopes and only the selected scope\'s channels', async () => {
    api.getTowerPgWorkspaceScopes.mockResolvedValue({ scopes: [{ id: 's2', name: 'Zeta' }, { id: 's1', name: 'Alpha' }, { id: 's3', name: 'Gone', archived_at: 'x' }] });
    api.getTowerPgScopeChannels.mockResolvedValue({ channels: [{ id: 'c1', scope_id: 's1', name: 'General' }, { id: 'c9', scope_id: 'other', name: 'Leak' }] });
    const catalog = new ArtifactCatalog(context);
    expect(await catalog.scopes()).toEqual({ scopes: [{ id: 's1', title: 'Alpha' }, { id: 's2', title: 'Zeta' }], truncated: false });
    expect(await catalog.channels('s1')).toEqual({ channels: [{ id: 'c1', title: 'General' }], truncated: false });
    expect(api.getTowerPgWorkspaceScopes).toHaveBeenCalledWith('workspace', expect.objectContaining({ limit: ARTIFACT_LIST_LIMIT }));
    expect(api.getTowerPgScopeChannels).toHaveBeenCalledWith('workspace', 's1', expect.objectContaining({ baseUrl: 'https://tower.example', appNpub: 'app' }));
  });

  it('merges all channels in a scope, keeps the requested kind and reports unreadable channels', async () => {
    api.getTowerPgChannelFiles.mockImplementation(async (_w, channelId) => {
      if (channelId === 'denied') throw Object.assign(new Error('nope'), { status: 403 });
      return { files: [htmlFile(`${channelId}-h`, channelId, `${channelId} report`), { id: `${channelId}-b`, channel_id: channelId, display_name: 'Board.excalidraw' }, { id: `${channelId}-p`, channel_id: channelId, display_name: 'pic.png' }] };
    });
    const catalog = new ArtifactCatalog(context);
    const result = await catalog.files([{ id: 'a', title: 'A' }, { id: 'denied', title: 'Private' }, { id: 'b', title: 'B' }], 'html');
    expect(result.files.map(file => file.id)).toEqual(['a-h', 'b-h']);
    expect(result.files[0]).toMatchObject({ kind: 'html', title: 'a report', channelTitle: 'A', currentVersionId: 'a-h-v' });
    expect(result.unavailable).toEqual([{ id: 'denied', title: 'Private', status: 403 }]);
    expect(result.truncated).toEqual([]);
    expect(api.getTowerPgFileVersionObjectBytes).not.toHaveBeenCalled();
  });

  it('reports Tower list pages that came back full instead of implying a complete list', async () => {
    const many = n => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, name: `Row ${i}` }));
    api.getTowerPgWorkspaceScopes.mockResolvedValue({ scopes: many(ARTIFACT_LIST_LIMIT), next_cursor: null });
    api.getTowerPgScopeChannels.mockResolvedValue({ channels: many(ARTIFACT_LIST_LIMIT - 1) });
    api.getTowerPgChannelFiles.mockImplementation(async (_w, channelId) => ({
      files: Array.from({ length: channelId === 'busy' ? ARTIFACT_LIST_LIMIT : 2 }, (_, i) => htmlFile(`${channelId}-${i}`, channelId, `${channelId} ${i}`)),
    }));
    const catalog = new ArtifactCatalog(context);
    expect((await catalog.scopes()).truncated).toBe(true);
    expect((await catalog.channels('s1')).truncated).toBe(false);
    const result = await catalog.files([{ id: 'busy', title: 'Busy' }, { id: 'calm', title: 'Calm' }], 'html');
    expect(result.files).toHaveLength(ARTIFACT_LIST_LIMIT + 2);
    expect(result.truncated).toEqual([{ id: 'busy', title: 'Busy' }]);
    expect(api.getTowerPgChannelFiles).toHaveBeenCalledWith('workspace', 'busy', expect.objectContaining({ limit: ARTIFACT_LIST_LIMIT }));
  });

  it('describes an old image version beyond the newest-200 page from its exact version object', async () => {
    const old = { name: 'old.png', file_id: uuid(1), version_id: uuid(2), sha256: sha(png) };
    const forged = { name: 'forged.png', file_id: uuid(1), version_id: uuid(3), sha256: 'd'.repeat(64) };
    const missing = { name: 'gone.png', file_id: uuid(6), version_id: uuid(7), sha256: sha(png) };
    const page = fileId => Array.from({ length: ARTIFACT_LIST_LIMIT }, (_, i) => ({ id: `${fileId}-new-${i}`, file_id: fileId, content_type: 'image/png', size_bytes: 1, sha256_hex: 'e'.repeat(64) }));
    api.getTowerPgFileVersions.mockImplementation(async (_w, fileId) => ({ versions: fileId === uuid(6) ? page(fileId).slice(0, 3) : page(fileId) }));
    api.getTowerPgFileVersionObjectBytes.mockImplementation(async (_w, _f, versionId) => {
      if (versionId === uuid(2) || versionId === uuid(3)) return { bytes: png.buffer.slice(0), contentType: 'image/png' };
      throw Object.assign(new Error('nope'), { status: 404 });
    });
    const assets = await new ArtifactCatalog(context).assets([old, forged, missing]);
    expect(assets).toEqual([
      { name: 'old.png', status: 'ready', file_id: uuid(1), version_id: uuid(2), sha256: sha(png), size_bytes: png.byteLength, content_type: 'image/png' },
      { name: 'forged.png', status: 'unavailable' },
      { name: 'gone.png', status: 'unavailable' },
    ]);
    // Only Files whose metadata page was full use the exact object route.
    expect(api.getTowerPgFileVersionObjectBytes.mock.calls.map(call => call[2])).toEqual([uuid(2), uuid(3)]);
  });

  it('previews only the selected File, verifies its digest and resolves manifest images like Tower', async () => {
    const assets = [
      { name: 'hero.png', file_id: uuid(1), version_id: uuid(2), sha256: sha(png) },
      { name: 'swapped.png', file_id: uuid(1), version_id: uuid(3), sha256: 'b'.repeat(64) },
      { name: 'secret.png', file_id: uuid(4), version_id: uuid(5), sha256: sha(png) },
    ];
    const bytes = new TextEncoder().encode(`<h1>Daily</h1><img data-asset="hero.png">${manifest(assets)}`);
    api.getTowerPgFileVersions.mockImplementation(async (_w, fileId) => {
      if (fileId === 'file') return { versions: [{ id: 'file-v', file_id: 'file', content_type: 'text/html', size_bytes: bytes.byteLength, sha256_hex: sha(bytes), version_number: 3 }] };
      if (fileId === uuid(1)) return { versions: [{ id: uuid(2), file_id: uuid(1), content_type: 'image/png', size_bytes: png.byteLength, sha256_hex: sha(png) }, { id: uuid(3), file_id: uuid(1), content_type: 'image/png', size_bytes: 3, sha256_hex: 'c'.repeat(64) }] };
      throw Object.assign(new Error('denied'), { status: 403 });
    });
    api.getTowerPgFileVersionObjectBytes.mockResolvedValue({ bytes: bytes.buffer.slice(0), contentType: 'text/html' });
    const content = await new ArtifactCatalog(context).preview({ id: 'file', kind: 'html', currentVersionId: 'file-v' });
    expect(content).toMatchObject({ version_id: 'file-v', version_number: 3, digest: sha(bytes) });
    expect(content.html).toContain('<h1>Daily</h1>');
    expect(content.assets).toEqual([
      { name: 'hero.png', status: 'ready', file_id: uuid(1), version_id: uuid(2), sha256: sha(png), size_bytes: png.byteLength, content_type: 'image/png' },
      { name: 'swapped.png', status: 'unavailable' },
      { name: 'secret.png', status: 'unavailable' },
    ]);
    expect(api.getTowerPgFileVersionObjectBytes).toHaveBeenCalledTimes(1);
  });

  it('refuses tampered, non-HTML or oversized versions', async () => {
    const bytes = new TextEncoder().encode('<p>x</p>');
    api.getTowerPgFileVersionObjectBytes.mockResolvedValue({ bytes: bytes.buffer.slice(0) });
    const catalog = new ArtifactCatalog(context), file = { id: 'f', kind: 'html', currentVersionId: 'v' };
    api.getTowerPgFileVersions.mockResolvedValue({ versions: [{ id: 'v', file_id: 'f', content_type: 'text/html', size_bytes: bytes.byteLength, sha256_hex: 'a'.repeat(64) }] });
    await expect(catalog.preview(file)).rejects.toThrow(/did not match/);
    api.getTowerPgFileVersions.mockResolvedValue({ versions: [{ id: 'v', file_id: 'f', content_type: 'image/png', size_bytes: 10, sha256_hex: sha(bytes) }] });
    await expect(catalog.preview(file)).rejects.toMatchObject({ status: 415 });
    api.getTowerPgFileVersions.mockResolvedValue({ versions: [{ id: 'v', file_id: 'f', content_type: 'text/html', size_bytes: 3 * 1024 * 1024, sha256_hex: sha(bytes) }] });
    await expect(catalog.preview(file)).rejects.toMatchObject({ status: 415 });
  });
});

describe('canvas artefact picker state', () => {
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  function makeStore(catalog, assetStore = { retain: vi.fn(), clear: vi.fn() }) {
    const store = { ...canvasArtifactPickerStore({ createCatalog: () => catalog, createAssetStore: () => assetStore }), addDialog: { type: 'html', sourceId: '', title: '' }, context: () => context };
    return { store, assetStore };
  }
  const baseCatalog = (overrides = {}) => ({
    scopes: vi.fn(async () => ({ scopes: [{ id: 's1', title: 'Alpha' }, { id: 's2', title: 'Beta' }], truncated: false })),
    channels: vi.fn(async scopeId => ({ channels: scopeId === 's1' ? [{ id: 'c1', title: 'General' }, { id: 'c2', title: 'Design' }] : [], truncated: false })),
    files: vi.fn(async channels => ({ files: channels.map(channel => ({ id: `${channel.id}-f`, kind: 'html', title: `${channel.title} report`, channelId: channel.id, currentVersionId: 'v' })), unavailable: [], truncated: [] })),
    preview: vi.fn(async () => ({ html: '<p>hi</p>', version_id: 'v', digest: 'd', assets: [] })),
    ...overrides,
  });

  it('requires a scope first, then lists all channels or one channel', async () => {
    const catalog = baseCatalog();
    const { store } = makeStore(catalog);
    await store.openArtifactPicker('html');
    expect(store.artifactPicker).toMatchObject({ status: 'choose-scope', files: [], channels: [] });
    expect(catalog.channels).not.toHaveBeenCalled();
    await store.chooseArtifactScope('s1');
    expect(store.artifactPicker.status).toBe('ready');
    expect(store.artifactFileList().map(file => file.id)).toEqual(['c1-f', 'c2-f']);
    await store.chooseArtifactChannel('c2');
    expect(store.artifactFileList().map(file => file.id)).toEqual(['c2-f']);
    await store.chooseArtifactChannel('');
    expect(store.artifactFileList()).toHaveLength(2);
    store.artifactPicker.query = 'design';
    expect(store.artifactFileList().map(file => file.id)).toEqual(['c2-f']);
  });

  it('changing scope clears the channel, selection and preview', async () => {
    const assetStore = { retain: vi.fn(), clear: vi.fn() };
    const { store } = makeStore(baseCatalog(), assetStore);
    await store.openArtifactPicker('html');
    await store.chooseArtifactScope('s1');
    await store.chooseArtifactChannel('c1');
    await store.selectArtifact(store.artifactPicker.files[0]);
    expect(store.addDialog.sourceId).toBe('c1-f');
    expect(store.artifactPicker.preview.status).toBe('ready');
    expect(store.previewAssetStore()).toBe(assetStore);
    await store.chooseArtifactScope('s2');
    expect(store.artifactPicker).toMatchObject({ scopeId: 's2', channelId: '', files: [], status: 'empty' });
    expect(store.addDialog.sourceId).toBe('');
    expect(store.artifactPicker.preview.status).toBe('idle');
    expect(assetStore.clear).toHaveBeenCalled();
    expect(store.previewAssetStore()).toBeNull();
  });

  it('ignores an unknown channel and stale responses from an earlier scope', async () => {
    const slow = deferred();
    const catalog = baseCatalog({ channels: vi.fn(scopeId => scopeId === 's1' ? slow.promise : Promise.resolve({ channels: [], truncated: false })) });
    const { store } = makeStore(catalog);
    await store.openArtifactPicker('html');
    const first = store.chooseArtifactScope('s1');
    await store.chooseArtifactScope('s2');
    slow.resolve({ channels: [{ id: 'c1', title: 'General' }], truncated: false });
    await first;
    expect(store.artifactPicker).toMatchObject({ scopeId: 's2', channels: [], status: 'empty' });
    await store.chooseArtifactScope('s1');
    await store.chooseArtifactChannel('not-in-scope');
    expect(store.artifactPicker.channelId).toBe('');
  });

  it('only selects Files in the current list and reports denied previews neutrally', async () => {
    const catalog = baseCatalog({ preview: vi.fn(async () => { throw Object.assign(new Error('x'), { status: 403 }); }) });
    const { store } = makeStore(catalog);
    await store.openArtifactPicker('html');
    await store.chooseArtifactScope('s1');
    await store.selectArtifact({ id: 'forged', kind: 'html' });
    expect(store.addDialog.sourceId).toBe('');
    await store.selectArtifact(store.artifactPicker.files[0]);
    expect(store.artifactPicker.preview).toMatchObject({ status: 'error', error: 'This artefact is unavailable to you.' });
  });

  it('shows an error when every channel is unreadable or scopes fail', async () => {
    const { store } = makeStore(baseCatalog({ files: vi.fn(async channels => ({ files: [], unavailable: channels, truncated: [] })) }));
    await store.openArtifactPicker('html');
    await store.chooseArtifactScope('s1');
    expect(store.artifactPicker).toMatchObject({ status: 'error', error: 'Files in this scope are unavailable to you.' });
    const failing = makeStore(baseCatalog({ scopes: vi.fn(async () => { throw new Error('offline'); }) })).store;
    await failing.openArtifactPicker('html');
    expect(failing.artifactPicker.status).toBe('error');
  });

  it('drops a preview that finishes after the selection changed', async () => {
    const slow = deferred();
    const assetStore = { retain: vi.fn(), clear: vi.fn() };
    const catalog = baseCatalog({ preview: vi.fn(file => file.id === 'c1-f' ? slow.promise : Promise.resolve({ html: '<p>2</p>', version_id: 'v2', digest: 'd', assets: [] })) });
    const { store } = makeStore(catalog, assetStore);
    await store.openArtifactPicker('html');
    await store.chooseArtifactScope('s1');
    const first = store.selectArtifact(store.artifactPicker.files[0]);
    await store.selectArtifact(store.artifactPicker.files[1]);
    slow.resolve({ html: '<p>1</p>', version_id: 'v1', digest: 'd', assets: [] });
    await first;
    expect(store.artifactPicker.preview).toMatchObject({ fileId: 'c2-f', content: { version_id: 'v2' } });
    expect(store.addDialog.sourceId).toBe('c2-f');
  });

  // Closing the dialog, switching naplet type or narrowing the channel while
  // a preview is in flight aborts its fetch and never creates an asset store.
  for (const [label, interrupt] of [
    ['closing the dialog', store => store.resetArtifactPicker()],
    ['switching to another naplet type', store => store.syncArtifactPicker('document', 'create')],
    ['switching to board linking', store => store.syncArtifactPicker('excalidraw', 'link')],
    ['narrowing the channel', store => store.chooseArtifactChannel('c2')],
  ]) {
    it(`aborts a pending preview when ${label}`, async () => {
      const slow = deferred();
      let signal;
      const createAssetStore = vi.fn(() => ({ retain: vi.fn(), clear: vi.fn() }));
      const catalog = baseCatalog({ preview: vi.fn((_file, options) => { signal = options.signal; return slow.promise; }) });
      const store = { ...canvasArtifactPickerStore({ createCatalog: () => catalog, createAssetStore }), addDialog: { type: 'html', sourceId: '', title: '' }, context: () => context };
      await store.openArtifactPicker('html');
      await store.chooseArtifactScope('s1');
      const pending = store.selectArtifact(store.artifactPicker.files[0]);
      expect(store.artifactPicker.preview.status).toBe('loading');
      await interrupt(store);
      expect(signal.aborted).toBe(true);
      slow.resolve({ html: '<p>late</p>', version_id: 'v', digest: 'd', assets: [{ name: 'a.png', status: 'ready' }] });
      await pending;
      expect(createAssetStore).not.toHaveBeenCalled();
      expect(store.previewAssetStore()).toBeNull();
      expect(store.artifactPicker.preview).toMatchObject({ status: 'idle', content: null });
      expect(store.addDialog.sourceId).toBe('');
    });
  }

  it('purges preview bytes when the dialog closes after a preview is shown', async () => {
    const assetStore = { retain: vi.fn(), clear: vi.fn() };
    const { store } = makeStore(baseCatalog(), assetStore);
    await store.openArtifactPicker('html');
    await store.chooseArtifactScope('s1');
    await store.selectArtifact(store.artifactPicker.files[0]);
    expect(store.previewAssetStore()).toBe(assetStore);
    store.resetArtifactPicker();
    expect(assetStore.clear).toHaveBeenCalledTimes(1);
    expect(store.previewAssetStore()).toBeNull();
    expect(store.artifactPicker).toMatchObject({ kind: '', files: [], preview: { status: 'idle', content: null } });
  });

  it('pages a long merged list instead of cutting it off and explains Tower limits', async () => {
    const files = Array.from({ length: 450 }, (_, i) => ({ id: `f${i}`, kind: 'html', title: `Report ${String(i).padStart(3, '0')}`, channelId: 'c1', currentVersionId: 'v' }));
    const { store } = makeStore(baseCatalog({
      channels: vi.fn(async scopeId => ({ channels: scopeId === 's1' ? [{ id: 'c1', title: 'General' }] : [], truncated: scopeId === 's1' })),
      files: vi.fn(async () => ({ files, unavailable: [], truncated: [{ id: 'c1', title: 'General' }] })),
    }));
    await store.openArtifactPicker('html');
    await store.chooseArtifactScope('s1');
    expect(store.artifactFileList()).toHaveLength(200);
    expect(store.artifactHiddenCount()).toBe(250);
    expect(store.artifactStatusText()).toBe('200 of 450 HTML artefacts in this scope.');
    store.showMoreArtifacts(); store.showMoreArtifacts();
    expect(store.artifactFileList()).toHaveLength(450);
    expect(store.artifactHiddenCount()).toBe(0);
    expect(store.artifactLimitText()).toBe('Only the first 200 channels in this scope are listed. Only the 200 most recently updated Files in General are listed; older artefacts there are not shown.');
    await store.chooseArtifactScope('s2');
    expect(store.artifactLimitText()).toBe('');
    expect(store.artifactPicker.shown).toBe(200);
  });
});

describe('canvas artefact picker dialog wiring', () => {
  it('opens for HTML and board linking only, and explains each state', async () => {
    const catalog = {
      scopes: vi.fn(async () => ({ scopes: [{ id: 's1', title: 'Alpha' }], truncated: false })),
      channels: vi.fn(async () => ({ channels: [{ id: 'c1', title: 'General' }, { id: 'c2', title: 'Private' }], truncated: false })),
      files: vi.fn(async () => ({ files: [{ id: 'f1', kind: 'html', title: 'Daily', channelId: 'c1', currentVersionId: 'v' }], unavailable: [{ id: 'c2', title: 'Private' }], truncated: [] })),
      preview: vi.fn(async () => ({ html: '<p/>', version_id: 'v', version_number: 4, digest: 'd', assets: [] })),
    };
    const store = { ...canvasArtifactPickerStore({ createCatalog: () => catalog, createAssetStore: () => ({ retain() {}, clear() {} }) }), addDialog: { type: 'document', sourceId: '', title: '' }, context: () => context };
    store.syncArtifactPicker('document', 'create');
    expect(store.artifactPicker.kind).toBe('');
    store.syncArtifactPicker('excalidraw', 'create');
    expect(store.artifactPicker.kind).toBe('');
    store.addDialog.type = 'html';
    store.syncArtifactPicker('html', 'create');
    await vi.waitFor(() => expect(store.artifactPicker.status).toBe('choose-scope'));
    expect(store.artifactStatusText()).toBe('Choose a scope to see its HTML artefacts.');
    expect(store.artifactPreviewText()).toBe('Select an artefact to preview it.');
    await store.chooseArtifactScope('s1');
    expect(store.artifactStatusText()).toBe('1 of 1 HTML artefacts in this scope. 1 channel unavailable.');
    expect(store.artifactSelectionValid()).toBe(false);
    await store.selectArtifact(store.artifactPicker.files[0]);
    expect(store.artifactSelectionValid()).toBe(true);
    expect(store.artifactPreviewText()).toBe('Daily · v4 · adds as latest');
    store.syncArtifactPicker('excalidraw', 'link');
    expect(store.artifactPicker.kind).toBe('excalidraw');
    await vi.waitFor(() => expect(store.artifactPicker.status).toBe('choose-scope'));
    expect(store.artifactStatusText()).toBe('Choose a scope to see its boards.');
    store.syncArtifactPicker('task_list', 'link');
    expect(store.artifactPicker).toMatchObject({ kind: '', status: 'idle' });
  });
});
