import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import {
  buildNStackRecoveryEvent,
  buildNStackRecoveryDeletionRequest,
  newestValidNStackRecoveryEvent,
  nstackRecoveryAddress,
  nstackRecoveryD,
  NSTACK_RECOVERY_KIND,
  NSTACK_RECOVERY_SCHEMA,
  NSTACK_RECOVERY_TYPES,
  parseNStackRecoveryEvent,
  restoreNStackRecovery,
  UnavailableNStackBlobAdapter,
} from '../src/nstack-recovery.js';

function testSigner(secret = generateSecretKey()) {
  const pubkey = getPublicKey(secret);
  const conversationKey = nip44.getConversationKey(secret, pubkey);
  return {
    secret,
    pubkey,
    getPublicKey: vi.fn(async () => pubkey),
    encrypt: vi.fn(async (peer, plaintext) => nip44.encrypt(plaintext, nip44.getConversationKey(secret, peer))),
    decrypt: vi.fn(async (peer, ciphertext) => nip44.decrypt(ciphertext, nip44.getConversationKey(secret, peer))),
    signEvent: vi.fn(async template => finalizeEvent(template, secret)),
    encryptRaw: plaintext => nip44.encrypt(plaintext, conversationKey),
  };
}

const descriptorData = {
  stackId: 'opaque-stack',
  label: 'Personal',
  endpoint: 'https://stack.example',
  servicePubkeys: { tower: 'npub1service' },
  protocolVersions: { NStack: '1', tower: '4' },
};

