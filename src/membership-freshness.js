import { getWorkspaceDb, hasWorkspaceDb } from './db.js';

export const MEMBERSHIP_FULL_REFRESH_MS = 24 * 60 * 60 * 1000;
const runs = new Map();
const retries = new Map();
const followups = new Map();

// Only directory GETs use this policy. Dexie remains the rendering source;
// callers run overdue reads in the background without removing cached rows.
export async function readMembershipDirectory({ workspaceId, baseUrl, appNpub, family, reason, read, db = hasWorkspaceDb() ? getWorkspaceDb() : null, now = Date.now }) {
  const key = `membership-directory:${JSON.stringify([baseUrl.replace(/\/+$/, ''), appNpub, workspaceId, family])}`;
  const runKey = `${db?.name || 'unpersisted'}:${key}`;
  const explicit = ['live', 'mutation', 'manual'].includes(reason);
  if (runs.has(runKey)) {
    if (!explicit) return runs.get(runKey);
    // A hint can arrive after the in-flight read took its snapshot. Coalesce
    // those hints into one follow-up rather than losing the newer change.
    const queued = followups.get(runKey);
    if (queued) {
      queued.generation++;
      if (reason !== 'live') queued.reason = reason;
      return queued.promise;
    }
    const state = { generation: 1, reason, promise: null };
    state.promise = (async () => {
      await runs.get(runKey).catch(() => {});
      let result;
      let observed;
      do {
        observed = state.generation;
        result = await readMembershipDirectory({ workspaceId, baseUrl, appNpub, family, reason: state.reason, read, db, now });
      } while (observed !== state.generation);
      return result;
    })().finally(() => followups.delete(runKey));
    followups.set(runKey, state);
    return state.promise;
  }
  const run = (async () => {
    const cached = db ? (await db.sync_state.get(key))?.value : null;
    if (!explicit && cached?.result && now() - cached.fullReconciledAt < MEMBERSHIP_FULL_REFRESH_MS) return { ...cached.result, directory_cache_hit: true };
    const retry = retries.get(runKey);
    if (!explicit && retry && now() < retry.after) {
      if (cached?.result) return { ...cached.result, directory_cache_hit: true };
      throw retry.error;
    }
    try {
      const result = await read();
      if (!Array.isArray(result?.[family]) || result.has_more === true || result.next_cursor || result.complete === false
        || result[family].some(row => !row || (family === 'members' ? !(row.actor?.npub || row.npub) || !(row.actor?.id || row.actor?.actor_id || row.actor_id || row.id) : !(row.id || row.group_id)))) {
        throw new Error(`Workspace ${family} directory is incomplete`);
      }
      // Retain the captured database handle: an old request cannot write to the
      // workspace selected while it was on the network. Closed handles fail safe.
      if (db) await db.sync_state.put({ key, value: {
        result, fullReconciledAt: reason === 'live' ? cached?.fullReconciledAt || 0 : now(),
      } });
      retries.delete(runKey);
      return result;
    } catch (error) {
      retries.set(runKey, { error, after: now() + 30_000 });
      throw error;
    }
  })();
  runs.set(runKey, run);
  try { return await run; }
  finally { if (runs.get(runKey) === run) runs.delete(runKey); }
}
