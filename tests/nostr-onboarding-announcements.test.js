import { describe, expect, it, vi } from 'vitest';
import { FLIGHT_DECK_PG_APP_NPUB } from '../src/app-identity.js';
import { generateLocalIdentity } from '../src/auth/nostr.js';
import {
  ONBOARDING_ANNOUNCEMENT_KIND,
  ONBOARDING_PROTOCOL,
  buildOnboardingAnnouncementPayload,
  buildUnsignedOnboardingAnnouncementEvent,
  decryptOnboardingAnnouncementEvent,
  flightDeckOnboardingAppPubkeyHex,
  onboardingLocatorFromPayload,
  onboardingAnnouncementRelayUrls,
  publishOnboardingAnnouncement,
  queryOnboardingAnnouncementCandidates,
  validateOnboardingAnnouncementPayload,
} from '../src/nostr-onboarding-announcements.js';

const issuer = generateLocalIdentity();
const recipient = generateLocalIdentity();
const app = generateLocalIdentity();
const appPubkeyHex = flightDeckOnboardingAppPubkeyHex(app.npub);
const defaultPgAppNpub = FLIGHT_DECK_PG_APP_NPUB;

const workspace = {
  workspaceId: 'workspace-1',
  workspaceOwnerNpub: 'npub1owner',
  workspaceServiceNpub: 'npub1workspace',
  directHttpsUrl: 'https://tower.example',
  towerServiceNpub: 'npub1tower',
  serviceNpub: 'npub1tower',
  name: 'Wingers',
  relayUrls: ['wss://relay.test'],
  pgBackendMode: true,
};

const agentConnect = {
  kind: 'coworker_agent_connect',
  version: 6,
  protocol: 'flightdeck_pg',
  generated_at: '2026-06-07T00:00:00.000Z',
  llms_url: 'https://fd.example/llms.txt',
  service: {
    direct_https_url: 'https://tower.example',
  },
  auth: {
    scheme: 'NIP-98',
    app_header: 'x-flightdeck-pg-app-npub',
    app_npub: app.npub,
    app_pubkey: app.pubkey,
  },
  workspace_descriptor: {
    type: 'wingman_workspace_locator',
    version: 1,
    tower_base_url: 'https://tower.example',
    identity: {
      tower_service_npub: 'npub1tower',
      workspace_service_npub: 'npub1workspace',
      workspace_owner_npub: 'npub1owner',
      workspace_id: 'workspace-1',
      app_npub: defaultPgAppNpub,
    },
  },
};

async function validPayload(overrides = {}) {
  return buildOnboardingAnnouncementPayload({
    recipientNpub: recipient.npub,
    issuedByNpub: issuer.npub,
    workspace,
    agentConnect,
    appNpub: app.npub,
    appPubkeyHex,
    now: new Date('2026-06-07T00:00:00.000Z'),
    ...overrides,
  });
}

