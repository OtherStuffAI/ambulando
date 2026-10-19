import { describe, expect, it, vi } from 'vitest';
import { createNStackProviderAdapter } from '../src/nstack-provider.js';
import { DeterministicNStackProviderFixture } from './fixtures/nstack-provider-fixture.js';

function fixture(origin = 'https://ambulando.example') {
  return new DeterministicNStackProviderFixture({
    origin,
    stacks: [
      { id: 'personal', name: 'Personal', host: true, url: 'https://personal.example' },
      { id: 'work', name: 'Work', url: 'https://work.example' },
    ],
    workspaces: {
      personal: [{ id: 'private', name: 'Private' }],
      work: [{ id: 'suite', name: 'Wingman Suite' }, { id: 'ops', name: 'Operations' }],
    },
  });
}

describe('window.NStack adapter', () => {
  it('reports absence without passive enumeration', async () => {
    const adapter = createNStackProviderAdapter({ provider: undefined, origin: 'https://ambulando.example' });
    await expect(adapter.isAvailable()).resolves.toEqual({ available: false, version: '' });
    await expect(adapter.listNStacks()).rejects.toMatchObject({ code: 'not_disclosed' });
  });

  it('checks version without listing until deliberate consent', async () => {
    const provider = fixture();
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await expect(adapter.isAvailable()).resolves.toEqual({ available: true, version: '1' });
    expect(provider.calls).toEqual([['isAvailable']]);
    await adapter.requestDiscovery({ workspaces: true });
    const stacks = await adapter.listNStacks();
    expect(stacks).toHaveLength(2);
    expect(provider.calls.map(call => call[0])).toEqual(['isAvailable', 'requestDiscovery', 'listNStacks']);
  });

  it.each([
    ['deny', 'consent_denied'],
    ['cancel', 'consent_denied'],
  ])('distinguishes discovery %s', async (discovery, code) => {
    const provider = fixture();
    provider.discovery = discovery;
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await expect(adapter.requestDiscovery()).rejects.toMatchObject({ code });
    await expect(adapter.listNStacks()).rejects.toMatchObject({ code: 'not_disclosed' });
  });

  it('lists multiple stacks/workspaces, requests the exact capabilities and rejects stale handles', async () => {
    const provider = fixture();
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await adapter.requestDiscovery();
    const stacks = await adapter.listNStacks();
    const workspaces = await adapter.listWorkspaces({ stackId: stacks[1].id });
    const handle = await adapter.requestCapabilities({
      stackId: stacks[1].id,
      workspaceId: workspaces[0].id,
      capabilities: ['workspace.read', 'workspace.read'],
      duration: 900,
    });
    expect(provider.calls.find(call => call[0] === 'requestCapabilities')[1]).toEqual({
      stackId: stacks[1].id,
      workspaceId: workspaces[0].id,
      capabilities: ['workspace.read'],
      duration: 900,
    });
    expect(handle.connection.url).toBe('https://work.example');
    expect(adapter.assertHandleActive(handle.handle).active).toBe(true);
    const changed = vi.fn();
    const unsubscribe = adapter.on('change', changed);
    provider.emit('changed');
    expect(changed).toHaveBeenCalledWith({ reason: 'changed' });
    expect(() => adapter.assertHandleActive(handle.handle)).toThrow(/no longer active/);
    unsubscribe();
  });

  it('revokes a document handle through the v1 provider method', async () => {
    const provider = fixture();
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await adapter.requestDiscovery();
    const [stack] = await adapter.listNStacks();
    const [workspace] = await adapter.listWorkspaces({ stackId: stack.id });
    const result = await adapter.requestCapabilities({ stackId: stack.id, workspaceId: workspace.id, capabilities: ['workspace.read'] });
    await expect(adapter.revoke({ handle: result.handle })).resolves.toBe(true);
    expect(() => adapter.assertHandleActive(result.handle)).toThrow(/no longer active/);
  });

  it('keeps opaque ids origin-scoped in deterministic fixtures', async () => {
    const a = fixture('https://a.example');
    const b = fixture('https://b.example');
    const adapterA = createNStackProviderAdapter({ provider: a, origin: a.origin });
    const adapterB = createNStackProviderAdapter({ provider: b, origin: b.origin });
    await Promise.all([adapterA.requestDiscovery(), adapterB.requestDiscovery()]);
    const [stackA] = await adapterA.listNStacks();
    const [stackB] = await adapterB.listNStacks();
    expect(stackA.id).not.toBe(stackB.id);
  });

  it('rejects provider responses that expose credential-shaped fields', async () => {
    const provider = fixture();
    provider.stacks[0].extra = { bearerToken: 'do-not-return-this' };
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await adapter.requestDiscovery();
    await expect(adapter.listNStacks()).rejects.toMatchObject({ code: 'malformed' });
  });

  it('rejects malformed connection metadata returned after approval', async () => {
    const provider = fixture();
    provider.stacks[0].url = 'https://user:password@personal.example';
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await adapter.requestDiscovery();
    const [stack] = await adapter.listNStacks();
    const [workspace] = await adapter.listWorkspaces({ stackId: stack.id });
    await expect(adapter.requestCapabilities({
      stackId: stack.id,
      workspaceId: workspace.id,
      capabilities: ['workspace.read'],
    })).rejects.toMatchObject({ code: 'malformed' });
  });

  it('reports an unreachable provider without disclosing cached inventory', async () => {
    const provider = fixture();
    provider.requestDiscovery = vi.fn(async () => { throw Object.assign(new Error('timed out'), { code: 'unavailable' }); });
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await expect(adapter.requestDiscovery()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(adapter.listNStacks()).rejects.toMatchObject({ code: 'not_disclosed' });
  });

  it('requires both public and availability protocol versions to be numeric v1', async () => {
    const provider = fixture();
    provider.version = '1';
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await expect(adapter.isAvailable()).rejects.toMatchObject({ code: 'malformed' });
  });
});
