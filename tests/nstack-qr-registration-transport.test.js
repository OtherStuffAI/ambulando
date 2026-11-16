import { afterEach, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import { importTowerTransports } from '../src/tower-transport.js';
import { requireRegisteredAmbulandoApp } from '../src/nstack-agent-discovery.js';
const service = nip19.npubEncode('11'.repeat(32));
const app = nip19.npubEncode('22'.repeat(32));
const origin = `http://${service}.fips:4443`;
afterEach(() => { importTowerTransports([]); vi.unstubAllGlobals(); });
it('verifies existing app registration on the exact native FIPS route with no global fetch', async () => {
  const globalFetch = vi.fn(); vi.stubGlobal('fetch', globalFetch);
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ identity: { tower_service_npub: service, workspace_id: 'workspace', workspace_owner_npub: service, app_npub: app }, registration: { installed: true, enabled: true, app_npub: app } }) }));
  importTowerTransports([{ logicalTower: origin, mode: 'fips', endpoint: origin, serviceNpub: service, transport: 'native', handle: { fetch } }]);
  const authHeader = vi.fn(async () => 'Nostr user');
  await requireRegisteredAmbulandoApp(origin, service, { appNpub: app, workspaceId: 'workspace', towerNpub: service, authHeader, fetchImpl: globalFetch });
  expect(fetch.mock.calls[0][0]).toBe(origin + '/api/v4/flightdeck-pg/workspaces/workspace/app-registration');
  expect(authHeader.mock.calls[0][0]).toBe(fetch.mock.calls[0][0]);
  expect(globalFetch).not.toHaveBeenCalled();
});
it('a FIPS locator without an active native handle cannot use ordinary fetch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(requireRegisteredAmbulandoApp(origin, service, { appNpub: app, workspaceId: 'workspace' })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
