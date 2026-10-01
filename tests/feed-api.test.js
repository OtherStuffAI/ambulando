import { afterEach, describe, expect, it, vi } from 'vitest';
const sign = vi.hoisted(() => vi.fn(async (url, method, body) => `reader ${method} ${url} ${body ? JSON.stringify(body) : ''}`));
const workspaceSign = vi.hoisted(() => vi.fn(() => 'must-not-use-workspace-key'));
vi.mock('../src/auth/nostr.js', () => ({ createNip98AuthHeader: sign, createNip98AuthHeaderForSecret: workspaceSign }));
vi.mock('../src/crypto/workspace-keys.js', () => ({ getActiveWorkspaceKey: () => null, getActiveWorkspaceKeySecretForAuth: () => new Uint8Array(32), getActiveWorkspaceKeyNpub: () => 'workspace' }));
import { towerPgFeedRequest } from '../src/api.js';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('T1 real browser API adapter', () => {
  it('signs actual-reader exact routes and serializes CAS mutations without actor parameters', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ subscriptions: [], next_cursor: null })); vi.stubGlobal('fetch', fetchImpl);
    const opts = { baseUrl: 'https://tower.example', appNpub: 'app' };
    await towerPgFeedRequest('workspace', '', { ...opts, cursor: 'opaque/+=' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://tower.example/api/v4/flightdeck-pg/workspaces/workspace/feed-subscriptions?limit=200&cursor=opaque%2F%2B%3D');
    const body = { mutation_id: 'mutation', expected_row_version: 2, item_id: 'item', patch: { read: false } };
    await towerPgFeedRequest('workspace', '/subscription/item-states', { ...opts, method: 'PUT', body });
    expect(sign.mock.calls[1].slice(0, 3)).toEqual(['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace/feed-subscriptions/subscription/item-states', 'PUT', body]);
    expect(workspaceSign).not.toHaveBeenCalled(); expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual(body); expect(fetchImpl.mock.calls[1][1].headers['x-flightdeck-pg-app-npub']).toBe('app');
  });
  it('surfaces authoritative T1 CAS errors for field-only reconciliation', async () => { vi.stubGlobal('fetch', async () => Response.json({ error: 'Concurrent edit', code: 'state_conflict' }, { status: 409 })); await expect(towerPgFeedRequest('workspace', '/subscription/item-states', { baseUrl: 'https://tower.example', method: 'PUT', body: {} })).rejects.toMatchObject({ status: 409 }); });
});
