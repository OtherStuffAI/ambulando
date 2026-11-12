import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
const testKey = new Uint8Array(32); testKey[31] = 1;
const realSign = (event) => finalizeEvent(event, testKey);
let publishedEvent;
const readback = async () => [publishedEvent];
import {
  WORKSPACE_SELF_INDEX_KIND,
  WORKSPACE_SELF_INDEX_PROTOCOL,
  buildWorkspaceSelfIndexTombstonePayload,
  broadcastWorkspaceSelfIndexEvent,
  buildUnsignedWorkspaceSelfIndexEvent,
  decryptWorkspaceSelfIndexEvent,
  flightDeckSelfIndexAppPubkeyHex,
  publishWorkspaceSelfIndex,
  publishWorkspaceSelfIndexTombstone,
  queryWorkspaceSelfIndexCandidates,
  workspaceSelfIndexRelayUrls,
} from '../src/nostr-workspace-self-index.js';

const userPubkeyHex = getPublicKey(testKey);
const appPubkeyHex = flightDeckSelfIndexAppPubkeyHex();

const workspace = {
  workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
  workspaceOwnerNpub: 'npub1owner',
  name: 'Wingers',
  description: 'Private workspace',
  directHttpsUrl: 'https://tower.example',
  towerServiceNpub: 'npub1tower',
  serviceNpub: 'npub1tower',
  workspaceServiceNpub: 'npub1workspace',
  workspaceId: 'workspace-1',
  appNpub: 'flightdeck_pg',
  pgBackendMode: true,
  pgDescriptorVerifiedAt: '2026-06-07T00:00:00.000Z',
  capabilities: ['pg_tasks'],
  pgDescriptor: {
    type: 'wingman_workspace_locator',
    version: 1,
    tower_base_url: 'https://tower.example',
    identity: {
      tower_service_npub: 'npub1tower',
      workspace_service_npub: 'npub1workspace',
      workspace_owner_npub: 'npub1owner',
      workspace_id: 'workspace-1',
      app_npub: 'flightdeck_pg',
    },
    label: 'Wingers',
    description: 'Private workspace',
    capabilities: ['pg_tasks'],
    links: {
      descriptor: '/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
      me: '/api/v4/flightdeck-pg/workspaces/workspace-1/me',
    },
  },
};

