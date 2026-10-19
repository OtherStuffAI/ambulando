import { describe, expect, it, vi } from 'vitest';
import { createNStackProviderAdapter, waitForNStackProvider } from '../src/nstack-provider.js';
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

  it('lists multiple stacks and validates real workspace connection descriptors', async () => {
    const provider = fixture();
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await adapter.requestDiscovery();
    const stacks = await adapter.listNStacks();
    const workspaces = await adapter.listWorkspaces({ stackId: stacks[1].id });
    expect(workspaces).toHaveLength(2);
    expect(adapter.getWorkspaceDescriptor({ stackId: stacks[1].id, workspaceId: workspaces[0].id })).toMatchObject({
      workspaceId: 'suite',
      directHttpsUrl: 'https://work.example',
      serviceNpub: expect.stringMatching(/^npub1/),
    });
    expect(provider.calls.some(call => call[0] === 'requestCapabilities')).toBe(false);
    const changed = vi.fn();
    const unsubscribe = adapter.on('change', changed);
    provider.emit('changed');
    expect(changed).toHaveBeenCalledWith({ reason: 'changed' });
    expect(() => adapter.getWorkspaceDescriptor({ stackId: stacks[1].id, workspaceId: workspaces[0].id })).toThrow(/disclosed/);
    unsubscribe();
  });

  it('waits for bounded late provider injection and supports the ready event', async () => {
    const host = new EventTarget();
    host.NStack = undefined;
    const pending = waitForNStackProvider({ windowObject: host, timeoutMs: 100 });
    host.NStack = fixture();
    host.dispatchEvent(new Event('nstackready'));
    await expect(pending).resolves.toBe(host.NStack);
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
    provider.workspaces.personal[0].directHttpsUrl = 'https://user:password@personal.example';
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await adapter.requestDiscovery();
    const [stack] = await adapter.listNStacks();
    await expect(adapter.listWorkspaces({ stackId: stack.id })).rejects.toMatchObject({ code: 'malformed' });
  });

  it('rejects duplicate real workspace identities behind different opaque ids', async () => {
    const provider = fixture();
    provider.workspaces.personal.push({ id: 'duplicate-alias', workspaceId: 'private', name: 'Duplicate' });
    const adapter = createNStackProviderAdapter({ provider, origin: provider.origin });
    await adapter.requestDiscovery();
    const [stack] = await adapter.listNStacks();
    await expect(adapter.listWorkspaces({ stackId: stack.id })).rejects.toMatchObject({ code: 'malformed' });
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