describe('Nostr kind 33357 onboarding announcements', () => {
  it.each(['encryption', 'signing'])('expires stalled %s before publication even if the signer resolves late', async (stage) => {
    vi.useFakeTimers();
    let finish;
    const stalled = new Promise(resolve => { finish = resolve; });
    const poolFactory = vi.fn();
    let started;
    const stageStarted = new Promise(resolve => { started = resolve; });
    try {
      const publication = publishOnboardingAnnouncement({
        recipientNpub: recipient.npub, issuerNpub: issuer.npub, issuerPubkeyHex: issuer.pubkey,
        workspace, agentConnect, appNpub: app.npub, appPubkeyHex,
        encryptForNpub: () => { if (stage === 'encryption') { started(); return stalled; } return Promise.resolve('encrypted'); },
        signEvent: () => { started(); return stalled; },
        poolFactory,
      });
      const rejected = expect(publication).rejects.toThrow(`Onboarding ${stage} timed out`);
      await stageStarted;
      await vi.advanceTimersByTimeAsync(45_000);
      await rejected;
      finish(stage === 'signing' ? { id: 'late' } : 'late encryption');
      await Promise.resolve();
      expect(poolFactory).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('defaults to Primal first without retired or local relays', () => {
    const relays = onboardingAnnouncementRelayUrls();
    expect(relays[0]).toBe('wss://relay.primal.net');
    expect(relays).not.toContain('wss://relay.damus.io');
    expect(relays).not.toContain('ws://127.0.0.1:4869');
  });

  it('builds a valid addressable event with only d/p/app_pub/protocol cleartext tags', async () => {
    let signedTemplate = null;
    let relaysSeen = [];
    const result = await publishOnboardingAnnouncement({
      recipientNpub: recipient.npub,
      issuerNpub: issuer.npub,
      issuerPubkeyHex: issuer.pubkey,
      workspace,
      agentConnect,
      relayUrls: ['wss://relay.test'],
      appNpub: app.npub,
      appPubkeyHex,
      encryptForNpub: async (npub, plaintext) => `enc:${npub}:${plaintext}`,
      signEvent: async (event) => {
        signedTemplate = event;
        return { ...event, id: 'event-1', sig: 'sig' };
      },
      poolFactory: () => ({
        publish(relays) {
          relaysSeen = relays;
          return relays.map(() => Promise.resolve('ok'));
        },
        destroy() {},
      }),
      now: new Date('2026-06-07T00:00:00.000Z'),
    });

    expect(result.event.kind).toBe(ONBOARDING_ANNOUNCEMENT_KIND);
    const operatorRelays = [
      'wss://relay.primal.net',
      'wss://proxy.nostr-relay.app/8c5723f2601334234e1922d2e842d6bbf209283b07120b3f1d38660915f13793',
    ];
    expect(result.acceptedRelays).toEqual(operatorRelays);
    expect(relaysSeen).toEqual(operatorRelays);
    expect(relaysSeen).not.toContain('wss://relay.test');
    expect(signedTemplate.tags).toEqual([
      ['d', `wingman-access-grant:v1:${workspace.towerServiceNpub}:${workspace.workspaceServiceNpub}:${app.npub}:${recipient.npub}`],
      ['p', recipient.pubkey],
      ['app_pub', appPubkeyHex],
      ['protocol', ONBOARDING_PROTOCOL],
    ]);
    expect(signedTemplate.content.startsWith(`enc:${recipient.npub}:`)).toBe(true);
    const tagsText = JSON.stringify(signedTemplate.tags);
    expect(tagsText).not.toContain('tower.example');
    expect(tagsText).not.toContain('Wingers');
    expect(tagsText).not.toContain('connection_token');
    expect(tagsText).not.toContain('scope');
    expect(tagsText).not.toContain('channel');
    expect(tagsText).not.toContain('group');

    const payload = JSON.parse(signedTemplate.content.split(':').slice(2).join(':'));
    expect(payload).toMatchObject({
      type: 'flightdeck_onboarding',
      version: 1,
      protocol: 'onboarding',
      recipient_npub: recipient.npub,
      app: {
        app_npub: app.npub,
        app_pubkey: appPubkeyHex,
      },
      workspace: {
        owner_npub: 'npub1owner',
        workspace_service_npub: 'npub1workspace',
        workspace_id: 'workspace-1',
        app_npub: defaultPgAppNpub,
      },
      agent_connect: {
        kind: 'coworker_agent_connect',
        protocol: 'flightdeck_pg',
        workspace_descriptor: {
          type: 'wingman_workspace_locator',
        },
      },
      grant: {
        reason: 'added_to_workspace_or_group',
      },
    });
    expect(JSON.stringify(payload)).not.toContain('channel_id');
    expect(JSON.stringify(payload)).not.toContain('scope_id');
    expect(JSON.stringify(payload)).not.toContain('group_id');
    expect(JSON.stringify(payload)).not.toContain('task_id');
    expect(JSON.stringify(payload)).not.toContain('doc_id');
  });

  it('keeps the routing app separate from the PG workspace app namespace', async () => {
    const payload = await validPayload();

    expect(payload.app.app_npub).toBe(app.npub);
    expect(payload.workspace.app_npub).toBe(defaultPgAppNpub);
    expect(onboardingLocatorFromPayload(payload).identity.app_npub).toBe(defaultPgAppNpub);
  });

  it('defaults older onboarding payloads without a workspace app namespace to the configured PG app npub', async () => {
    const payload = await validPayload();
    delete payload.workspace.app_npub;

    expect(payload.app.app_npub).toBe(app.npub);
    expect(onboardingLocatorFromPayload(payload).identity.app_npub).toBe(defaultPgAppNpub);
  });

  it('rejects invalid encrypted payload fields', async () => {
    const payload = await validPayload();
    expect(validateOnboardingAnnouncementPayload(payload, {
      recipientNpub: recipient.npub,
      appPubkeyHex,
      now: new Date('2026-06-08T00:00:00.000Z'),
    })).toBe(payload);

    expect(() => validateOnboardingAnnouncementPayload({
      ...payload,
      recipient_npub: issuer.npub,
    }, { recipientNpub: recipient.npub, appPubkeyHex })).toThrow(/recipient mismatch/);

    expect(() => validateOnboardingAnnouncementPayload({
      ...payload,
      app: { ...payload.app, app_pubkey: 'f'.repeat(64) },
    }, { recipientNpub: recipient.npub, appPubkeyHex })).toThrow(/app_pubkey mismatch/);

    expect(() => validateOnboardingAnnouncementPayload({
      ...payload,
      agent_connect: { ...payload.agent_connect, workspace_descriptor: null },
    }, { recipientNpub: recipient.npub, appPubkeyHex })).toThrow(/workspace descriptor/);

    expect(() => validateOnboardingAnnouncementPayload({
      ...payload,
      expires_at: '2026-06-01T00:00:00.000Z',
    }, {
      recipientNpub: recipient.npub,
      appPubkeyHex,
      now: new Date('2026-06-08T00:00:00.000Z'),
    })).toThrow(/stale/);
  });

  it('accepts revoked and deleted payloads without Agent Connect credentials', async () => {
    const payload = await validPayload({
      action: 'revoked',
      grantReason: 'workspace_deleted',
      revokedAt: '2026-06-08T00:00:00.000Z',
      revocationSource: 'tower',
    });

    expect(payload.agent_connect).toBeUndefined();
    expect(payload.expires_at).toBeUndefined();
    expect(payload.revocation).toEqual({
      reason: 'workspace_deleted',
      revoked_at: '2026-06-08T00:00:00.000Z',
      source: 'tower',
    });

    expect(validateOnboardingAnnouncementPayload(payload, {
      recipientNpub: recipient.npub,
      appPubkeyHex,
      now: new Date('2026-06-08T00:00:00.000Z'),
    })).toBe(payload);

    const event = await buildUnsignedOnboardingAnnouncementEvent({
      recipientNpub: recipient.npub,
      issuerPubkeyHex: issuer.pubkey,
      appPubkeyHex,
      content: `enc:${JSON.stringify(payload)}`,
      createdAt: 1780710000,
    });
    const decoded = await decryptOnboardingAnnouncementEvent({
      event,
      userNpub: recipient.npub,
      userPubkeyHex: recipient.pubkey,
      appPubkeyHex,
      decryptFromNpub: async (_senderNpub, ciphertext) => ciphertext.slice(4),
      now: new Date('2026-06-08T00:00:00.000Z'),
    });
    expect(decoded).toMatchObject({
      action: 'revoked',
      revoked: true,
      grantId: expect.stringMatching(/^fd-onboard:/),
    });

    payload.action = 'deleted';
    expect(validateOnboardingAnnouncementPayload(payload, {
      recipientNpub: recipient.npub,
      appPubkeyHex,
    })).toBe(payload);
  });

  it('stores supplied grant ids as opaque values in the encrypted payload', async () => {
    const payload = await validPayload({ grantId: 'workspace-1:group-1:npub1recipient' });

    expect(payload.grant.grant_id).toMatch(/^fd-onboard:[0-9a-f]{64}$/);
    expect(payload.grant.grant_id).not.toContain('workspace-1');
    expect(payload.grant.grant_id).not.toContain('group-1');
  });

  it('decrypts candidates and filters relay queries by p and app_pub', async () => {
    const payload = await validPayload();
    const event = await buildUnsignedOnboardingAnnouncementEvent({
      recipientNpub: recipient.npub,
      issuerPubkeyHex: issuer.pubkey,
      appPubkeyHex,
      content: `enc:${JSON.stringify(payload)}`,
      createdAt: 1780710000,
    });

    const decoded = await decryptOnboardingAnnouncementEvent({
      event,
      userNpub: recipient.npub,
      userPubkeyHex: recipient.pubkey,
      appPubkeyHex,
      decryptFromNpub: async (senderNpub, ciphertext) => {
        expect(senderNpub).toBe(issuer.npub);
        return ciphertext.slice(4);
      },
      now: new Date('2026-06-08T00:00:00.000Z'),
    });
    expect(decoded.locator).toMatchObject({
      type: 'wingman_workspace_locator',
      tower_base_url: 'https://tower.example',
      identity: {
        workspace_id: 'workspace-1',
        workspace_service_npub: 'npub1workspace',
      },
    });

    const queryCalls = [];
    const result = await queryOnboardingAnnouncementCandidates({
      userNpub: recipient.npub,
      userPubkeyHex: recipient.pubkey,
      appPubkeyHex,
      decryptFromNpub: async (_sender, ciphertext) => ciphertext.slice(4),
      poolFactory: () => ({
        querySync: async (relays, filter) => {
          queryCalls.push({ relays, filter });
          return [{ ...event, id: 'event-1' }];
        },
        destroy() {},
      }),
      now: new Date('2026-06-08T00:00:00.000Z'),
    });

    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].relays).toEqual([
      'wss://proxy.nostr-relay.app/8c5723f2601334234e1922d2e842d6bbf209283b07120b3f1d38660915f13793',
    ]);
    expect(queryCalls[0].filter).toMatchObject({
      kinds: [33357],
      '#p': [recipient.pubkey],
      '#app_pub': [appPubkeyHex],
    });
    expect(queryCalls[0].filter).not.toHaveProperty('#protocol');
    expect(queryCalls[1]).toMatchObject({
      relays: ['wss://relay.primal.net'],
      filter: {
        kinds: [33357],
        '#p': [recipient.pubkey],
      },
    });
    expect(queryCalls[1].filter).not.toHaveProperty('#app_pub');
    expect(queryCalls[1].filter).not.toHaveProperty('#protocol');
    expect(result.candidates).toHaveLength(1);
  });

  it('deduplicates onboarding candidates by workspace identity instead of grant id', async () => {
    const olderPayload = await validPayload({ grantId: 'grant-old' });
    const newerPayload = await validPayload({ grantId: 'grant-new' });
    const baseEvent = await buildUnsignedOnboardingAnnouncementEvent({
      recipientNpub: recipient.npub,
      issuerPubkeyHex: issuer.pubkey,
      appPubkeyHex,
      content: '',
      createdAt: 1,
    });
    const result = await queryOnboardingAnnouncementCandidates({
      userNpub: recipient.npub,
      userPubkeyHex: recipient.pubkey,
      appPubkeyHex,
      decryptFromNpub: async (_sender, ciphertext) => ciphertext.slice(4),
      poolFactory: () => ({
        querySync: async () => [
          { ...baseEvent, id: 'older', created_at: 1, content: `enc:${JSON.stringify(olderPayload)}` },
          { ...baseEvent, id: 'newer', created_at: 2, content: `enc:${JSON.stringify(newerPayload)}` },
        ],
        destroy() {},
      }),
      now: new Date('2026-06-08T00:00:00.000Z'),
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].event.id).toBe('newer');
    expect(result.candidates[0].grantId).toBe(newerPayload.grant.grant_id);
  });

  it('rejects relay publication when no relay accepts the announcement', async () => {
    await expect(publishOnboardingAnnouncement({
      recipientNpub: recipient.npub,
      issuerNpub: issuer.npub,
      issuerPubkeyHex: issuer.pubkey,
      workspace,
      agentConnect,
      relayUrls: ['wss://relay.test'],
      appNpub: app.npub,
      appPubkeyHex,
      encryptForNpub: async (_npub, plaintext) => `enc:${plaintext}`,
      signEvent: async (event) => ({ ...event, id: 'event-1', sig: 'sig' }),
      poolFactory: () => ({
        publish(relays) {
          return relays.map(() => Promise.reject(new Error('relay rejected')));
        },
        destroy() {},
      }),
    })).rejects.toThrow(/No relay accepted/);
  });
});
