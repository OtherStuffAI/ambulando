import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let workspaceSecret = null;
let workspaceNpub = null;
let sessionNpub = null;
let groupKeys = new Map();
const createNip98AuthHeaderMock = vi.fn(async (requestUrl, method) => `session ${method} ${requestUrl}`);
const createNip98AuthHeaderForSecretMock = vi.fn(async (requestUrl, method) => `workspace ${method} ${requestUrl}`);

vi.mock('../src/auth/nostr.js', () => ({
  createNip98AuthHeader: createNip98AuthHeaderMock,
  createNip98AuthHeaderForSecret: createNip98AuthHeaderForSecretMock,
  localDecryptFromNpub: vi.fn(),
  localEncryptForNpub: vi.fn(() => 'ciphertext'),
  personalDecryptFromNpub: vi.fn(),
  personalEncryptForNpub: vi.fn(),
}));

vi.mock('../src/crypto/workspace-keys.js', () => ({
  getActiveWorkspaceKey: vi.fn(() => null),
  getActiveWorkspaceKeySecretForAuth: vi.fn(() => workspaceSecret),
  getActiveWorkspaceKeyNpub: vi.fn(() => workspaceNpub),
}));

vi.mock('../src/crypto/group-keys.js', () => ({
  decryptPayloadForGroup: vi.fn(),
  encryptPayloadForGroup: vi.fn(),
  getActiveSessionNpub: vi.fn(() => sessionNpub),
  getGroupKey: vi.fn((groupRef) => groupKeys.get(groupRef) || null),
  getLoadedGroupKeyDiagnostics: vi.fn(() => ({})),
  hasGroupKey: vi.fn(() => false),
}));

