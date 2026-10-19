import { describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';

import {
  discoverNStackWorkspaces,
  nstackUserMessage,
  nstackWorkspaceDescriptor,
  waitForNStackProvider,
} from '../src/nstack-connection.js';

const towerNpub = nip19.npubEncode('11'.repeat(32));
const workspaceServiceNpub = nip19.npubEncode('22'.repeat(32));
const ownerNpub = nip19.npubEncode('33'.repeat(32));

function stack(overrides = {}) {
  return {
    id: 'opaque-stack',
    name: 'Home NStack',
    url: 'https://tower.example',
    serviceNpub: towerNpub,
    available: true,
    ...overrides,
  };
}

function workspace(overrides = {}) {
  return {
    id: 'opaque-workspace',
    name: 'Wingmen',
    workspaceId: 'real-workspace-id',
    workspaceOwnerNpub: ownerNpub,
    workspaceServiceNpub,
    directHttpsUrl: 'https://tower.example',
    serviceNpub: towerNpub,
    ...overrides,
  };
}

function provider(overrides = {}) {
  return {
    version: 1,
    isAvailable: vi.fn(async () => ({ available: true, version: 1 })),
    requestDiscovery: vi.fn(async () => ({ disclosed: 1, workspaces: true })),
    listNStacks: vi.fn(async () => [stack()]),
    listWorkspaces: vi.fn(async () => [workspace()]),
    requestCapabilities: vi.fn(async () => { throw new Error('must not be called'); }),
    revoke: vi.fn(async () => true),
    on: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe('NStack connection discovery', () => {
  it('returns null when the provider is absent and catches a provider injected after document start', async () => {
    expect(await waitForNStackProvider({ windowObject: {}, timeoutMs: 5, pollIntervalMs: 1 })).toBeNull();

    const windowObject = {};
    const expected = provider();
    setTimeout(() => { windowObject.NStack = expected; }, 5);
    await expect(waitForNStackProvider({ windowObject, timeoutMs: 100, pollIntervalMs: 2 })).resolves.toBe(expected);
  });

  it('accepts the ready promise provider before the window property is assigned', async () => {
    const expected = provider();
    const windowObject = { NStackReady: Promise.resolve(expected) };

    await expect(waitForNStackProvider({ windowObject, timeoutMs: 100, pollIntervalMs: 2 })).resolves.toBe(expected);
  });

  it('requests workspace disclosure and returns multiple validated real descriptors', async () => {
    const bridge = provider({
      listWorkspaces: vi.fn(async () => [workspace(), workspace({ id: 'opaque-2', workspaceId: 'real-2', name: 'Second' })]),
    });

    const result = await discoverNStackWorkspaces(bridge);

    expect(bridge.requestDiscovery).toHaveBeenCalledWith({ workspaces: true });
    expect(bridge.listWorkspaces).toHaveBeenCalledWith({ stackId: 'opaque-stack' });
    expect(bridge.requestCapabilities).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0].descriptor).toMatchObject({
      tower_base_url: 'https://tower.example',
      identity: {
        tower_service_npub: towerNpub,
        workspace_service_npub: workspaceServiceNpub,
        workspace_owner_npub: ownerNpub,
        workspace_id: 'real-workspace-id',
      },
    });
    expect(JSON.stringify(result[0].descriptor)).not.toContain('opaque-stack');
    expect(JSON.stringify(result[0].descriptor)).not.toContain('opaque-workspace');
  });

  it('distinguishes declined consent, no workspaces, and malformed descriptors', async () => {
    const denied = Object.assign(new Error('no'), { code: 'consent_denied' });
    await expect(discoverNStackWorkspaces(provider({ requestDiscovery: vi.fn(async () => { throw denied; }) })))
      .rejects.toMatchObject({ code: 'consent_declined' });
    await expect(discoverNStackWorkspaces(provider({ listWorkspaces: vi.fn(async () => []) })))
      .rejects.toMatchObject({ code: 'no_accessible_workspaces' });
    expect(() => nstackWorkspaceDescriptor(stack(), workspace({ directHttpsUrl: 'http://tower.example' })))
      .toThrow(/HTTPS/);
    expect(() => nstackWorkspaceDescriptor(stack(), workspace({ token: 'must-not-pass' })))
      .toThrow(/forbidden field/);
    expect(nstackUserMessage({ code: 'bridge_unavailable' })).toMatch(/BYO Tower remains available/);
  });

  it('accepts only paired safe FIPS metadata and keeps it non-authoritative', () => {
    const peerNpub = nip19.npubEncode('44'.repeat(32));
    const result = nstackWorkspaceDescriptor(
      stack({ fipsEndpoint: `http://${peerNpub}.fips:41024`, peerNpub }),
      workspace(),
    );
    expect(result.descriptor.metadata.nstack_fips).toEqual({
      fipsEndpoint: `http://${peerNpub}.fips:41024`,
      peerNpub,
    });
    expect(result.descriptor.tower_base_url).toBe('https://tower.example');
  });
});