describe('Nostr kind 33356 workspace self-index', () => {
  it('defaults to Primal first without retired or local relays', () => {
    const relays = workspaceSelfIndexRelayUrls();
    expect(relays[0]).toBe('wss://relay.primal.net');
    expect(relays).not.toContain('wss://relay.damus.io');
    expect(relays).not.toContain('ws://127.0.0.1:4869');
  });

  it('builds an opaque replaceable event without cleartext workspace leaks', async () => {
    const event = await buildUnsignedWorkspaceSelfIndexEvent({
      workspace,
      userNpub: '',
      userPubkeyHex,
      appPubkeyHex,
      content: 'encrypted',
      createdAt: 1780710000,
    });
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1];

    expect(event.kind).toBe(WORKSPACE_SELF_INDEX_KIND);
    expect(event.tags).toContainEqual(['protocol', WORKSPACE_SELF_INDEX_PROTOCOL]);
    expect(event.tags).toContainEqual(['app_pub', appPubkeyHex]);
    expect(dTag).toMatch(/^fd-self:[0-9a-f]{64}$/);

    const second = await buildUnsignedWorkspaceSelfIndexEvent({
      workspace,
      userNpub: '',
      userPubkeyHex,
      appPubkeyHex,
      content: 'encrypted-2',
      createdAt: 1780710001,
    });
    expect(second.tags.find((tag) => tag[0] === 'd')?.[1]).toBe(dTag);

    const cleartextTags = JSON.stringify(event.tags);
    expect(cleartextTags).not.toContain('Wingers');
    expect(cleartextTags).not.toContain('tower.example');
    expect(cleartextTags).not.toContain('workspace-1');
  });

  it('publishes an encrypted credential-free workspace locator', async () => {
    let signedTemplate = null;
    let relaysSeen = [];
    const result = await publishWorkspaceSelfIndex({
      workspace: {
        ...workspace,
        connectionToken: 'must-not-appear',
      },
      userPubkeyHex,
      relayUrls: ['wss://relay.test'],
      appPubkeyHex,
      encryptForNpub: async (_npub, plaintext) => `enc:${plaintext}`,
      signEvent: async (event) => {
        signedTemplate = event;
        return realSign(event);
      },
      poolFactory: () => ({
        querySync: readback,
        publish(relays, event) {
          publishedEvent = event;
          relaysSeen = relays;
          return relays.map(() => Promise.resolve('ok'));
        },
        destroy() {},
      }),
      now: new Date('2026-06-07T00:00:00.000Z'),
    });

    expect(result.event.kind).toBe(33356);
    const operatorRelays = [
      'wss://relay.primal.net',
      'wss://proxy.nostr-relay.app/8c5723f2601334234e1922d2e842d6bbf209283b07120b3f1d38660915f13793',
    ];
    expect(result.acceptedRelays).toEqual(operatorRelays);
    expect(relaysSeen).toEqual(operatorRelays);
    expect(relaysSeen).not.toContain('wss://relay.test');
    const encrypted = signedTemplate.content;
    expect(encrypted.startsWith('enc:')).toBe(true);
    const payload = JSON.parse(encrypted.slice(4));
    expect(payload.workspace).toMatchObject({
      type: 'wingman_workspace_locator',
      tower_base_url: 'https://tower.example',
      workspace_id: 'workspace-1',
      workspace_service_npub: 'npub1workspace',
    });
    expect(JSON.stringify(payload)).not.toContain('must-not-appear');
  });

  it('rebroadcasts a previously signed self-index event without rebuilding content', async () => {
    const signedEvent = realSign({
      kind: 33356,
      pubkey: userPubkeyHex,
      created_at: 1780710000,
      tags: [
        ['d', 'fd-self:opaque'],
        ['p', userPubkeyHex],
        ['app_pub', appPubkeyHex],
        ['protocol', 'workspace-self-index'],
      ],
      content: 'encrypted',
      id: 'event-existing',
      sig: 'sig-existing',
    });
    let eventSeen = null;
    const result = await broadcastWorkspaceSelfIndexEvent({
      event: signedEvent,
      workspace,
      relayUrls: ['wss://relay.test'],
      poolFactory: () => ({
        querySync: readback,
        publish(_relays, event) {
          publishedEvent = event;
          eventSeen = event;
          return [Promise.resolve('ok')];
        },
        destroy() {},
      }),
      now: new Date('2026-06-09T00:00:00.000Z'),
    });

    expect(eventSeen).toBe(signedEvent);
    expect(result.event).toBe(signedEvent);
    expect(result.publishedAt).toBe('2026-06-09T00:00:00.000Z');
  });

  it('publishes a replacement tombstone with the same deterministic d tag', async () => {
    const activeEvent = await buildUnsignedWorkspaceSelfIndexEvent({
      workspace,
      userNpub: '',
      userPubkeyHex,
      appPubkeyHex,
      content: 'encrypted',
      createdAt: 1780710000,
    });
    const activeDTag = activeEvent.tags.find((tag) => tag[0] === 'd')?.[1];
    const payload = await buildWorkspaceSelfIndexTombstonePayload({
      workspace,
      userNpub: 'npub1user',
      appPubkeyHex,
      now: new Date('2026-06-08T00:00:00.000Z'),
      towerResult: 'workspace_deleted',
      reason: 'workspace_deleted',
      sourceEventId: 'event-33357',
    });

    expect(payload).toMatchObject({
      state: {
        deleted: true,
        status: 'deleted',
        reason: 'workspace_deleted',
        source_33357_event_id: 'event-33357',
      },
      verification: {
        tower_result: 'workspace_deleted',
      },
    });

    let signedTemplate = null;
    const result = await publishWorkspaceSelfIndexTombstone({
      workspace,
      userPubkeyHex,
      appPubkeyHex,
      towerResult: 'workspace_deleted',
      reason: 'workspace_deleted',
      sourceEventId: 'event-33357',
      encryptForNpub: async (_npub, plaintext) => `enc:${plaintext}`,
      signEvent: async (event) => {
        signedTemplate = event;
        return realSign(event);
      },
      poolFactory: () => ({
        querySync: readback,
        publish(relays, event) {
          publishedEvent = event;
          return relays.map(() => Promise.resolve('ok'));
        },
        destroy() {},
      }),
      now: new Date('2026-06-08T00:00:00.000Z'),
    });

    expect(result.event.id).toMatch(/^[a-f0-9]{64}$/);
    expect(signedTemplate.tags.find((tag) => tag[0] === 'd')?.[1]).toBe(activeDTag);
    const encryptedPayload = JSON.parse(signedTemplate.content.slice(4));
    expect(encryptedPayload.state.deleted).toBe(true);
    expect(JSON.stringify(signedTemplate.tags)).not.toContain('tower.example');
  });

  async function compatibleEvent({ host = 'tower.example', id = '11111111-1111-4111-8111-111111111111', deleted = false, time = 1, app = appPubkeyHex, content = null } = {}) {
    const npub = nip19.npubEncode(userPubkeyHex);
    const locator = { type: 'wingman_workspace_locator', version: 1, tower_base_url: `https://${host}`,
      tower_service_npub: npub, workspace_service_npub: npub, workspace_owner_npub: npub,
      workspace_id: id, app_npub: npub, label: host };
    const payload = { type: 'flightdeck_workspace_self_index', version: 1, user_npub: npub,
      app: { app_npub: nip19.npubEncode(app), app_pubkey: app, namespace: 'flightdeck_pg' },
      workspace: locator, state: { deleted } };
    const unsigned = await buildUnsignedWorkspaceSelfIndexEvent({ workspace: locator, userPubkeyHex,
      appPubkeyHex: app, content: content ?? `enc:${JSON.stringify(payload)}`, createdAt: time });
    return realSign(unsigned);
  }
  async function candidates(events) {
    const calls = [];
    const result = await queryWorkspaceSelfIndexCandidates({ userPubkeyHex,
      decryptFromNpub: async (_npub, ciphertext) => ciphertext.slice(4),
      poolFactory: () => ({ querySync: async (_relays, filter) => { calls.push(filter); return events; }, destroy() {} }) });
    for (const filter of calls) expect(filter).not.toHaveProperty('#app_pub');
    return result;
  }
  it('accepts foreign app indexes on two Towers without an app filter', async () => {
    const a = await compatibleEvent();
    const b = await compatibleEvent({ host: 'second.example', id: '22222222-2222-4222-8222-222222222222', app: userPubkeyHex });
    const result = await candidates([null,{},a,b]);
    expect(result.candidates.map((c) => c.locator.tower_base_url).sort()).toEqual(['https://second.example','https://tower.example']);
  });
  it('suppresses stale active events with newest tombstones and allows explicit newer recovery', async () => {
    const active = await compatibleEvent();
    const deleted = await compatibleEvent({ deleted: true, time: 2 });
    expect((await candidates([active,deleted])).candidates).toHaveLength(0);
    expect((await candidates([active,deleted])).tombstones).toHaveLength(1);
    expect((await candidates([active,deleted,await compatibleEvent({time:3})])).candidates).toHaveLength(1);
  });
  it('does not resurrect an older locator when its signed replacement cannot decrypt', async () => {
    expect((await candidates([await compatibleEvent(),await compatibleEvent({time:2,content:'invalid'})])).candidates).toHaveLength(0);
  });
  it('ignores tampered signatures without suppressing a valid address', async () => {
    const event = await compatibleEvent();
    expect((await candidates([event,{...event,created_at:99}])).candidates).toHaveLength(1);
    await expect(decryptWorkspaceSelfIndexEvent({ event:{...event,content:'tampered'},userPubkeyHex })).rejects.toThrow('signature');
  });
  it('does not revive an older address after a newer malformed routing-tag replacement', async () => {
    const old = await compatibleEvent();
    for (const extra of [[['p', userPubkeyHex]], [['d', 'second-invalid-address']]]) {
      const malformed = realSign({ ...old, created_at: 3, tags: [...old.tags, ...extra] });
      expect((await candidates([old, malformed])).candidates).toHaveLength(0);
    }
  });

});
