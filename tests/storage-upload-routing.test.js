// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../src/auth/nostr.js', () => ({
  createNip98AuthHeader: vi.fn(async () => 'Nostr synthetic-auth'),
  createNip98AuthHeaderForSecret: vi.fn(async () => 'Nostr synthetic-auth'),
}));
vi.mock('../src/crypto/workspace-keys.js', () => ({
  getActiveWorkspaceKeyNpub: vi.fn(() => null),
  getActiveWorkspaceKeySecretForAuth: vi.fn(() => null),
}));
vi.mock('../src/crypto/group-keys.js', () => ({
  getActiveSessionNpub: vi.fn(() => 'synthetic-session'),
}));
vi.mock('../src/tower-transport.js', () => ({
  towerFetch: fetchMock,
  nativeTowerFetch: fetchMock,
  resolveTowerSigningUrl: (url) => url,
  normalizeTowerConnectionResponse: (value) => value,
  getTowerTransport: (url) => ({ mode: url === 'https://selected.example' ? 'fips' : 'https' }),
}));
import { observeDiagnostics } from '../src/diagnostics-events.js';
import { setBaseUrl, uploadStorageObject, completeStorageObject } from '../src/api.js';

const options = { baseUrl: 'https://selected.example' };
const prepared = { object_id: 'fixture', upload_url: 'https://presigned.example/object' };
const bytes = new Uint8Array([1]);
beforeEach(() => {
  fetchMock.mockReset();
  setBaseUrl('https://default.example');
});
describe('storage upload backend routing', () => {
  it('uses the selected FIPS backend for transfer and complete without attempting the presigned URL', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ object_id: 'fixture' })),
    );
    await uploadStorageObject(prepared, bytes, 'image/png', options);
    await completeStorageObject('fixture', {}, options);
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['PUT', 'https://selected.example/api/v4/storage/fixture'],
      ['POST', 'https://selected.example/api/v4/storage/fixture/complete'],
    ]);
  });
  it('keeps revoked storage authority terminal without public fallback', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'storage_forbidden' }), { status: 403 }),
    );
    await expect(uploadStorageObject(prepared, bytes, 'image/png', options)).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://selected.example/api/v4/storage/fixture');
  });
  it('rejects a truncated successful response body instead of reporting transfer success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('truncated body');
      },
    });
    await expect(uploadStorageObject(prepared, bytes, 'image/png', options)).rejects.toThrow(
      'truncated body',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

 it('keeps a failed presigned attempt as history when the existing signed fallback succeeds', async () => {
  const events=[]; const stop=observeDiagnostics(event=>events.push(event));
  try {
    fetchMock.mockResolvedValueOnce(new Response('', {status:404})).mockResolvedValueOnce(new Response(JSON.stringify({object_id:'fixture'})));
    await uploadStorageObject(prepared, bytes, 'image/png', {baseUrl:'https://https.example'});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.filter(event=>event.code==='request').map(event=>event.status)).toEqual([404,200]);
    expect(events.at(-1)).toMatchObject({outcome:'fallback',level:'info',stage:'transfer'});
    expect(events.some(event=>event.level==='error')).toBe(false);
  } finally {stop();}
 });
