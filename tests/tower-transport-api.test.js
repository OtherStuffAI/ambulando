import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import { importTowerTransports } from '../src/tower-transport.js';
import { createNip98AuthHeader } from '../src/auth/nostr.js';
import * as api from '../src/api.js';

vi.mock('../src/auth/nostr.js', () => ({
  createNip98AuthHeader: vi.fn(async (url, method, body) => JSON.stringify({ url, method, body })),
  createNip98AuthHeaderForSecret: vi.fn(),
}));
vi.mock('../src/crypto/workspace-keys.js', () => ({
  getActiveWorkspaceKeySecretForAuth: () => null,
  getActiveWorkspaceKeyNpub: () => null,
}));
vi.mock('../src/crypto/group-keys.js', () => ({ getActiveSessionNpub: () => 'actor' }));
const logicalTower = 'https://tower.example';
const publicNpub = nip19.npubEncode('12'.repeat(32));
const endpoint = `http://${publicNpub}.fips:41080`;
let native;
beforeEach(() => {
  api.setBaseUrl(logicalTower);
  native = { version: 2, fetch: vi.fn(async () => Response.json({ ok: true })) };
  importTowerTransports([{ logicalTower, mode: 'fips', endpoint, transport: 'native', handle: native }]);
  vi.stubGlobal('window', { fipsTransport: native });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected public request'); }));
  vi.clearAllMocks();
});
afterEach(() => { importTowerTransports([]); vi.unstubAllGlobals(); });

it('routes Message activity through the pinned Tower endpoint with cancellation and no public fallback', async () => {
  const controller = new AbortController();
  await api.getTowerPgMessageActivity('workspace/encoded', '30d', { appNpub: 'app', signal: controller.signal });
  const [url, options] = native.fetch.mock.calls[0];
  expect(url).toBe(`${endpoint}/api/v4/flightdeck-pg/workspaces/workspace%2Fencoded/message-activity?range=30d`);
  expect(JSON.parse(options.headers.Authorization)).toMatchObject({ url, method: 'GET' });
  expect(options.headers['x-flightdeck-pg-app-npub']).toBe('app');
  controller.abort(); expect(options.signal.aborted).toBe(true);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('rejects invalid Message activity ranges and cancellation during signing before sending', async () => {
  await expect(api.getTowerPgMessageActivity('workspace', 'invalid')).rejects.toThrow('Invalid');
  expect(native.fetch).not.toHaveBeenCalled(); expect(createNip98AuthHeader).not.toHaveBeenCalled();
  const controller = new AbortController();
  let release;
  createNip98AuthHeader.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = api.getTowerPgMessageActivity('workspace', 'all', { signal: controller.signal });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  controller.abort(); release('signed');
  await expect(pending).rejects.toThrow(); expect(native.fetch).not.toHaveBeenCalled();
});

it('signs actual endpoint, method and payload for PG reads, sync and writes', async () => {
  await api.getTowerPgWorkspaceDescriptor('workspace', { appNpub: 'app' });
  await api.getTowerPgWorkspaceSync('workspace', { cursor: 'saved-cursor', appNpub: 'app' });
  await api.updateTowerPgWorkspace('workspace', { name: 'Edited' }, { appNpub: 'app' });
  expect(native.fetch).toHaveBeenCalledTimes(3);
  for (const [url, options] of native.fetch.mock.calls) {
    const auth = JSON.parse(options.headers.Authorization);
    expect(auth.url).toBe(url);
    expect(url.startsWith(endpoint + '/api/')).toBe(true);
    expect(auth.method).toBe(options.method);
    if (options.body) expect(auth.body).toEqual(JSON.parse(options.body));
  }
  expect(native.fetch.mock.calls[1][0]).toContain('cursor=saved-cursor');
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(api.getBaseUrl()).toBe(logicalTower);
});

it('rejects foreign absolute links from a FIPS PG response before signing or fetching', async () => {
  await expect(api.getTowerPgWorkspaceDescriptor('workspace', { path: 'https://other.example/descriptor' })).rejects.toThrow('outside the paired Tower');
  expect(createNip98AuthHeader).not.toHaveBeenCalled();
  expect(native.fetch).not.toHaveBeenCalled();
});

it('keeps SDK checkout serialization/error behavior on native transport', async () => {
  await api.acquireRecordCheckout({ recordId: 'record', recordFamilyHash: 'family', identityContext: {
    workspaceServiceNpub: publicNpub, userNpub: publicNpub,
    workspaceUserKeyNpub: publicNpub, signerNpub: publicNpub,
  } });
  expect(native.fetch.mock.calls[0][0]).toBe(`${endpoint}/api/v4/records/record/checkout/acquire`);
  const options = native.fetch.mock.calls[0][1];
  expect(JSON.parse(options.body).record_family_hash).toBe('family');
  expect(JSON.parse(options.headers.Authorization).url).toBe(native.fetch.mock.calls[0][0]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('uses signed Tower storage bytes in FIPS mode instead of public presigned uploads', async () => {
  await api.uploadStorageObject({ object_id: 'object', upload_url: 'https://bucket.example/public-presigned' }, Uint8Array.of(0, 255, 10));
  expect(native.fetch.mock.calls[0][0]).toBe(`${endpoint}/api/v4/storage/object`);
  expect(JSON.parse(native.fetch.mock.calls[0][1].body)).toEqual({ base64_data: 'AP8K' });
  native.fetch.mockImplementation(async () => new Response(Uint8Array.of(4, 5, 255)));
  expect(new Uint8Array(await (await api.downloadStorageObjectBlob('object')).arrayBuffer())).toEqual(Uint8Array.of(4, 5, 255));
  expect(native.fetch.mock.calls[1][0]).toBe(`${endpoint}/api/v4/storage/object/content`);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('keeps mesh workspace locators anchored to the logical Tower without rewriting user metadata', async () => {
  native.fetch.mockImplementation(async () => Response.json({
    tower_base_url: endpoint,
    identity: { workspace_id: 'workspace' },
    metadata: { text: endpoint },
    workspaces: [{ tower_base_url: endpoint, label: 'Existing workspace' }],
  }));
  const descriptor = await api.getTowerPgWorkspaceDescriptor('workspace');
  expect(descriptor.tower_base_url).toBe(logicalTower);
  expect(descriptor.identity.workspace_id).toBe('workspace');
  expect(descriptor.metadata.text).toBe(endpoint);
  expect((await api.listTowerPgWorkspaces()).workspaces[0].tower_base_url).toBe(logicalTower);
});
