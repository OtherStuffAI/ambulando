import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceDb, openWorkspaceDb, closeWorkspaceDb } from '../src/db.js';
import { MEMBERSHIP_FULL_REFRESH_MS as DAY, readMembershipDirectory } from '../src/membership-freshness.js';

let db;
afterEach(async () => { vi.useRealTimers(); if (db) await db.delete(); });
function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20'));
  db = createWorkspaceDb(`membership-policy-${crypto.randomUUID()}`);
  const read = vi.fn(async () => ({ members: [{ actor: { id: 'a', npub: 'npub1a', display_name: 'Old' } }] }));
  const options = { workspaceId: 'w', baseUrl: 'http://localhost:3100', appNpub: 'app', family: 'members', read, db };
  return { read, options, load: overrides => readMembershipDirectory({ ...options, ...overrides }) };
}

describe('durable membership full reconciliation', () => {
  it('hydrates cold cache, coalesces callers, survives reopening and becomes due at exactly 24h', async () => {
    const { read, options, load } = fixture();
    await Promise.all([load(), load(), load()]);
    expect(read).toHaveBeenCalledTimes(1);
    db.close(); await db.open();
    vi.setSystemTime(Date.now() + DAY - 1);
    await readMembershipDirectory({ ...options, db });
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await Promise.all([load(), load()]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('merges live names/removals without postponing the full deadline', async () => {
    const { read, load } = fixture();
    await load();
    vi.setSystemTime(Date.now() + DAY - 10);
    read.mockResolvedValue({ members: [] });
    expect(await load({ reason: 'live' })).toEqual({ members: [] });
    expect(await load()).toEqual({ members: [], directory_cache_hit: true });
    expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 10);
    await load(); expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([{ members: [], has_more: true }, { members: [], next_cursor: 'next' }, { members: [], complete: false }, { members: [{}] }, {}])('preserves durable data and freshness after malformed/partial reads %j', async result => {
    const { read, load } = fixture();
    const original = await load();
    const before = await db.sync_state.toArray();
    vi.setSystemTime(Date.now() + DAY);
    read.mockResolvedValue(result);
    await expect(load()).rejects.toThrow('incomplete');
    expect(await db.sync_state.toArray()).toEqual(before);
    expect(await load()).toEqual({ ...original, directory_cache_hit: true });
    expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 30_000);
    read.mockResolvedValue({ members: [] });
    expect(await load()).toEqual({ members: [] });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('isolates backend, app and workspace while an old read is pending', async () => {
    const { read, load } = fixture();
    let finish;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = load();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const current = { members: [{ id: 'b', npub: 'npub1b' }] };
    read.mockResolvedValue(current);
    for (const overrides of [{ workspaceId: 'other' }, { appNpub: 'other' }, { baseUrl: 'http://localhost:3200' }]) {
      expect(await load(overrides)).toEqual(current);
    }
    finish({ members: [] }); await old;
    expect((await db.sync_state.toArray()).length).toBe(4);
  });

  it('rechecks a live hint arriving after an ordinary request took its snapshot', async () => {
    const { read, load } = fixture();
    let finish;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const original = load();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const newest = { members: [{ id: 'new', npub: 'npub1new' }] };
    read.mockResolvedValue(newest);
    const live = load({ reason: 'live' });
    const otherLive = load({ reason: 'live' });
    finish({ members: [] });
    await original;
    expect(await live).toEqual(newest);
    expect(await otherLive).toEqual(newest);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not lose a hint arriving while the follow-up snapshot is in flight', async () => {
    const { read, load } = fixture();
    const finishes = [];
    read.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    const first = load();
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    const live = load({ reason: 'live' });
    finishes[0]({ members: [] }); await first;
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    const newerLive = load({ reason: 'live' });
    finishes[1]({ members: [] });
    await vi.waitFor(() => expect(finishes).toHaveLength(3));
    const newest = { members: [{ id: 'last', npub: 'npub1last' }] };
    finishes[2](newest);
    expect(await live).toEqual(newest);
    expect(await newerLive).toEqual(newest);
  });

  it('retains the captured Dexie handle when selection switches during a network read', async () => {
    const { read, options } = fixture();
    const selectedA = openWorkspaceDb('captured-a-' + crypto.randomUUID()); await selectedA.open();
    let finish;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { db: ignored, ...selectedOptions } = options;
    const pending = readMembershipDirectory(selectedOptions).catch(error => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const selectedB = openWorkspaceDb('captured-b-' + crypto.randomUUID()); await selectedB.open();
    finish({ members: [] }); await pending;
    expect(await selectedB.sync_state.count()).toBe(0);
    closeWorkspaceDb(); await selectedA.delete(); await selectedB.delete();
  });

  it('explicit mutation/manual refresh bypasses freshness but ordinary force does not', async () => {
    const { read, load } = fixture();
    await load(); await load({ force: true }); expect(read).toHaveBeenCalledTimes(1);
    await load({ reason: 'mutation' }); await load({ reason: 'manual' });
    expect(read).toHaveBeenCalledTimes(3);
  });
});
