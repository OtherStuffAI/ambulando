import { describe, it, expect, vi } from 'vitest';
import { resolvePgReaderActorId } from '../src/pg-reader-identity.js';
import { ensureFeedReaderIdentity, readerContext, hydrateFeedReader } from '../src/feed/tower.js';
import { openWorkspaceDb } from '../src/db.js';
import { syncManagerMixin } from '../src/sync-manager.js';

const me = (npub = 'reader-npub', actor_id = 'reader-actor', workspace_id = 'workspace') => ({ actor: { npub, actor_id }, identity: { workspace_id } });
const store = () => ({ session: { npub: 'reader-npub' }, backendUrl: 'https://tower.example', _workspaceSelectionGeneration: 1, currentWorkspace: { workspaceId: 'workspace', workspaceOwnerNpub: 'owner', pgSessionNpub: 'reader-npub', pgMe: me() } });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('canonical actual-reader store lifecycle', () => {
  it('reads normalized pgMe and the pre-normalization pg_me cache without synthetic actor fields', () => {
    const s = store(); expect(readerContext(s).readerActorId).toBe('reader-actor');
    s.currentWorkspace.pg_me = s.currentWorkspace.pgMe; delete s.currentWorkspace.pgMe;
    expect(resolvePgReaderActorId(s)).toBe('reader-actor');
  });
  it('hydrates the canonical computed workspace getter backed by knownWorkspaces', async () => {
    const s = store(), workspace = s.currentWorkspace; delete workspace.pgMe;
    delete s.currentWorkspace; s.knownWorkspaces = [workspace];
    Object.defineProperty(s, 'currentWorkspace', { get() { return this.knownWorkspaces[0]; } });
    await ensureFeedReaderIdentity(s, { readMe: async () => me() });
    expect(s.knownWorkspaces[0].pgMe.actor.actor_id).toBe('reader-actor');
    expect(readerContext(s).readerActorId).toBe('reader-actor');
  });
  it('rejects cached owner, workspace key, wrong workspace and previous signer identities', () => {
    for (const bad of [me('owner'), me('workspace-key'), me('other'), me('reader-npub', 'actor', 'other-workspace')]) {
      const s = store(); s.currentWorkspace.pgMe = bad; s.currentWorkspaceActorId = 'owner-actor';
      expect(resolvePgReaderActorId(s)).toBe('');
    }
    const s = store(); s.currentWorkspace.pgSessionNpub = 'other'; expect(resolvePgReaderActorId(s)).toBe('');
    s.session = null; expect(resolvePgReaderActorId(s)).toBe('');
  });
  it('coalesces startup /me hydration, waits before reader operations and recovers after failure', async () => {
    const s = store(); delete s.currentWorkspace.pgMe;
    const pending = gate(), readMe = vi.fn(() => pending.promise);
    const a = ensureFeedReaderIdentity(s, { readMe }), b = ensureFeedReaderIdentity(s, { readMe });
    expect(readMe).toHaveBeenCalledTimes(1); expect(resolvePgReaderActorId(s)).toBe('');
    pending.resolve(me()); await Promise.all([a, b]); expect(resolvePgReaderActorId(s)).toBe('reader-actor');
    const request = vi.fn(async () => ({ subscriptions: [], next_cursor: null }));
    const db = await openWorkspaceDb(`identity-${crypto.randomUUID()}`);
    try { await hydrateFeedReader(s, { request, db, replay: false }); } finally { await db.delete(); }
    expect(request).toHaveBeenCalledOnce();
    delete s.currentWorkspace.pgMe;
    await expect(ensureFeedReaderIdentity(s, { readMe: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
    await ensureFeedReaderIdentity(s, { readMe: async () => me() }); expect(resolvePgReaderActorId(s)).toBe('reader-actor');
  });
  it.each(['signer', 'workspace', 'generation', 'backend'])('discards late /me after %s switch', async kind => {
    const s = store(); delete s.currentWorkspace.pgMe; const pending = gate();
    const result = ensureFeedReaderIdentity(s, { readMe: () => pending.promise });
    if (kind === 'signer') s.session = { npub: 'other' };
    if (kind === 'workspace') s.currentWorkspace = { workspaceId: 'other' };
    if (kind === 'generation') s._workspaceSelectionGeneration++;
    if (kind === 'backend') s.backendUrl = 'https://other.example';
    pending.resolve(me()); await expect(result).rejects.toThrow('feed_disposed'); expect(s.currentWorkspace.pgMe).toBeUndefined();
  });
  it('passes actual reader actor metadata to the record worker snapshot', () => {
    const s = store(); const snapshot = syncManagerMixin.buildTowerPgMaterializationStoreSnapshot.call(s);
    expect(resolvePgReaderActorId(snapshot)).toBe('reader-actor'); expect(snapshot.currentWorkspaceActorId).toBeUndefined();
  });
});
