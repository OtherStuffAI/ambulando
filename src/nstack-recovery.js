import { verifyEvent } from 'nostr-tools';

export const NSTACK_RECOVERY_KIND = 30078;
export const NSTACK_RECOVERY_SCHEMA = 'ambulando.nstack-recovery';
export const NSTACK_RECOVERY_VERSION = 1;
export const NSTACK_RECOVERY_TYPES = Object.freeze({
  HOST_HINT: 'host_hint',
  INDEX: 'recovery_index',
  DESCRIPTOR: 'nstack_descriptor',
  WORKSPACES: 'workspace_catalogue',
  MANIFEST: 'backup_manifest',
  POLICY: 'policy_intent',
});

const KNOWN_TYPES = new Set(Object.values(NSTACK_RECOVERY_TYPES));

function text(value) {
  return String(value ?? '').trim();
}

// nostr-tools memoizes verification on event objects. Recovery records may
// come from untrusted caches, so always verify a fresh plain event and never
// inherit symbols or cached verification state from the input object.
function eventForVerification(event = {}) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function strings(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some(value => !text(value))) throw new Error(`${label} must be a non-empty string list.`);
  return [...new Set(values.map(text))];
}

function validUrl(value, protocols, label) {
  const raw = text(value);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} is not a valid URL.`); }
  if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${label} uses an unsupported URL.`);
  return raw.replace(/\/$/, '');
}

