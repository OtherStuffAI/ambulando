import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  AUTOPILOT_CONNECT_KIND,
  AUTOPILOT_CONNECT_SIGNATURE_KIND,
  AUTOPILOT_CONNECT_TRANSPORT_VERSION,
  autopilotConnectManifestContent,
  createAutopilotDiscoveryClient,
  verifyAutopilotConnectPackage,
} from '../src/autopilot-connect-client.js';
import { createNip98AuthHeaderForSecret } from '../src/auth/nostr.js';

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date('2026-09-24T00:04:00.000Z');

function scoped(provider) {
  return {
    ...provider,
    async connect(options) {
      const descriptor = await provider.connect(options);
      if (descriptor?.transport === 'proxy') return descriptor;
      return {
        ...descriptor,
        peerNpub: options.peerNpub,
        purpose: options.purpose,
        fetch: provider.fetch,
        disconnect: provider.disconnect || vi.fn(),
      };
    },
  };
}

function fixture(overrides = {}) {
  const secret = generateSecretKey();
  const npub = nip19.npubEncode(getPublicKey(secret));
  const manifest = {
    kind: AUTOPILOT_CONNECT_KIND,
    version: 1,
    generated_at: '2026-09-24T00:00:00.000Z',
    installation: { id: 'installation-test', npub },
    endpoints: { fips: `http://${npub}.fips:43101`, https: 'https://autopilot.example' },
    api: {
      version: 1,
      capabilities: ['health', 'agents.read'],
      health_path: '/api/control/v1/health',
      agents_path: '/api/control/v1/agents?visible=true',
    },
    ...overrides,
  };
  const signature = finalizeEvent({
    kind: AUTOPILOT_CONNECT_SIGNATURE_KIND,
    created_at: Math.floor(Date.parse(manifest.generated_at) / 1000),
    tags: [['d', manifest.installation.id]],
    content: autopilotConnectManifestContent(manifest),
  }, secret);
  return { secret, manifest, signature, envelope: { manifest, signature } };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Autopilot Connect Package verification', () => {
  beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => {}));
  it('verifies a signed versioned package and binds its identity to the exact endpoint', () => {
    const { envelope, manifest } = fixture();
    expect(verifyAutopilotConnectPackage(JSON.stringify(envelope), { now: NOW })).toMatchObject({
      installationId: 'installation-test',
      installationNpub: manifest.installation.npub,
      transportNpub: manifest.installation.npub,
      fipsEndpoint: `http://${manifest.installation.npub}.fips:43101`,
      apiVersion: 1,
    });
  });

  it('rejects tampering and unsupported package versions', () => {
    const tampered = fixture();
    tampered.envelope.manifest.installation.id = 'changed';
    expect(() => verifyAutopilotConnectPackage(tampered.envelope, { now: NOW })).toThrowError(expect.objectContaining({ code: 'package_tampered' }));
    const unsupported = fixture({ version: 3 });
    expect(() => verifyAutopilotConnectPackage(unsupported.envelope, { now: NOW })).toThrowError(expect.objectContaining({ code: 'package_version_unsupported' }));
  });

  it('rejects signer and FIPS endpoint identities that differ from the installation', () => {
    const wrongSigner = fixture();
    const otherSecret = generateSecretKey();
    wrongSigner.envelope.signature = finalizeEvent({
      kind: AUTOPILOT_CONNECT_SIGNATURE_KIND,
      created_at: Math.floor(Date.parse(wrongSigner.manifest.generated_at) / 1000),
      tags: [['d', wrongSigner.manifest.installation.id]],
      content: autopilotConnectManifestContent(wrongSigner.manifest),
    }, otherSecret);
    expect(() => verifyAutopilotConnectPackage(wrongSigner.envelope, { now: NOW })).toThrowError(expect.objectContaining({ code: 'installation_mismatch' }));

    const endpointMismatch = fixture();
    const otherNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    endpointMismatch.manifest.endpoints.fips = `http://${otherNpub}.fips:43101`;
    endpointMismatch.signature = finalizeEvent({
      kind: AUTOPILOT_CONNECT_SIGNATURE_KIND,
      created_at: Math.floor(Date.parse(endpointMismatch.manifest.generated_at) / 1000),
      tags: [['d', endpointMismatch.manifest.installation.id]],
      content: autopilotConnectManifestContent(endpointMismatch.manifest),
    }, endpointMismatch.secret);
    expect(() => verifyAutopilotConnectPackage({ manifest: endpointMismatch.manifest, signature: endpointMismatch.signature }, { now: NOW }))
      .toThrowError(expect.objectContaining({ code: 'endpoint_mismatch' }));
  });

  it('accepts v2 distinct signer and transport identities and rejects transport tampering', () => {
    const transportNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const v2 = fixture({
      version: AUTOPILOT_CONNECT_TRANSPORT_VERSION,
      transport: { fips: { npub: transportNpub } },
      endpoints: { fips: `http://${transportNpub}.fips:43101`, https: 'https://autopilot.example' },
    });
    expect(verifyAutopilotConnectPackage(v2.envelope, { now: NOW })).toMatchObject({
      version: 2,
      installationNpub: v2.manifest.installation.npub,
      transportNpub,
      fipsEndpoint: `http://${transportNpub}.fips:43101`,
    });

    const wrongTransport = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const mismatched = fixture({
      version: 2,
      transport: { fips: { npub: wrongTransport } },
      endpoints: { fips: `http://${transportNpub}.fips:43101`, https: null },
    });
    expect(() => verifyAutopilotConnectPackage(mismatched.envelope, { now: NOW }))
      .toThrowError(expect.objectContaining({ code: 'endpoint_mismatch' }));
  });

  it('rejects expired, future-dated and signature-time-mismatched packages', () => {
    expect(() => verifyAutopilotConnectPackage(fixture().envelope, { now: new Date('2026-09-24T00:06:00.001Z') }))
      .toThrowError(expect.objectContaining({ code: 'package_expired' }));
    expect(() => verifyAutopilotConnectPackage(fixture({ generated_at: '2026-09-24T00:05:00.000Z' }).envelope, { now: NOW }))
      .toThrowError(expect.objectContaining({ code: 'package_expired' }));
    const unbound = fixture();
    unbound.envelope.signature = finalizeEvent({ ...unbound.signature, created_at: unbound.signature.created_at + 2 }, unbound.secret);
    expect(() => verifyAutopilotConnectPackage(unbound.envelope, { now: NOW }))
      .toThrowError(expect.objectContaining({ code: 'package_tampered' }));
  });

  it('rejects secret-bearing packages without persisting or logging their contents', () => {
    const value = 'nsec1forbiddenmaterial';
    const secretPackage = fixture({ credentials: { private_key: value } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem });
    expect(() => verifyAutopilotConnectPackage(secretPackage.envelope, { now: NOW })).toThrowError(expect.objectContaining({ code: 'package_secret' }));
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('rejects unsafe advertised paths and credential-like query data', () => {
    for (const healthPath of ['//attacker.invalid/health', '/health#fragment', '/health?token=reusable']) {
      const candidate = fixture({ api: { ...fixture().manifest.api, health_path: healthPath } });
      expect(() => verifyAutopilotConnectPackage(candidate.envelope, { now: NOW })).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^package_(invalid|secret)$/) }),
      );
    }
  });
});