async function sha256Hex(input) {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function jsonPayloadHash(value) {
  return sha256Hex(JSON.stringify(value));
}

function decodeNostrAuthEvent(header) {
  return JSON.parse(atob(String(header || '').replace(/^Nostr\s+/, '')));
}

function eventTag(event, tagName) {
  return (event.tags || []).find((tag) => tag[0] === tagName)?.[1] || null;
}

describe('api sync auth and owner-write detection', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workspaceSecret = null;
    workspaceNpub = null;
    sessionNpub = null;
    groupKeys = new Map();
    createNip98AuthHeaderMock.mockClear();
    createNip98AuthHeaderForSecretMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('skips group proofs for direct owner signatures', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1realowner';

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        auth: options.headers.Authorization,
        body: JSON.parse(options.body),
      }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.syncRecords({
      owner_npub: 'npub1realowner',
      records: [{
        record_id: 'rec-1',
        owner_npub: 'npub1realowner',
        signature_npub: 'npub1realowner',
        write_group_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      }],
    });

    expect(createNip98AuthHeaderForSecretMock).toHaveBeenCalledTimes(1);
    expect(createNip98AuthHeaderMock).not.toHaveBeenCalled();
    expect(result.body.group_write_tokens).toEqual({});
    expect(result.body.owner_npub).toBe('npub1realowner');
    expect(result.body.workspace_service_npub).toBe('npub1realowner');
    expect(result.body.user_npub).toBe('npub1realowner');
    expect(result.body.viewer_npub).toBe('npub1realowner');
    expect(result.body.signer_npub).toBe('npub1workspacekey');
    expect(result.body.workspace_user_key_npub).toBe('npub1workspacekey');
    expect(result.body.ws_key_npub).toBe('npub1workspacekey');
    expect(result.auth).toContain('workspace POST https://sb.example/api/v4/records/sync');
  });

  it('builds sync requests with canonical identity fields and group write proof payloads', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';
    const writeGroupId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    groupKeys.set(writeGroupId, {
      group_id: writeGroupId,
      group_npub: 'npub1groupkey',
      key_version: 1,
      secret: new Uint8Array(32).fill(8),
    });

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const record = {
      record_id: 'rec-2',
      owner_npub: 'npub1workspaceservicekey',
      signature_npub: 'npub1workspacekey',
      write_group_id: writeGroupId,
    };
    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      records: [record],
    });

    const expectedProofBody = {
      owner_npub: 'npub1workspaceservicekey',
      workspace_service_npub: 'npub1workspaceservicekey',
      user_npub: 'npub1collaborator',
      actor_npub: 'npub1collaborator',
      viewer_npub: 'npub1collaborator',
      signer_npub: 'npub1workspacekey',
      workspace_user_key_npub: 'npub1workspacekey',
      ws_key_npub: 'npub1workspacekey',
      records: result.body.records,
    };

    expect(result.body).toMatchObject({
      owner_npub: 'npub1workspaceservicekey',
      workspace_service_npub: 'npub1workspaceservicekey',
      user_npub: 'npub1collaborator',
      actor_npub: 'npub1collaborator',
      viewer_npub: 'npub1collaborator',
      signer_npub: 'npub1workspacekey',
      workspace_user_key_npub: 'npub1workspacekey',
      ws_key_npub: 'npub1workspacekey',
      records: [record],
    });
    expect(Object.keys(result.body.group_write_tokens)).toEqual([writeGroupId]);

    const proofEvent = decodeNostrAuthEvent(result.body.group_write_tokens[writeGroupId]);
    expect(eventTag(proofEvent, 'u')).toBe('https://sb.example/api/v4/records/sync');
    expect(eventTag(proofEvent, 'method')).toBe('POST');
    expect(eventTag(proofEvent, 'payload')).toBe(await jsonPayloadHash(expectedProofBody));
  });

  it('keeps pre-Phase-4 pending writes with write_group_npub syncable', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';
    const legacyWriteGroupNpub = 'npub1legacywritegroup';
    groupKeys.set(legacyWriteGroupNpub, {
      group_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      group_npub: legacyWriteGroupNpub,
      key_version: 1,
      secret: new Uint8Array(32).fill(8),
    });

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const legacyPendingRecord = {
      record_id: 'rec-legacy-write-group-npub',
      owner_npub: 'npub1workspaceservicekey',
      signature_npub: 'npub1workspacekey',
      write_group_npub: legacyWriteGroupNpub,
      owner_payload: { ciphertext: '{}' },
      group_payloads: [],
    };

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');
    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      records: [legacyPendingRecord],
    });

    expect(result.deferred).toEqual([]);
    expect(result.body.records).toEqual([legacyPendingRecord]);
    expect(Object.keys(result.body.group_write_tokens)).toEqual([legacyWriteGroupNpub]);
  });

  it('canonicalizes stale pending envelope owners to the workspace service owner', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';
    const writeGroupId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    groupKeys.set(writeGroupId, {
      group_id: writeGroupId,
      group_npub: 'npub1groupkey',
      key_version: 1,
      secret: new Uint8Array(32).fill(8),
    });

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const stalePendingRecord = {
      record_id: 'wapp-stale-owner',
      owner_npub: 'npub1appowner',
      signature_npub: 'npub1workspacekey',
      write_group_id: writeGroupId,
      owner_payload: { ciphertext: '{}' },
      group_payloads: [],
    };

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');
    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      records: [stalePendingRecord],
    });

    expect(stalePendingRecord.owner_npub).toBe('npub1appowner');
    expect(result.body.records[0]).toMatchObject({
      record_id: 'wapp-stale-owner',
      owner_npub: 'npub1workspaceservicekey',
      signature_npub: 'npub1workspacekey',
      write_group_id: writeGroupId,
    });
    expect(result.body.owner_npub).toBe('npub1workspaceservicekey');
    expect(result.body.workspace_service_npub).toBe('npub1workspaceservicekey');
    expect(Object.keys(result.body.group_write_tokens)).toEqual([writeGroupId]);
  });

  it('defers records when the write group key is missing', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      records: [{
        record_id: 'rec-missing-key',
        owner_npub: 'npub1workspaceservicekey',
        signature_npub: 'npub1workspacekey',
        write_group_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      }],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      synced: 0,
      created: 0,
      updated: 0,
      rejected: [],
      deferred: ['rec-missing-key'],
    });
  });

  it('preserves legacy permissive sync shape for records without write groups', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const record = {
      record_id: 'settings-1',
      owner_npub: 'npub1workspaceservicekey',
      record_family_hash: 'settings-family',
      signature_npub: 'npub1workspacekey',
      owner_payload: { ciphertext: '{}' },
      group_payloads: [],
    };

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');
    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      records: [record],
    });

    expect(result.body).toMatchObject({
      owner_npub: 'npub1workspaceservicekey',
      workspace_service_npub: 'npub1workspaceservicekey',
      user_npub: 'npub1collaborator',
      viewer_npub: 'npub1collaborator',
      signer_npub: 'npub1workspacekey',
      records: [record],
      group_write_tokens: {},
    });
    expect(result.deferred).toEqual([]);
  });

  it('does not mutate pending write record objects while building sync requests', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';
    const writeGroupId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    groupKeys.set(writeGroupId, {
      group_id: writeGroupId,
      group_npub: 'npub1groupkey',
      key_version: 1,
      secret: new Uint8Array(32).fill(8),
    });

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const record = {
      record_id: 'rec-immutable',
      owner_npub: 'npub1workspaceservicekey',
      signature_npub: 'npub1workspacekey',
      write_group_id: writeGroupId,
      payload: { helper: true },
    };
    const before = structuredClone(record);

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');
    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      records: [record],
    });

    expect(record).toEqual(before);
    expect(result.body.records).toEqual([{
      record_id: 'rec-immutable',
      owner_npub: 'npub1workspaceservicekey',
      signature_npub: 'npub1workspacekey',
      write_group_id: writeGroupId,
    }]);
  });

  it('uses canonical checkout identity fields for checkout acquire requests', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1owner';

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
      headers: new Headers({ 'content-type': 'application/json' }),
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.acquireRecordCheckout({
      recordId: 'doc-1',
      recordFamilyHash: 'app:document',
      identityContext: {
        workspaceServiceNpub: 'npub1workspaceservicekey',
        userNpub: 'npub1owner',
        workspaceUserKeyNpub: 'npub1workspacekey',
        signerNpub: 'npub1workspacekey',
      },
      leaseSeconds: 900,
      idempotencyKey: 'idem-1',
    });

    expect(result.body).toEqual({
      record_family_hash: 'app:document',
      workspace_service_npub: 'npub1workspaceservicekey',
      user_npub: 'npub1owner',
      workspace_user_key_npub: 'npub1workspacekey',
      signer_npub: 'npub1workspacekey',
      lease_seconds: 900,
      idempotency_key: 'idem-1',
    });
    expect(result.body.signature_npub).toBeUndefined();
    expect(createNip98AuthHeaderForSecretMock).toHaveBeenCalled();
  });

  it('preserves checkout metadata on lock-managed sync envelopes', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1owner';
    const writeGroupId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    groupKeys.set(writeGroupId, {
      group_id: writeGroupId,
      group_npub: 'npub1groupkey',
      key_version: 1,
      secret: new Uint8Array(32).fill(8),
    });

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      records: [{
        record_id: 'doc-locked',
        owner_npub: 'npub1workspaceservicekey',
        record_family_hash: 'app:document',
        signature_npub: 'npub1workspacekey',
        write_group_id: writeGroupId,
        checkout: {
          checkout_id: 'checkout-1',
          consume_on_success: true,
        },
      }],
    });

    expect(result.body.records[0].checkout).toEqual({
      checkout_id: 'checkout-1',
      consume_on_success: true,
    });
  });

  it('strips checkout metadata from default optimistic_write sync envelopes', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1owner';
    const writeGroupId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    groupKeys.set(writeGroupId, {
      group_id: writeGroupId,
      group_npub: 'npub1groupkey',
      key_version: 1,
      secret: new Uint8Array(32).fill(8),
    });

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      records: [{
        record_id: 'task-default',
        owner_npub: 'npub1workspaceservicekey',
        record_family_hash: 'app:task',
        signature_npub: 'npub1workspacekey',
        write_group_id: writeGroupId,
        checkout: {
          checkout_id: 'stale-checkout',
          consume_on_success: true,
        },
      }],
    });

    expect(result.body.records[0].checkout).toBeUndefined();
  });

  it('preserves checkout metadata for policy-opted-in task sync envelopes', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1owner';
    const writeGroupId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    groupKeys.set(writeGroupId, {
      group_id: writeGroupId,
      group_npub: 'npub1groupkey',
      key_version: 1,
      secret: new Uint8Array(32).fill(8),
    });

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      checkout_policy_config: { familySuffixes: { task: 'checkout_required' } },
      records: [{
        record_id: 'task-checkout',
        owner_npub: 'npub1workspaceservicekey',
        record_family_hash: 'app:task',
        signature_npub: 'npub1workspacekey',
        write_group_id: writeGroupId,
        checkout: {
          checkout_id: 'checkout-task-1',
          consume_on_success: true,
        },
      }],
    });

    expect(result.body.records[0].checkout).toEqual({
      checkout_id: 'checkout-task-1',
      consume_on_success: true,
    });
  });

  it('strips stale checkout metadata from force_write repair envelopes even when policy requires checkout', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1owner';
    const writeGroupId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    groupKeys.set(writeGroupId, {
      group_id: writeGroupId,
      group_npub: 'npub1groupkey',
      key_version: 1,
      secret: new Uint8Array(32).fill(8),
    });

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.syncRecords({
      owner_npub: 'npub1workspaceservicekey',
      checkout_policy_config: { familySuffixes: { task: 'checkout_required' } },
      records: [{
        record_id: 'task-force-repair',
        owner_npub: 'npub1workspaceservicekey',
        record_family_hash: 'app:task',
        version: 6,
        previous_version: 5,
        signature_npub: 'npub1workspacekey',
        write_group_id: writeGroupId,
        force_write: true,
        checkout: {
          checkout_id: 'stale-checkout',
          consume_on_success: true,
        },
      }],
    });

    expect(result.body.records[0]).toMatchObject({
      record_id: 'task-force-repair',
      force_write: true,
    });
    expect(result.body.records[0].checkout).toBeUndefined();
  });

  it('uses the workspace key identity on workspace-key-signed record history reads', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn(async (requestUrl) => ({
      ok: true,
      status: 200,
      json: async () => ({ requestUrl }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.fetchRecordHistory({
      record_id: 'rec-1',
      owner_npub: 'npub1owner',
      viewer_npub: 'npub1collaborator',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://sb.example/api/v4/records/rec-1/history?owner_npub=npub1owner&workspace_user_key_npub=npub1workspacekey&ws_key_npub=npub1workspacekey&viewer_npub=npub1workspacekey'
    );
    expect(result.requestUrl).toBe(
      'https://sb.example/api/v4/records/rec-1/history?owner_npub=npub1owner&workspace_user_key_npub=npub1workspacekey&ws_key_npub=npub1workspacekey&viewer_npub=npub1workspacekey'
    );
  });

  it('uses the workspace key identity on workspace-key-signed record pulls', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn(async (requestUrl) => ({
      ok: true,
      status: 200,
      json: async () => ({ requestUrl, records: [] }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.fetchRecords({
      owner_npub: 'npub1owner',
      viewer_npub: 'npub1collaborator',
      record_family_hash: 'family-1',
      since: '2026-04-22T00:00:00.000Z',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://sb.example/api/v4/records?owner_npub=npub1owner&workspace_user_key_npub=npub1workspacekey&ws_key_npub=npub1workspacekey&viewer_npub=npub1workspacekey&record_family_hash=family-1&since=2026-04-22T00%3A00%3A00.000Z&limit=1000&offset=0'
    );
    expect(result.requestUrl).toBe(
      'https://sb.example/api/v4/records?owner_npub=npub1owner&workspace_user_key_npub=npub1workspacekey&ws_key_npub=npub1workspacekey&viewer_npub=npub1workspacekey&record_family_hash=family-1&since=2026-04-22T00%3A00%3A00.000Z&limit=1000&offset=0'
    );
  });

  it('paginates workspace-key-signed record pulls until Tower has no more records', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn(async (requestUrl) => {
      const offset = new URL(requestUrl).searchParams.get('offset');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          requestUrl,
          records: offset === '0'
            ? [{ record_id: 'comment-page-1' }]
            : [{ record_id: 'comment-page-2' }],
          has_more: offset === '0',
          total: 2,
        }),
        text: async () => '',
      };
    });
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.fetchRecords({
      owner_npub: 'npub1owner',
      viewer_npub: 'npub1collaborator',
      record_family_hash: 'family-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://sb.example/api/v4/records?owner_npub=npub1owner&workspace_user_key_npub=npub1workspacekey&ws_key_npub=npub1workspacekey&viewer_npub=npub1workspacekey&record_family_hash=family-1&limit=1000&offset=0'
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://sb.example/api/v4/records?owner_npub=npub1owner&workspace_user_key_npub=npub1workspacekey&ws_key_npub=npub1workspacekey&viewer_npub=npub1workspacekey&record_family_hash=family-1&limit=1000&offset=1'
    );
    expect(result.records).toEqual([
      { record_id: 'comment-page-1' },
      { record_id: 'comment-page-2' },
    ]);
    expect(result.has_more).toBe(false);
  });

  it('uses the workspace key identity on workspace-key-signed heartbeat checks', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ body: JSON.parse(options.body) }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.fetchHeartbeat({
      owner_npub: 'npub1owner',
      viewer_npub: 'npub1collaborator',
      family_cursors: { task: 'cursor-1' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.body).toEqual({
      owner_npub: 'npub1owner',
      viewer_npub: 'npub1workspacekey',
      workspace_user_key_npub: 'npub1workspacekey',
      ws_key_npub: 'npub1workspacekey',
      family_cursors: { task: 'cursor-1' },
    });
  });

  it('adds workspace key identity to workspace-key-signed records summary reads', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn(async (requestUrl) => ({
      ok: true,
      status: 200,
      json: async () => ({ requestUrl, families: [] }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    await api.fetchRecordsSummary('npub1owner');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://sb.example/api/v4/records/summary?owner_npub=npub1owner&workspace_user_key_npub=npub1workspacekey&ws_key_npub=npub1workspacekey'
    );
  });

  it('falls back to the active workspace key when viewer_npub is omitted under workspace-key auth', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn(async (requestUrl) => ({
      ok: true,
      status: 200,
      json: async () => ({ requestUrl, records: [] }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    await api.fetchRecords({
      owner_npub: 'npub1owner',
      record_family_hash: 'family-1',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://sb.example/api/v4/records?owner_npub=npub1owner&workspace_user_key_npub=npub1workspacekey&ws_key_npub=npub1workspacekey&viewer_npub=npub1workspacekey&record_family_hash=family-1&limit=1000&offset=0'
    );
  });

  it('registers workspace keys with real-user auth even when workspace auth is active', async () => {
    workspaceSecret = new Uint8Array(32).fill(7);
    workspaceNpub = 'npub1workspacekey';
    sessionNpub = 'npub1collaborator';

    const fetchMock = vi.fn(async (_requestUrl, options) => ({
      ok: true,
      status: 201,
      json: async () => ({
        auth: options.headers.Authorization,
        body: JSON.parse(options.body),
      }),
      text: async () => '',
    }));
    globalThis.fetch = fetchMock;

    const api = await import('../src/api.js');
    api.setBaseUrl('https://sb.example');

    const result = await api.registerWorkspaceKey({
      workspace_owner_npub: 'npub1owner',
      ws_key_npub: 'npub1workspacekey',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://sb.example/api/v4/user/workspace-keys');
    expect(createNip98AuthHeaderMock).toHaveBeenCalledWith(
      'https://sb.example/api/v4/user/workspace-keys',
      'POST',
      {
        workspace_owner_npub: 'npub1owner',
        ws_key_npub: 'npub1workspacekey',
      },
    );
    expect(createNip98AuthHeaderForSecretMock).not.toHaveBeenCalled();
    expect(result.auth).toContain('session POST https://sb.example/api/v4/user/workspace-keys');
    expect(result.body).toEqual({
      workspace_owner_npub: 'npub1owner',
      ws_key_npub: 'npub1workspacekey',
    });
  });
});

it('signs exact v2 registration, page, acknowledgement, read and retirement requests', async () => {
  const previousFetch = globalThis.fetch;
  workspaceSecret = new Uint8Array(32).fill(7);
  createNip98AuthHeaderMock.mockClear(); createNip98AuthHeaderForSecretMock.mockClear();
  const requests = [];
  globalThis.fetch = vi.fn(async (url, options) => { requests.push({ url, ...options }); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; });
  try {
    const api = await import('../src/api.js');
    const baseUrl = 'http://localhost:3100', workspace = 'workspace', client = '10000000-0000-4000-8000-000000000001';
    const common = { baseUrl, appNpub: 'app' };
    await api.towerPgRecordClient(workspace, client, { ...common, operation: 'register' });
    await api.getTowerPgRecordSync(workspace, { ...common, protocolVersion: 2, clientId: client, cursor: 'local', limit: 200 });
    await api.towerPgRecordClient(workspace, client, { ...common, operation: 'ack', cursor: 'next', expectedRevision: '9007199254740993' });
    await api.towerPgRecordClient(workspace, client, { ...common, operation: 'read' });
    await api.towerPgRecordClient(workspace, client, { ...common, operation: 'retire' });
    expect(requests.map(r => r.method)).toEqual(['POST', 'GET', 'POST', 'GET', 'DELETE']);
    expect(requests[0].body).toBe('');
    expect(requests[1].url).toContain(`protocol_version=2&limit=200&client_id=${client}&cursor=local`);
    expect(requests[2].body).toBe('{"cursor":"next","expected_revision":"9007199254740993"}');
    expect(requests[2].url).toContain(`/clients/${client}/ack?protocol_version=2`);
    for (let i = 0; i < requests.length; i++) {
      const [signedUrl, signedMethod, signedBody] = createNip98AuthHeaderMock.mock.calls[i];
      expect(signedUrl).toBe(requests[i].url); expect(signedMethod).toBe(requests[i].method);
      const serialized = signedBody == null ? undefined : typeof signedBody === 'string' ? signedBody : JSON.stringify(signedBody);
      expect(serialized).toBe(requests[i].body);
    }
    expect(createNip98AuthHeaderForSecretMock).not.toHaveBeenCalled();
    await expect(api.getTowerPgRecordSync(workspace, { ...common, protocolVersion: 2, clientId: client })).rejects.toThrow('local cursor');
  } finally { globalThis.fetch = previousFetch; workspaceSecret = null; }
});