function validateData(type, input) {
  const data = object(input, `${type} data`);
  if (type === NSTACK_RECOVERY_TYPES.HOST_HINT) {
    const host = object(data.host, 'host hint host');
    return {
      host: { stackId: text(host.stackId), endpoint: validUrl(host.endpoint, ['https:'], 'Host NStack endpoint') },
      recoveryRelays: strings(data.recoveryRelays, 'Recovery relays').map(value => validUrl(value, ['wss:'], 'Recovery relay')),
    };
  }
  if (type === NSTACK_RECOVERY_TYPES.INDEX) {
    return {
      stackRecords: (data.stackRecords || []).map((entry) => {
        object(entry, 'Stack record address');
        return {
          descriptor: text(entry.descriptor),
          workspaces: text(entry.workspaces),
          policy: text(entry.policy),
        };
      }).map((entry) => {
        if (!entry.descriptor || !entry.workspaces) throw new Error('Recovery index stack addresses are incomplete.');
        return entry;
      }),
      snapshotReferences: (data.snapshotReferences || []).map(text).filter(Boolean),
    };
  }
  if (type === NSTACK_RECOVERY_TYPES.DESCRIPTOR) {
    const protocolVersions = object(data.protocolVersions || {}, 'Protocol versions');
    const servicePubkeys = object(data.servicePubkeys || {}, 'Service pubkeys');
    const stackId = text(data.stackId);
    if (!stackId) throw new Error('NStack descriptor has no stack id.');
    return {
      stackId,
      label: text(data.label) || 'Unnamed NStack',
      endpoint: validUrl(data.endpoint, ['https:'], 'NStack endpoint'),
      servicePubkeys: Object.fromEntries(Object.entries(servicePubkeys).map(([key, value]) => [text(key), text(value)]).filter(([key, value]) => key && value)),
      protocolVersions: Object.fromEntries(Object.entries(protocolVersions).map(([key, value]) => [text(key), text(value)]).filter(([key, value]) => key && value)),
    };
  }
  if (type === NSTACK_RECOVERY_TYPES.WORKSPACES) {
    const stackId = text(data.stackId);
    if (!stackId) throw new Error('Workspace catalogue has no stack id.');
    return {
      stackId,
      workspaces: (data.workspaces || []).map((entry) => ({ id: text(entry?.id), label: text(entry?.label) || 'Unnamed workspace' })).map((entry) => {
        if (!entry.id) throw new Error('Workspace catalogue entry has no id.');
        return entry;
      }),
    };
  }
  if (type === NSTACK_RECOVERY_TYPES.MANIFEST) {
    const blob = object(data.blob, 'Backup blob manifest');
    const wrappedDataKey = object(data.wrappedDataKey, 'Wrapped data key');
    const size = Number(blob.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Backup blob size is invalid.');
    if (!/^[0-9a-f]{64}$/i.test(text(blob.sha256))) throw new Error('Backup blob hash must be SHA-256 hex.');
    const snapshotId = text(data.snapshotId);
    const blobAlgorithm = text(blob.algorithm);
    const keyAlgorithm = text(wrappedDataKey.algorithm);
    const wrappedCiphertext = text(wrappedDataKey.ciphertext);
    if (!snapshotId || !blobAlgorithm || !keyAlgorithm || !wrappedCiphertext) throw new Error('Backup manifest/key envelope is incomplete.');
    return {
      stackId: text(data.stackId),
      snapshotId,
      blob: {
        location: validUrl(blob.location, ['https:'], 'Backup blob location'),
        sha256: text(blob.sha256).toLowerCase(),
        size,
        algorithm: blobAlgorithm,
      },
      wrappedDataKey: { algorithm: keyAlgorithm, ciphertext: wrappedCiphertext },
    };
  }
  if (type === NSTACK_RECOVERY_TYPES.POLICY) {
    const stackId = text(data.stackId);
    if (!stackId) throw new Error('Policy intent has no stack id.');
    return {
      stackId,
      workspaceId: text(data.workspaceId),
      capabilities: strings(data.capabilities, 'Policy capabilities'),
    };
  }
  throw new Error('Unknown NStack recovery record type.');
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function nstackRecoveryD(type, logicalKey = 'current') {
  if (!KNOWN_TYPES.has(type)) throw new Error('Unknown NStack recovery record type.');
  const key = text(logicalKey) || 'current';
  const digest = await sha256Hex(`${NSTACK_RECOVERY_SCHEMA}:v${NSTACK_RECOVERY_VERSION}:${type}:${key}`);
  return `ambulando:nstack:v1:${digest}`;
}

export function nstackRecoveryAddress(pubkey, d) {
  return `${NSTACK_RECOVERY_KIND}:${text(pubkey).toLowerCase()}:${text(d)}`;
}

export function parseNStackRecoveryAddress(address) {
  const [kind, pubkey, ...dParts] = text(address).split(':');
  const d = dParts.join(':');
  if (Number(kind) !== NSTACK_RECOVERY_KIND || !/^[0-9a-f]{64}$/i.test(pubkey) || !d) throw new Error('Malformed NStack recovery address.');
  return { kind: NSTACK_RECOVERY_KIND, pubkey: pubkey.toLowerCase(), d };
}

export async function buildNStackRecoveryEvent({ type, logicalKey = 'current', data, deleted = false, signer, createdAt } = {}) {
  if (!signer?.getPublicKey || !signer?.encrypt || !signer?.signEvent) throw new Error('A signer with NIP-44 v2 and event signing is required.');
  if (!KNOWN_TYPES.has(type)) throw new Error('Unknown NStack recovery record type.');
  const pubkey = text(await signer.getPublicKey()).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Signer returned an invalid public key.');
  const d = await nstackRecoveryD(type, logicalKey);
  const envelope = {
    schema: NSTACK_RECOVERY_SCHEMA,
    version: NSTACK_RECOVERY_VERSION,
    type,
    deleted: deleted === true,
    data: deleted ? null : validateData(type, data),
  };
  const content = await signer.encrypt(pubkey, JSON.stringify(envelope));
  const signed = await signer.signEvent({
    kind: NSTACK_RECOVERY_KIND,
    created_at: Number.isSafeInteger(createdAt) ? createdAt : Math.floor(Date.now() / 1000),
    tags: [['d', d]],
    content,
  });
  if (text(signed?.pubkey).toLowerCase() !== pubkey || !verifyEvent(eventForVerification(signed))) throw new Error('Signer returned an invalid NStack recovery event.');
  return signed;
}

export async function buildNStackRecoveryDeletionRequest({ addresses, signer, createdAt } = {}) {
  if (!signer?.signEvent) throw new Error('An event signer is required for NIP-09 cleanup.');
  const uniqueAddresses = [...new Set((addresses || []).map(text).filter(Boolean))];
  if (uniqueAddresses.length === 0) throw new Error('NIP-09 cleanup requires at least one NStack recovery address.');
  uniqueAddresses.forEach(parseNStackRecoveryAddress);
  return signer.signEvent({
    kind: 5,
    created_at: Number.isSafeInteger(createdAt) ? createdAt : Math.floor(Date.now() / 1000),
    tags: [
      ...uniqueAddresses.map(address => ['a', address]),
      ['k', String(NSTACK_RECOVERY_KIND)],
    ],
    content: 'Best-effort cleanup after an encrypted NStack recovery tombstone.',
  });
}

export async function parseNStackRecoveryEvent(event, { author, signer, expectedD, verify = verifyEvent } = {}) {
  if (!event || event.kind !== NSTACK_RECOVERY_KIND) throw new Error('Not a NIP-78 addressable event.');
  if (!verify(eventForVerification(event))) throw new Error('NStack recovery event signature is invalid.');
  const normalizedAuthor = text(author).toLowerCase();
  if (normalizedAuthor && text(event.pubkey).toLowerCase() !== normalizedAuthor) throw new Error('NStack recovery event has the wrong author.');
  const dTags = (event.tags || []).filter(tag => tag?.[0] === 'd' && text(tag[1]));
  if (dTags.length !== 1 || (event.tags || []).length !== 1) throw new Error('NStack recovery event has non-minimal public tags.');
  if (expectedD && dTags[0][1] !== expectedD) throw new Error('NStack recovery event has the wrong address.');
  if (!signer?.decrypt) throw new Error('A NIP-44 v2 signer is required to restore recovery data.');
  let envelope;
  try { envelope = JSON.parse(await signer.decrypt(event.pubkey, event.content)); }
  catch { throw new Error('NStack recovery content could not be decrypted.'); }
  if (envelope?.schema !== NSTACK_RECOVERY_SCHEMA || envelope?.version !== NSTACK_RECOVERY_VERSION) throw new Error('Unsupported NStack recovery schema.');
  if (!KNOWN_TYPES.has(envelope.type)) throw new Error('Unknown NStack recovery record type.');
  return {
    event,
    d: dTags[0][1],
    type: envelope.type,
    deleted: envelope.deleted === true,
    data: envelope.deleted === true ? null : validateData(envelope.type, envelope.data),
  };
}

export async function newestValidNStackRecoveryEvent(events, options = {}) {
  const ordered = [...(events || [])].sort((left, right) => {
    const time = Number(right?.created_at || 0) - Number(left?.created_at || 0);
    return time || text(left?.id).localeCompare(text(right?.id));
  });
  const failures = [];
  for (const event of ordered) {
    try { return { record: await parseNStackRecoveryEvent(event, options), failures }; }
    catch (error) { failures.push({ eventId: text(event?.id), error: error.message }); }
  }
  return { record: null, failures };
}

export class UnavailableNStackBlobAdapter {
  async upload() { throw new Error('Encrypted snapshot upload is unavailable: no authenticated blob adapter is configured.'); }
  async fetch() { throw new Error('Encrypted snapshot download is unavailable: no authenticated blob adapter is configured.'); }
}

export async function restoreNStackRecovery({ repository, bootstrapRelays, author, signer } = {}) {
  if (!repository?.list) throw new Error('A NStack recovery repository is required.');
  const normalizedAuthor = text(author).toLowerCase();
  const hostD = await nstackRecoveryD(NSTACK_RECOVERY_TYPES.HOST_HINT);
  const hostResult = await newestValidNStackRecoveryEvent(
    await repository.list({ relays: bootstrapRelays, author: normalizedAuthor, dValues: [hostD] }),
    { author: normalizedAuthor, signer, expectedD: hostD },
  );
  if (!hostResult.record || hostResult.record.deleted) throw new Error('No valid host-NStack recovery hint was found.');
  const recoveryRelays = hostResult.record.data.recoveryRelays;
  const indexD = await nstackRecoveryD(NSTACK_RECOVERY_TYPES.INDEX);
  const indexResult = await newestValidNStackRecoveryEvent(
    await repository.list({ relays: recoveryRelays, author: normalizedAuthor, dValues: [indexD] }),
    { author: normalizedAuthor, signer, expectedD: indexD },
  );
  if (!indexResult.record || indexResult.record.deleted) throw new Error('No valid NStack recovery index was found.');

  const records = indexResult.record.data.stackRecords;
  const dValues = [...new Set(records.flatMap(entry => [entry.descriptor, entry.workspaces, entry.policy]).filter(Boolean).map(address => parseNStackRecoveryAddress(address).d))];
  const fetched = await repository.list({ relays: recoveryRelays, author: normalizedAuthor, dValues });
  const stacks = [];
  const failures = [...hostResult.failures, ...indexResult.failures];
  for (const entry of records) {
    const descriptorAddress = parseNStackRecoveryAddress(entry.descriptor);
    const workspacesAddress = parseNStackRecoveryAddress(entry.workspaces);
    const descriptorResult = await newestValidNStackRecoveryEvent(fetched.filter(event => event.tags?.some(tag => tag[0] === 'd' && tag[1] === descriptorAddress.d)), { author: normalizedAuthor, signer, expectedD: descriptorAddress.d });
    const workspacesResult = await newestValidNStackRecoveryEvent(fetched.filter(event => event.tags?.some(tag => tag[0] === 'd' && tag[1] === workspacesAddress.d)), { author: normalizedAuthor, signer, expectedD: workspacesAddress.d });
    failures.push(...descriptorResult.failures, ...workspacesResult.failures);
    if (!descriptorResult.record || descriptorResult.record.deleted || !workspacesResult.record || workspacesResult.record.deleted) {
      failures.push({ address: entry.descriptor, error: 'Stack recovery records are incomplete or tombstoned.' });
      continue;
    }
    let policy = null;
    if (entry.policy) {
      const policyAddress = parseNStackRecoveryAddress(entry.policy);
      const policyResult = await newestValidNStackRecoveryEvent(fetched.filter(event => event.tags?.some(tag => tag[0] === 'd' && tag[1] === policyAddress.d)), { author: normalizedAuthor, signer, expectedD: policyAddress.d });
      failures.push(...policyResult.failures);
      if (policyResult.record && !policyResult.record.deleted) policy = policyResult.record.data;
    }
    stacks.push({ descriptor: descriptorResult.record.data, workspaceCatalogue: workspacesResult.record.data, policyIntent: policy });
  }
  return { hostHint: hostResult.record.data, index: indexResult.record.data, stacks, failures };
}