describe('encrypted NStack NIP-78 records', () => {
  it('builds signed kind-30078 templates encrypted to self with one deterministic d tag', async () => {
    const signer = testSigner();
    const one = await buildNStackRecoveryEvent({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, logicalKey: 'opaque-stack', data: descriptorData, signer, createdAt: 10 });
    const two = await buildNStackRecoveryEvent({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, logicalKey: 'opaque-stack', data: descriptorData, signer, createdAt: 11 });
    expect(one.kind).toBe(NSTACK_RECOVERY_KIND);
    expect(one.tags).toEqual([['d', await nstackRecoveryD(NSTACK_RECOVERY_TYPES.DESCRIPTOR, 'opaque-stack')]]);
    expect(two.tags).toEqual(one.tags);
    expect(one.tags[0][1]).not.toContain('opaque-stack');
    expect(signer.encrypt).toHaveBeenCalledWith(signer.pubkey, expect.any(String));
    expect(one.content).not.toContain('stack.example');
    await expect(parseNStackRecoveryEvent(one, { author: signer.pubkey, signer })).resolves.toMatchObject({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, data: descriptorData });
  });

  it('validates the outer signature before any decrypt call', async () => {
    const signer = testSigner();
    const event = await buildNStackRecoveryEvent({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, data: descriptorData, signer });
    signer.decrypt.mockClear();
    await expect(parseNStackRecoveryEvent({ ...event, sig: '0'.repeat(128) }, { author: signer.pubkey, signer })).rejects.toThrow(/signature/);
    expect(signer.decrypt).not.toHaveBeenCalled();
  });

  it('rejects wrong authors, schemas, malformed tags and absent NIP-44 support', async () => {
    const signer = testSigner();
    const event = await buildNStackRecoveryEvent({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, data: descriptorData, signer });
    await expect(parseNStackRecoveryEvent(event, { author: 'f'.repeat(64), signer })).rejects.toThrow(/wrong author/);
    const extraTag = finalizeEvent({ ...event, id: undefined, sig: undefined, pubkey: undefined, tags: [...event.tags, ['endpoint', 'https://leak.example']] }, signer.secret);
    await expect(parseNStackRecoveryEvent(extraTag, { author: signer.pubkey, signer })).rejects.toThrow(/non-minimal/);
    await expect(buildNStackRecoveryEvent({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, data: descriptorData, signer: {} })).rejects.toThrow(/NIP-44/);

    const content = signer.encryptRaw(JSON.stringify({ schema: `${NSTACK_RECOVERY_SCHEMA}.wrong`, version: 1, type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, deleted: false, data: descriptorData }));
    const wrongSchema = finalizeEvent({ kind: NSTACK_RECOVERY_KIND, created_at: 20, tags: [['d', await nstackRecoveryD(NSTACK_RECOVERY_TYPES.DESCRIPTOR)]], content }, signer.secret);
    await expect(parseNStackRecoveryEvent(wrongSchema, { author: signer.pubkey, signer })).rejects.toThrow(/schema/);

    const wrongRecipient = testSigner();
    await expect(parseNStackRecoveryEvent(event, { author: signer.pubkey, signer: wrongRecipient })).rejects.toThrow(/decrypt/);
  });

  it('selects the newest valid replacement and honours a newer encrypted tombstone', async () => {
    const signer = testSigner();
    const d = await nstackRecoveryD(NSTACK_RECOVERY_TYPES.DESCRIPTOR);
    const old = await buildNStackRecoveryEvent({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, data: descriptorData, signer, createdAt: 10 });
    const malformedNew = finalizeEvent({ kind: NSTACK_RECOVERY_KIND, created_at: 30, tags: [['d', d]], content: signer.encryptRaw('{') }, signer.secret);
    const selected = await newestValidNStackRecoveryEvent([old, malformedNew], { author: signer.pubkey, signer, expectedD: d });
    expect(selected.record.event.id).toBe(old.id);
    expect(selected.failures).toHaveLength(1);
    const tombstone = await buildNStackRecoveryEvent({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, deleted: true, signer, createdAt: 40 });
    const deleted = await newestValidNStackRecoveryEvent([old, tombstone], { author: signer.pubkey, signer, expectedD: d });
    expect(deleted.record.deleted).toBe(true);
    const address = nstackRecoveryAddress(signer.pubkey, d);
    const cleanup = await buildNStackRecoveryDeletionRequest({ addresses: [address], signer, createdAt: 41 });
    expect(cleanup).toMatchObject({ kind: 5, tags: [['a', address], ['k', '30078']] });
  });

  it('restores host hint, index, descriptors and workspaces while retaining partial-record failures', async () => {
    const signer = testSigner();
    const relays = ['wss://relay.example'];
    const descriptor = await buildNStackRecoveryEvent({ type: NSTACK_RECOVERY_TYPES.DESCRIPTOR, logicalKey: 'opaque-stack', data: descriptorData, signer, createdAt: 10 });
    const catalogue = await buildNStackRecoveryEvent({
      type: NSTACK_RECOVERY_TYPES.WORKSPACES, logicalKey: 'opaque-stack',
      data: { stackId: 'opaque-stack', workspaces: [{ id: 'opaque-workspace', label: 'Private' }] }, signer, createdAt: 11,
    });
    const policy = await buildNStackRecoveryEvent({
      type: NSTACK_RECOVERY_TYPES.POLICY, logicalKey: 'opaque-stack',
      data: { stackId: 'opaque-stack', workspaceId: 'opaque-workspace', capabilities: ['workspace.read'] }, signer, createdAt: 12,
    });
    const index = await buildNStackRecoveryEvent({
      type: NSTACK_RECOVERY_TYPES.INDEX,
      data: { stackRecords: [{
        descriptor: nstackRecoveryAddress(signer.pubkey, descriptor.tags[0][1]),
        workspaces: nstackRecoveryAddress(signer.pubkey, catalogue.tags[0][1]),
        policy: nstackRecoveryAddress(signer.pubkey, policy.tags[0][1]),
      }], snapshotReferences: [] }, signer, createdAt: 13,
    });
    const host = await buildNStackRecoveryEvent({
      type: NSTACK_RECOVERY_TYPES.HOST_HINT,
      data: { host: { stackId: 'opaque-stack', endpoint: 'https://stack.example' }, recoveryRelays: relays }, signer, createdAt: 14,
    });
    const invalid = { ...descriptor, id: 'bad', created_at: 99, sig: '0'.repeat(128) };
    const events = [descriptor, catalogue, policy, index, host, invalid];
    const repository = {
      list: vi.fn(async ({ dValues }) => events.filter(event => event.tags.some(tag => tag[0] === 'd' && dValues.includes(tag[1])))),
    };
    const restored = await restoreNStackRecovery({ repository, bootstrapRelays: ['wss://bootstrap.example'], author: signer.pubkey, signer });
    expect(restored.hostHint.host.endpoint).toBe('https://stack.example');
    expect(restored.stacks).toEqual([{
      descriptor: descriptorData,
      workspaceCatalogue: { stackId: 'opaque-stack', workspaces: [{ id: 'opaque-workspace', label: 'Private' }] },
      policyIntent: { stackId: 'opaque-stack', workspaceId: 'opaque-workspace', capabilities: ['workspace.read'] },
    }]);
    expect(restored.failures.some(failure => failure.eventId === 'bad')).toBe(true);
    expect(repository.list.mock.calls[0][0].relays).toEqual(['wss://bootstrap.example']);
    expect(repository.list.mock.calls[1][0].relays).toEqual(relays);
  });

  it('validates the large-snapshot manifest/key envelope and keeps bulk I/O unavailable', async () => {
    const signer = testSigner();
    const event = await buildNStackRecoveryEvent({
      type: NSTACK_RECOVERY_TYPES.MANIFEST,
      data: {
        stackId: 'opaque-stack', snapshotId: 'snapshot-1',
        blob: { location: 'https://objects.example/snapshot', sha256: 'a'.repeat(64), size: 42, algorithm: 'xchacha20-poly1305' },
        wrappedDataKey: { algorithm: 'nip44-v2', ciphertext: 'wrapped-random-data-key' },
      }, signer,
    });
    const parsed = await parseNStackRecoveryEvent(event, { author: signer.pubkey, signer });
    expect(parsed.data.wrappedDataKey.ciphertext).toBe('wrapped-random-data-key');
    const blobs = new UnavailableNStackBlobAdapter();
    await expect(blobs.upload()).rejects.toThrow(/unavailable/);
    await expect(blobs.fetch()).rejects.toThrow(/unavailable/);
  });
});
