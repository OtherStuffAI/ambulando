import { describe, it, expect, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { discoverNStackServices, discoverHttpsAutopilot, requireRegisteredAmbulandoApp } from '../src/nstack-agent-discovery.js';
import { createAutopilotDiscoveryClient } from '../src/autopilot-connect-client.js';
import { storedPackage } from '../src/autopilot-connection-refresh.js';
import { FLIGHT_DECK_PG_APP_NPUB } from '../src/app-identity.js';
const npub = nip19.npubEncode('11'.repeat(32));
const installation = `autopilot_${bytesToHex(sha256(new TextEncoder().encode('11'.repeat(32)))).slice(0, 32)}`;
const descriptor = { schema: 'org.wingman.nstack.services', schema_version: 1, services: [
  { kind: 'tower', endpoint: 'https://tower.example' }, { kind: 'autopilot', endpoint: 'https://agents.example' },
] };
const registrationIdentity = { workspace_id: 'fixture-workspace', workspace_owner_npub: npub, app_npub: FLIGHT_DECK_PG_APP_NPUB };
const health = { ok: true, installation_id: installation, installation_npub: npub, api_version: 1 };
const respond = payload => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
describe('nStack HTTPS agent discovery', () => {
  it('uses explicit advertised services and binds health to installation identity', async () => {
    const fetchImpl = vi.fn(async url => respond(url.includes('nstack.json') ? descriptor : health));
    const authHeader = vi.fn(async () => 'Nostr fixture');
    const services = await discoverNStackServices('https://tower.example/', { fetchImpl, authHeader });
    expect(services).toEqual({ origin: 'https://tower.example', autopilot: 'https://agents.example' });
    expect(authHeader).not.toHaveBeenCalled();
    const verified = await discoverHttpsAutopilot(services.autopilot, npub, { fetchImpl, authHeader });
    expect(verified).toMatchObject({ installationId: installation, transportMode: 'https', fipsEndpoint: null });
    expect(authHeader).toHaveBeenCalledWith(`https://agents.example/api/owners/${npub}/control-plane/v1/health`, 'GET', null);
  });
  it('distinguishes missing, disabled and wrong app registration without creating apps', async () => {
    for (const app of [{ installed: false }, { installed: true, enabled: false }, { installed: true, enabled: true, app_npub: npub }]) {
      const fetchImpl = vi.fn(async () => respond({ identity: registrationIdentity, registration: app }));
      await expect(requireRegisteredAmbulandoApp('https://tower.example', npub, { workspaceId: 'fixture-workspace', fetchImpl, authHeader: async () => 'fixture' })).rejects.toMatchObject({ code: 'ambulando_app_missing' });
      expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('method', 'POST');
    }
    await expect(requireRegisteredAmbulandoApp('https://tower.example', npub, { workspaceId: 'fixture-workspace', fetchImpl: async () => respond({ identity: registrationIdentity, registration: { installed: true, enabled: true, app_npub: FLIGHT_DECK_PG_APP_NPUB } }), authHeader: async () => 'fixture' })).resolves.toMatchObject({ app_npub: FLIGHT_DECK_PG_APP_NPUB });
  });
  it('rejects a forged cross-workspace or cross-app registration binding', async () => {
    for (const identity of [{ ...registrationIdentity, workspace_id: 'other-workspace' }, { ...registrationIdentity, app_npub: npub }, { ...registrationIdentity, workspace_owner_npub: nip19.npubEncode('22'.repeat(32)) }]) {
      await expect(requireRegisteredAmbulandoApp('https://tower.example', npub, { workspaceId: 'fixture-workspace', fetchImpl: async () => respond({ identity, registration: { installed: true, enabled: true, app_npub: FLIGHT_DECK_PG_APP_NPUB } }), authHeader: async () => '' })).rejects.toMatchObject({ code: 'registration_mismatch' });
    }
  });
  it('rejects ambiguous services, origin changes and installation identity mismatch', async () => {
    for (const services of [[...descriptor.services, descriptor.services[1]], [{ kind: 'tower', endpoint: 'https://other.example' }]]) {
      await expect(discoverNStackServices('https://tower.example', { fetchImpl: async () => respond({ ...descriptor, services }) })).rejects.toMatchObject({ code: 'descriptor_invalid' });
    }
    await expect(discoverHttpsAutopilot('https://agents.example', npub, { fetchImpl: async () => respond({ ...health, installation_id: `autopilot_${'0'.repeat(32)}` }), authHeader: async () => '' })).rejects.toMatchObject({ code: 'installation_invalid' });
  });
  it('reports inaccessible identity separately from offline services', async () => {
    for (const [status, code] of [[403, 'workspace_inaccessible'], [503, 'service_offline']]) {
      await expect(discoverHttpsAutopilot('https://agents.example', npub, { fetchImpl: async () => new Response('', { status }), authHeader: async () => '' })).rejects.toMatchObject({ code });
    }
  });
  it('reconnects over persisted explicit HTTPS with no FIPS bridge and rechecks health', async () => {
    const verified = storedPackage({ installation_id: installation, https_endpoint: 'https://agents.example', api_version: '1', capabilities: ['health', 'agents.read'], metadata: { transport_mode: 'https', installation_npub: npub, health_path: `/api/owners/${npub}/control-plane/v1/health`, agents_path: `/api/owners/${npub}/control-plane/v1/agents` } });
    const fetchImpl = vi.fn(async url => respond(url.endsWith('/health') ? health : { installation_id: installation, agents: [] }));
    const client = createAutopilotDiscoveryClient(verified, { transport: null, fetchImpl, authHeader: async () => 'Nostr fixture' });
    expect(await client.health()).toMatchObject({ ok: true });
    expect(await client.discoverAgents()).toEqual([]);
    expect(fetchImpl.mock.calls.every(([url]) => url.startsWith('https://agents.example/'))).toBe(true);
    await client.disconnect();
    expect(() => createAutopilotDiscoveryClient({ ...verified, transportMode: undefined, fipsEndpoint: `http://${npub}.fips:3601`, transportNpub: npub }, { transport: null, fetchImpl })).toThrow(/FIPS transport is unavailable/);
  });
});
