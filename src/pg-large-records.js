import { getWorkspaceDb } from './db.js';
import { applyPgRecordChanges, recordDeltaCursorKey, validatePgRecordPage, PG_RECORD_DELTA_FAMILIES } from './pg-record-delta.js';
import { assertDeviceLease, canonicalClientId, validateBoundedHandover } from './pg-device-checkpoints.js';
import { resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';
import { sha256 } from '@noble/hashes/sha2.js';

const KEY = 'record-large-assembly';
const chunkKey = index => `${KEY}:chunk:${index}`;
export const LARGE_RECORD_CACHE_BYTES = 64 * 1024 * 1024;
const TTL = 7 * 24 * 60 * 60 * 1000;

export function validateLargeRecordManifest(page) {
  const manifest = page.large_records?.[0];
  if (page.large_records?.length !== 1 || page.changes?.length || page.actors?.length
    || !canonicalClientId(manifest?.manifest_id) || !PG_RECORD_DELTA_FAMILIES.includes(manifest.family)
    || typeof manifest.id !== 'string' || !manifest.id || !/^\d+$/.test(manifest.version)
    || !/^[0-9a-f]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.total_bytes)
    || manifest.total_bytes <= 0 || manifest.chunk_bytes !== 262144
    || manifest.chunk_count !== Math.ceil(manifest.total_bytes / manifest.chunk_bytes)) throw new Error('Invalid large record manifest');
  if (manifest.total_bytes > LARGE_RECORD_CACHE_BYTES) throw new Error('Large record exceeds local assembly storage budget; coverage incomplete');
  return manifest;
}

async function clearAssembly(db) {
  const prior = (await db.sync_state.get(KEY))?.value;
  if (prior) await db.sync_state.bulkDelete(Array.from({ length: prior.manifest.chunk_count }, (_, i) => chunkKey(i)));
  await db.sync_state.delete(KEY);
}

async function assertAssemblyAuthority(db, store, options, page) {
  await assertDeviceLease(db, options.deviceLease);
  const state = (await db.sync_state.get(recordDeltaCursorKey(store)))?.value;
  if (!state?.device || state.device.clientId !== page.client_id || state.device.scope !== options.deviceScope
    || state.device.authorityEpoch !== options.authorityEpoch || state.cursor !== options.expectedCursor
    || Number(state.localGeneration || 0) !== options.expectedGeneration) throw new Error('Large record cache authority changed');
}

// Executed only in the existing materialisation worker. One assembly per physical
// cache, bounded persistent chunks, no cursor/ack movement before verified commit.
export async function materializeLargeRecord(store, action, options = {}) {
  const db = getWorkspaceDb();
  if (action.type === 'discard') return db.transaction('rw', db.sync_state, async () => {
    await assertDeviceLease(db, options.deviceLease);
    await clearAssembly(db);
  });
  if (action.type === 'begin') {
    const context = resolveTowerPgWorkspaceContext(store), page = action.page;
    validatePgRecordPage(page, context.workspaceId, { allowManifest: true });
    validateBoundedHandover(page, options.authorityEpoch);
    const manifest = validateLargeRecordManifest(page);
    return db.transaction('rw', db.sync_state, async () => {
      await assertAssemblyAuthority(db, store, options, page);
      await clearAssembly(db);
      await db.sync_state.put({ key: KEY, value: { page, manifest, received: 0, expiresAt: Date.now() + TTL } });
      return { chunks: manifest.chunk_count };
    });
  }
  const assembly = await db.transaction('rw', db.sync_state, async () => {
    const value = (await db.sync_state.get(KEY))?.value;
    if (!value || value.expiresAt <= Date.now()) throw new Error('Large record assembly expired');
    await assertAssemblyAuthority(db, store, options, value.page);
    if (action.type === 'chunk') {
      const bytes = action.bytes;
      const expectedBytes = Math.min(262144, value.manifest.total_bytes - action.index * 262144);
      if (action.index !== value.received || !(bytes instanceof Uint8Array) || bytes.byteLength !== expectedBytes) throw new Error('Invalid large record chunk');
      await db.sync_state.put({ key: chunkKey(action.index), value: bytes });
      await db.sync_state.put({ key: KEY, value: { ...value, received: value.received + 1 } });
      return null;
    }
    if (action.type !== 'finish' || value.received !== value.manifest.chunk_count) throw new Error('Incomplete large record assembly');
    const chunks = await db.sync_state.bulkGet(Array.from({ length: value.received }, (_, i) => chunkKey(i)));
    return { ...value, chunks: chunks.map(row => row?.value) };
  });
  if (!assembly) return;
  const bytes = new Uint8Array(assembly.manifest.total_bytes);
  for (let i = 0; i < assembly.chunks.length; i++) {
    if (!(assembly.chunks[i] instanceof Uint8Array)) throw new Error('Large record cache lost');
    bytes.set(assembly.chunks[i], i * 262144);
  }
  // Native HTTP/FIPS contexts may not expose SubtleCrypto. Hash in this worker
  // with the same portable SHA-256 primitive used by the signing dependency.
  const digest = Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== assembly.manifest.sha256) throw new Error('Large record digest mismatch');
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid large record envelope'); }
  const change = envelope.change, manifest = assembly.manifest;
  if (change?.family !== manifest.family || change.id !== manifest.id || change.version !== manifest.version
    || !Array.isArray(envelope.actors)) throw new Error('Large record envelope differs from manifest');
  return applyPgRecordChanges(store, { ...assembly.page, changes: [change], actors: envelope.actors, large_records: [] }, {
    ...options, verifiedLargeRecord: true, boundedExtension: 'bounded_snapshot_v1',
    largeRecordReceipts: [{ manifest_id: manifest.manifest_id, sha256: digest }],
    beforeCommit: async () => {
      await assertAssemblyAuthority(db, store, options, assembly.page);
      await options.beforeCommit?.();
      await clearAssembly(db);
    },
  });
}