describe('Autopilot NIP-98/FIPS discovery client', () => {
  let verified;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    verified = verifyAutopilotConnectPackage(fixture().envelope, { now: NOW });
  });

  it('uses only FIPS and exposes actionable missing-bridge and no-route failures', async () => {
    const publicFetch = vi.spyOn(globalThis, 'fetch');
    expect(() => createAutopilotDiscoveryClient(verified, { transport: null })).toThrowError(expect.objectContaining({ code: 'fips_unavailable' }));
    expect(() => createAutopilotDiscoveryClient(verified, {
      transport: { version: 1, connect: vi.fn(), fetch: vi.fn() },
    })).toThrowError(expect.objectContaining({ code: 'fips_unavailable' }));
    expect(publicFetch).not.toHaveBeenCalled();

    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' })),
      fetch: vi.fn(async () => response({ error: 'missing' }, 404)),
    };
    const client = createAutopilotDiscoveryClient(verified, { transport: scoped(bridge), authHeader: vi.fn(async () => 'Nostr signed') });
    await expect(client.health()).rejects.toMatchObject({ code: 'route_unavailable', status: 404 });
    expect(publicFetch).not.toHaveBeenCalled();

    const failedNative = createAutopilotDiscoveryClient(verified, {
      transport: { ...bridge, connect: vi.fn(async () => { throw new Error('mesh offline'); }) },
      authHeader: vi.fn(async () => 'Nostr signed'),
    });
    await expect(failedNative.health()).rejects.toMatchObject({ code: 'fips_connection_failed' });
    expect(publicFetch).not.toHaveBeenCalled();

    const disconnect = vi.fn();
    const mismatched = createAutopilotDiscoveryClient(verified, {
      transport: {
        version: 2,
        connect: vi.fn(async ({ endpoint, peerNpub, purpose }) => ({
          version: 2, endpoint, peerNpub, purpose, disconnect,
        })),
        fetch: vi.fn(),
      },
      authHeader: vi.fn(),
    });
    await expect(mismatched.health()).rejects.toMatchObject({ code: 'endpoint_mismatch' });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('signs and sends the exact URL, method, and serialized body', async () => {
    const signingSecret = generateSecretKey();
    const authHeader = vi.fn((url, method, body) => createNip98AuthHeaderForSecret(url, method, body, signingSecret));
    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' })),
      fetch: vi.fn(async () => response({ ok: true })),
    };
    const client = createAutopilotDiscoveryClient(verified, { transport: scoped(bridge), authHeader });
    const body = { probe: 'body-hash-input', ordered: true };
    await client.requestJson(verified.agentsPath, { method: 'POST', body });
    expect(bridge.connect).toHaveBeenCalledWith({
      endpoint: verified.fipsEndpoint,
      peerNpub: verified.transportNpub,
      purpose: 'autopilot',
    });
    const exactUrl = `${verified.fipsEndpoint}${verified.agentsPath}`;
    const exactBody = JSON.stringify(body);
    expect(authHeader).toHaveBeenCalledWith(exactUrl, 'POST', exactBody);
    expect(bridge.fetch).toHaveBeenCalledWith(exactUrl, expect.objectContaining({
      method: 'POST', body: exactBody, redirect: 'error', credentials: 'omit',
    }));
    const sentAuthorization = bridge.fetch.mock.calls[0][1].headers.Authorization;
    const event = JSON.parse(atob(sentAuthorization.slice('Nostr '.length)));
    const expectedHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exactBody))))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(event.tags).toContainEqual(['u', exactUrl]);
    expect(event.tags).toContainEqual(['method', 'POST']);
    expect(event.tags).toContainEqual(['payload', expectedHash]);
  });

  it('refreshes capabilities through the exact FIPS Connect route and verifies identity continuity', async () => {
    const now = new Date();
    const current = fixture({
      generated_at: now.toISOString(),
      api: {
        version: 1,
        capabilities: ['health', 'agents.read'],
        health_path: '/api/owners/npub1owner/control-plane/v1/health',
        agents_path: '/api/owners/npub1owner/control-plane/v1/agents',
      },
    });
    const stored = verifyAutopilotConnectPackage(current.envelope, { now });
    const refreshedManifest = {
      ...current.manifest,
      api: {
        ...current.manifest.api,
        capabilities: [...current.manifest.api.capabilities, 'system.controlled-restart.v1'],
        controlled_restart_path: '/api/system/controlled-restart',
        controlled_restart_status_path: '/api/system/controlled-restart/status',
      },
    };
    const refreshedEnvelope = {
      manifest: refreshedManifest,
      signature: finalizeEvent({
        kind: AUTOPILOT_CONNECT_SIGNATURE_KIND,
        created_at: Math.floor(now.getTime() / 1000),
        tags: [['d', refreshedManifest.installation.id]],
        content: autopilotConnectManifestContent(refreshedManifest),
      }, current.secret),
    };
    const authHeader = vi.fn(async () => 'Nostr exact');
    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' })),
      fetch: vi.fn(async () => response(refreshedEnvelope)),
    };
    const refreshed = await createAutopilotDiscoveryClient(stored, { transport: scoped(bridge), authHeader }).refreshConnectPackage();
    const exactUrl = `${stored.fipsEndpoint}/api/control-plane/v2/connect-package?owner_npub=npub1owner`;
    expect(authHeader).toHaveBeenCalledWith(exactUrl, 'GET', null);
    expect(bridge.fetch).toHaveBeenCalledWith(exactUrl, expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(refreshed.capabilities).toContain('system.controlled-restart.v1');
  });

  it('rejects a newly signed refresh package for a different installation identity', async () => {
    const now = new Date();
    const current = fixture({
      generated_at: now.toISOString(),
      api: {
        version: 1,
        capabilities: ['health'],
        health_path: '/api/owners/npub1owner/control-plane/v1/health',
        agents_path: '/api/owners/npub1owner/control-plane/v1/agents',
      },
    });
    const stored = verifyAutopilotConnectPackage(current.envelope, { now });
    const mismatchedManifest = {
      ...current.manifest,
      installation: { ...current.manifest.installation, id: 'different-installation' },
    };
    const mismatchedEnvelope = {
      manifest: mismatchedManifest,
      signature: finalizeEvent({
        kind: AUTOPILOT_CONNECT_SIGNATURE_KIND,
        created_at: Math.floor(now.getTime() / 1000),
        tags: [['d', mismatchedManifest.installation.id]],
        content: autopilotConnectManifestContent(mismatchedManifest),
      }, current.secret),
    };
    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' })),
      fetch: vi.fn(async () => response(mismatchedEnvelope)),
    };
    await expect(createAutopilotDiscoveryClient(stored, { transport: scoped(bridge), authHeader: vi.fn(async () => 'Nostr exact') }).refreshConnectPackage())
      .rejects.toMatchObject({ code: 'installation_mismatch' });
  });

  it('signs the exact live-thread snapshot URL and requires advertised capability', async () => {
    const authHeader = vi.fn(async () => 'Nostr exact');
    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' })),
      fetch: vi.fn(async () => response({ version: 1, activity: null, cursor: '0' })),
    };
    const context = {
      ownerNpub: 'npub1owner', workspaceId: 'workspace 1', towerServiceNpub: 'npub1tower',
      appNpub: 'npub1app', channelId: 'channel/1', threadId: 'thread/1', agentNpub: 'npub1agent',
    };
    const unsupported = createAutopilotDiscoveryClient(verified, { transport: scoped(bridge), authHeader });
    await expect(unsupported.liveThreadSnapshot(context)).rejects.toMatchObject({ code: 'route_unavailable' });
    const capable = createAutopilotDiscoveryClient({
      ...verified,
      capabilities: [...verified.capabilities, 'flightdeck.live-thread-activity.v1'],
    }, { transport: scoped(bridge), authHeader });
    await capable.liveThreadSnapshot(context);
    const exactUrl = `${verified.fipsEndpoint}/api/owners/npub1owner/control-plane/v1/live-threads/thread%2F1/snapshot?workspace_id=workspace+1&tower_service_npub=npub1tower&app_npub=npub1app&channel_id=channel%2F1&agent_npub=npub1agent`;
    expect(authHeader).toHaveBeenLastCalledWith(exactUrl, 'GET', null);
    expect(bridge.fetch).toHaveBeenLastCalledWith(exactUrl, expect.objectContaining({ method: 'GET', redirect: 'error' }));
  });

  it('preserves stage-specific native connection errors', async () => {
    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async () => { throw new Error('health_identity_mismatch: Regenerate the connect package.'); }),
      fetch: vi.fn(),
    };
    await expect(createAutopilotDiscoveryClient(verified, { transport: scoped(bridge) }).health()).rejects.toMatchObject({
      code: 'health_identity_mismatch',
      message: 'Regenerate the connect package.',
      correlationId: verified.correlationId,
    });
  });

  it('preserves safe native signing errors and correlation without leaking details', async () => {
    const authHeader = vi.fn(async () => {
      throw new Error('fips_signing_scope_required: Reconnect the exact FIPS service grant.');
    });
    await expect(createAutopilotDiscoveryClient(verified, {
      transport: scoped({
        version: 2,
        connect: vi.fn(async ({ endpoint }) => ({ version: 2, endpoint })),
        fetch: vi.fn(),
      }),
      authHeader,
    }).health()).rejects.toMatchObject({
      code: 'fips_signing_scope_required',
      message: 'Reconnect the exact FIPS service grant.',
      correlationId: verified.correlationId,
    });

    authHeader.mockRejectedValueOnce(new Error('unsafe signer failure\nAuthorization: secret'));
    await expect(createAutopilotDiscoveryClient(verified, {
      transport: scoped({
        version: 2,
        connect: vi.fn(async ({ endpoint }) => ({ version: 2, endpoint })),
        fetch: vi.fn(),
      }),
      authHeader,
    }).health()).rejects.toMatchObject({
      code: 'auth_signing_failed',
      message: 'Could not sign the exact Autopilot health request.',
      correlationId: verified.correlationId,
    });
  });

  it('does not expose malformed native error details', async () => {
    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async () => { throw new Error('native failure\nAuthorization: secret'); }),
      fetch: vi.fn(),
    };
    await expect(createAutopilotDiscoveryClient(verified, { transport: scoped(bridge) }).health()).rejects.toMatchObject({
      code: 'fips_connection_failed',
      message: 'Could not connect to the signed Autopilot FIPS endpoint. Open WMapp Setup and check FIPS diagnostics.',
    });
  });

  it('passes distinct v2 transport and installation identities and preserves v1 identity compatibility', async () => {
    const transportNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const v2Package = verifyAutopilotConnectPackage(fixture({
      version: AUTOPILOT_CONNECT_TRANSPORT_VERSION,
      transport: { fips: { npub: transportNpub } },
      endpoints: { fips: `http://${transportNpub}.fips:43101`, https: 'https://autopilot.example' },
    }).envelope, { now: NOW });
    const connect = vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' }));
    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect,
      fetch: vi.fn(async () => response({ ok: true, installation_id: v2Package.installationId, installation_npub: v2Package.installationNpub, api_version: 1 })),
    };

    await createAutopilotDiscoveryClient(v2Package, { transport: scoped(bridge), authHeader: vi.fn(async () => 'Nostr signed') }).health();
    expect(connect).toHaveBeenCalledWith({
      endpoint: v2Package.fipsEndpoint,
      peerNpub: transportNpub,
      purpose: 'autopilot',
    });

    const legacyConnect = vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' }));
    const legacyBridge = {
      ...bridge,
      connect: legacyConnect,
      fetch: vi.fn(async () => response({ ok: true, installation_id: verified.installationId, installation_npub: verified.installationNpub, api_version: 1 })),
    };
    await createAutopilotDiscoveryClient(verified, { transport: scoped(legacyBridge), authHeader: vi.fn(async () => 'Nostr signed') }).health();
    expect(legacyConnect.mock.calls[0][0].peerNpub).toBe(verified.installationNpub);
    expect(legacyConnect.mock.calls[0][0].purpose).toBe('autopilot');
  });

  it('validates mocked health and returns only normalized, authorized discovery fields', async () => {
    const hidden = { agent_id: '', bot_npub: 'invalid', secret: 'must-not-escape' };
    const bridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' })),
      fetch: vi.fn(async (url) => url.endsWith('/health')
        ? response({ ok: true, installation_id: verified.installationId, installation_npub: verified.installationNpub, api_version: 1, internal: 'drop' })
        : response({ installation_id: verified.installationId, agents: [
          { agent_id: 'agent-alpha', bot_npub: verified.installationNpub, name: 'Example Agent', description: 'Product-neutral fixture', can_instruct: true, paths: {
            overview: '/api/agents/alpha/overview', pipelines: '/api/agents/alpha/pipelines', schedules: '/api/agents/alpha/schedules', triggers: '/api/agents/alpha/triggers',
          }, working_directory: '/private' },
          hidden,
        ] })),
    };
    const client = createAutopilotDiscoveryClient(verified, { transport: scoped(bridge), authHeader: vi.fn(async () => 'Nostr signed') });
    expect(await client.health()).toEqual({ ok: true, installationId: verified.installationId, installationNpub: verified.installationNpub, apiVersion: 1 });
    expect(await client.discoverAgents()).toEqual([{ agentId: 'agent-alpha', botNpub: verified.installationNpub, name: 'Example Agent', description: 'Product-neutral fixture', canInstruct: true, paths: {
      overview: '/api/agents/alpha/overview', pipelines: '/api/agents/alpha/pipelines', schedules: '/api/agents/alpha/schedules', triggers: '/api/agents/alpha/triggers',
    } }]);
  });

  it('reports authentication and health identity failures distinctly', async () => {
    const authBridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' })),
      fetch: vi.fn(async () => response({ error: 'denied' }, 403)),
    };
    await expect(createAutopilotDiscoveryClient(verified, { transport: scoped(authBridge), authHeader: vi.fn(async () => 'Nostr signed') }).health())
      .rejects.toMatchObject({ code: 'auth_failed' });

    const identityBridge = {
      version: 2,
      pairingIdentity: 'service-npub',
      connect: vi.fn(async ({ endpoint, serviceNpub }) => ({ version: 2, endpoint, serviceNpub, transport: 'native' })),
      fetch: vi.fn(async () => response({ ok: true, installation_id: 'other', installation_npub: verified.installationNpub, api_version: 1 })),
    };
    await expect(createAutopilotDiscoveryClient(verified, { transport: scoped(identityBridge), authHeader: vi.fn(async () => 'Nostr signed') }).health())
      .rejects.toMatchObject({ code: 'installation_mismatch' });
  });
});
