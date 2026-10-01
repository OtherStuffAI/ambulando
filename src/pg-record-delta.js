import { resolvePgReaderActorId } from './pg-reader-identity.js';
import { inboundFeedReaderRow } from './translators/feed-reader.js';
import { feedContextKey } from './feed/store.js';
import { threadHistoryLineage } from './thread-history-coverage.js';
import Dexie from 'dexie';
import { preserveHydratedDocumentContent } from './document-selection.js';
import { latestTaskActivity, isTaskActivityAuthoredByViewer } from './task-attention-actor.js';
import { getWorkspaceDb, reconcilePgMessageIdentity } from './db.js';
import { sameLogicalValue } from './utils/state-helpers.js';
import {
  resolveTowerPgWorkspaceContext, towerPgSyncCursorKey,
  mapPgScopeToLocal, mapPgChannelToLocal, mapPgThreadToLocal, mapPgMessageToLocal,
  mapPgTaskToLocal, mapPgTaskCommentToLocal, mapPgDocToLocal, mapPgDocCommentToLocal,
  mapPgFileToLocalDocument, mapPgFileFolderToLocal, mapPgAudioNoteToLocal,
  mapPgDailyNoteToLocal, mapPgPersonalWappToLocal,
} from './pg-read-hydrator.js';
import { inboundAutopilotConnection, inboundWorkspaceAgent } from './translators/autopilot-connections.js';

const FAMILY = {
  scope: ['scopes', mapPgScopeToLocal], channel: ['channels', mapPgChannelToLocal],
  thread: ['chat_messages', mapPgThreadToLocal], message: ['chat_messages', mapPgMessageToLocal],
  task: ['tasks', mapPgTaskToLocal], task_comment: ['comments', mapPgTaskCommentToLocal],
  doc: ['documents', mapPgDocToLocal], doc_comment: ['comments', mapPgDocCommentToLocal],
  file: ['documents', mapPgFileToLocalDocument], file_folder: ['file_folders', mapPgFileFolderToLocal],
  audio_note: ['audio_notes', mapPgAudioNoteToLocal], daily_note: ['daily_notes', mapPgDailyNoteToLocal],
  personal_wapp: ['wapps', mapPgPersonalWappToLocal],
  autopilot_connection: ['autopilot_connections', inboundAutopilotConnection],
  workspace_agent: ['workspace_agents', inboundWorkspaceAgent],
  resource_view_state: ['resource_view_states', (row) => ({ ...row, record_id: `${row.resource_type}:${row.resource_id}`, sync_status: 'synced' })],
  feed_subscription: ['feed_subscriptions', row => row],
  feed_item_state: ['feed_item_states', row => row],
};
export const PG_RECORD_DELTA_FAMILIES = [...Object.keys(FAMILY), 'task_assignment'];
const TOWER_WINS_LOCAL_ASSET_CONFLICT_FAMILIES = new Set(['file', 'file_folder']);
export function recordDeltaCursorKey(store) { return `${towerPgSyncCursorKey(store)}:record-delta-v1`; }
const pending = (row) => ['pending', 'failed'].includes(row?.sync_status) || row?.pg_reconciliation_pending === true;
const rawKey = (family, id) => `${family}:${id}`;
export function isTowerWinsLocalAssetConflict(conflict = {}) {
  return TOWER_WINS_LOCAL_ASSET_CONFLICT_FAMILIES.has(String(conflict.family || ''));
}
function validatePage(page, workspaceId) {
  if (page?.protocol_version !== 1 || !['snapshot', 'delta'].includes(page.mode)
    || !Array.isArray(page.families) || !PG_RECORD_DELTA_FAMILIES.filter(f => !f.startsWith('feed_')).every(f => page.families.includes(f))
    || !Array.isArray(page.changes) || page.changes.length > 200
    || typeof page.next_cursor !== 'string' || !page.next_cursor || typeof page.has_more !== 'boolean') {
    throw new Error('Invalid Tower record-delta v1 page');
  }
  const { local_apply_options, ...wirePage } = page;
  if (page.actors !== undefined && (!Array.isArray(page.actors) || page.changes.length + page.actors.length > 200)) throw new Error('Invalid record-delta actor bound');
  const actorIds = new Set();
  for (const actor of page.actors || []) {
    if (!actor?.actor_id || actorIds.has(actor.actor_id) || typeof actor.npub !== 'string' || !['human','agent','app','service'].includes(actor.kind) || !(actor.display_name === null || typeof actor.display_name === 'string')) throw new Error('Invalid record-delta actor identity');
    actorIds.add(actor.actor_id);
  }
  if (new TextEncoder().encode(JSON.stringify(wirePage)).byteLength > 1048576) throw new Error('Record-delta page exceeds byte bound');
  for (const c of page.changes) {
    if (!PG_RECORD_DELTA_FAMILIES.includes(c.family) || typeof c.id !== 'string' || !c.id
      || c.workspace_id !== workspaceId || !/^\d+$/.test(c.version)
      || !['upsert', 'delete'].includes(c.operation)
      || (c.operation === 'upsert' ? !c.row || c.row.workspace_id !== workspaceId
        || !['task_assignment', 'resource_view_state'].includes(c.family) && c.row.id !== c.id : c.row !== null)) {
      throw new Error('Invalid Tower record-delta change');
    }
  }
}

// Called inside the page transaction. A deleted latest row uses one predecessor
// lookup, irrespective of channel history size. Summary is viewer-independent;
// read cursors/view-state remain separate viewer-specific authority.
export async function refreshChannelSummaries(db, channelIds) {
  for (const channelId of new Set(channelIds.filter(Boolean))) {
    const latest = await db.chat_messages.where('[channel_id+cache_active+cache_time+record_id]')
      .between([channelId, 1, Dexie.minKey, Dexie.minKey], [channelId, 1, '\uffff', Dexie.maxKey])
      .reverse().first();
    const summary = { channel_id: channelId, latest_at: latest?.updated_at || null, latest_id: latest?.record_id || null };
    if (!sameLogicalValue(await db.channel_summaries.get(channelId), summary)) await db.channel_summaries.put(summary);
  }
}

async function updateResourceAttention(db, resourceType, id, store, members, cache = null) {
  const family = resourceType === 'document' ? 'doc' : resourceType;
  const raw = cache ? cache.raw.get(rawKey(family, id)) : await db.pg_record_rows.get(rawKey(family, id));
  const recordId = `${resourceType}:${id}`;
  const view = cache ? cache.views.get(recordId) : await db.resource_view_states.get(recordId);
  const activity = Number(raw?.row?.activity_version || 0);
  let unread = Boolean(raw?.operation === 'upsert' && !raw.row.deleted_at && !raw.row.archived_at
    && activity > Number(view?.viewed_activity_version || 0));
  if (unread && resourceType === 'task') {
    const task = cache ? cache.tasks.get(id) : await db.tasks.get(id);
    const comments = await db.comments.where('[target_record_id+cache_active+cache_time+record_id]')
      .between([id, 1, Dexie.minKey, Dexie.minKey], [id, 1, '\uffff', Dexie.maxKey])
      .reverse().limit(1).toArray();
    const latest = task ? latestTaskActivity(task, comments) : null;
    unread = Boolean(task && Number(task.activity_version || 0) >= activity && latest
      && !isTaskActivityAuthoredByViewer(latest.row, { kind: latest.kind, viewState: view,
        viewerActorId: store.currentPgActorId, viewerNpub: store.currentViewerNpub || store.session?.npub,
        workspaceMembers: members }));
  }
  const next = { record_id: recordId, resource_type: resourceType, resource_id: id,
    channel_id: raw?.channel_id || view?.channel_id || null, unread: unread ? 1 : 0,
    activity_version: activity, viewed_activity_version: Number(view?.viewed_activity_version || 0) };
  const prior = cache ? cache.attention.get(recordId) : await db.pg_resource_attention.get(recordId);
  if (sameLogicalValue(prior, next)) return;
  const section = resourceType === 'thread' ? 'chat' : resourceType === 'task' ? 'tasks' : 'docs';
  const adjustments = new Map();
  for (const [row, sign] of [[prior, -1], [next, 1]]) {
    if (!row?.unread) continue;
    for (const key of [`section:${section}`, ...(row.channel_id ? [`channel:${row.channel_id}`] : [])]) {
      adjustments.set(key, (adjustments.get(key) || 0) + sign);
    }
  }
  for (const [key, delta] of adjustments) {
    if (!delta) continue;
    const current = cache ? cache.counts.get(key) : await db.pg_attention_counts.get(key);
    const nextCount = { key, count: Math.max(0, Number(current?.count || 0) + delta) };
    if (cache) cache.counts.set(key, nextCount);
    await db.pg_attention_counts.put(nextCount);
  }
  await db.pg_resource_attention.put(next);
  if (view && view.activity_version !== activity) await db.resource_view_states.update(recordId, { activity_version: activity });
}

// Batch the shared projection reads within the bounded transaction. Counts
// still update sequentially so two resources cannot lose a shared increment.
async function updateResourceAttentions(db, resources, store, members) {
  if (!resources.length) return;
  const ids = resources.map(([type, id]) => `${type}:${id}`);
  const rawIds = resources.map(([type, id]) => rawKey(type === 'document' ? 'doc' : type, id));
  const [raw, views, attention, tasks] = await Promise.all([
    db.pg_record_rows.bulkGet(rawIds), db.resource_view_states.bulkGet(ids),
    db.pg_resource_attention.bulkGet(ids), db.tasks.bulkGet(resources.filter(([type]) => type === 'task').map(([,id]) => id)),
  ]);
  const countKeys = [...new Set([...raw, ...views, ...attention].filter(Boolean).flatMap(row =>
    row.channel_id ? [`channel:${row.channel_id}`] : []))];
  countKeys.push('section:chat', 'section:tasks', 'section:docs');
  const counts = await db.pg_attention_counts.bulkGet(countKeys);
  const byKey = (rows, key) => new Map(rows.filter(Boolean).map(row => [row[key], row]));
  const cache = { raw: byKey(raw, 'key'), views: byKey(views, 'record_id'), attention: byKey(attention, 'record_id'),
    tasks: byKey(tasks, 'record_id'), counts: byKey(counts, 'key') };
  for (const [type, id] of resources) await updateResourceAttention(db, type, id, store, members, cache);
}

export async function getPgAttentionProjection(store) {
  const db = getWorkspaceDb();
  const authority = (await db.sync_state.get(recordDeltaCursorKey(store)))?.value;
  if (!authority || authority.legacyFallbackActive === true) return null;
  const ids = [...new Set([
    ...(store.tasks || []).map(r => `task:${r.record_id}`),
    ...(store.messages || []).map(r => `thread:${r.pg_thread_id || r.record_id}`),
    ...(store.documents || []).map(r => `document:${r.record_id}`),
  ])];
  const [counts, visible, conflicts] = await Promise.all([db.pg_attention_counts.toArray(), db.pg_resource_attention.bulkGet(ids), db.pg_record_conflicts.toArray()]);
  const assetConflicts = conflicts.filter(isTowerWinsLocalAssetConflict);
  const recordConflicts = conflicts.filter(conflict => !isTowerWinsLocalAssetConflict(conflict));
  const values = Object.fromEntries(counts.map(r => [r.key, r.count]));
  return {
    values,
    visible: visible.filter(Boolean),
    conflictCount: recordConflicts.length,
    conflicts: recordConflicts.slice(0, 20),
    avatarSyncConflictCount: assetConflicts.length,
    avatarSyncConflicts: assetConflicts.slice(0, 20),
  };
}

export async function applyPgRecordChanges(store, page, options = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  validatePage(page, context.workspaceId);
  if (page.identity?.workspace_id && page.identity.workspace_id !== context.workspaceId) throw new Error('Record-delta workspace identity mismatch');
  // Validate the complete wire boundary before any prefix becomes visible.
  if (page.mode === 'snapshot' && (!page.snapshot_id || typeof page.snapshot_complete !== 'boolean'
    || !page.has_more || page.snapshot_complete && (!Array.isArray(page.partitions_complete)
      || !page.families.every(f => page.partitions_complete.includes(f))))) throw new Error('Invalid snapshot completion boundary');
  if (page.mode === 'delta' && page.snapshot_id) throw new Error('Invalid delta handover identity');
  // Subpage checkpoints retain the server cursor until the entire page commits.
  // A crash replays that opaque page; canonical versions make the committed
  // prefix idempotent. No cursor can skip unapplied changes.
  let result, applied = 0;
  const size = options.reconcileOnly ? 200 : 32;
  for (let offset = 0; offset < Math.max(1, page.changes.length); offset += size) {
    const partial = offset + size < page.changes.length;
    result = await applyRecordPage(store, { ...page, changes: page.changes.slice(offset, offset + size),
      actors: offset === 0 ? page.actors : [],
      snapshot_complete: partial ? false : page.snapshot_complete,
      has_more: partial ? true : page.has_more },
    { ...options, partialPage: partial, pageOffset: offset + size,
      beforeCommit: partial ? undefined : options.beforeCommit });
    applied += result.applied;
    if (result.replay) break;
    if (partial) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!result.retirementPending) return { ...result, applied };
  await retireSnapshotOmissions(store, { ...options, expectedGeneration: result.localGeneration, terminalCursor: page.next_cursor });
  return { ...result, applied, cursor: page.next_cursor, retirementPending: false };
}

async function applyRecordPage(store, page, options = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  validatePage(page, context.workspaceId);
  if (page.identity?.workspace_id && page.identity.workspace_id !== context.workspaceId) throw new Error('Record-delta workspace identity mismatch');
  const db = getWorkspaceDb();
  const cursorKey = recordDeltaCursorKey(store);
  return db.transaction('rw', db.tables, async () => {
    const state = (await db.sync_state.get(cursorKey))?.value || { cursor: null };
    if (Object.hasOwn(options, 'expectedGeneration') && Number(state.localGeneration || 0) !== options.expectedGeneration) throw new Error('Record-delta authority generation changed before page commit');
    if (Object.hasOwn(options, 'expectedCursor') && state.cursor !== options.expectedCursor) {
      if (state.cursor === page.next_cursor) return { applied: 0, cursor: state.cursor, hasMore: page.has_more, replay: true };
      throw new Error('Record-delta cursor changed before page commit');
    }
    if (page.mode === 'snapshot' && state.snapshotId && page.snapshot_id !== state.snapshotId) {
      throw new Error('Record-delta snapshot generation changed without reset');
    }
    // Every bounded page is already authorized by Tower. Publish its upserts
    // and download cursor together; retain unseen cached rows until handover.
    // Older private staging is reset by the service before negotiation resumes.
    if (state.staging) throw new Error('Legacy snapshot staging requires preserved-view recovery');
    if (page.mode === 'snapshot' && (!page.snapshot_id || typeof page.snapshot_complete !== 'boolean'
      || !page.has_more || page.snapshot_complete && (!Array.isArray(page.partitions_complete)
        || !page.families.every(f => page.partitions_complete.includes(f))))) throw new Error('Invalid snapshot completion boundary');
    if (page.mode === 'delta' && state.snapshotReconciliationPending && !state.snapshotComplete) throw new Error('Incomplete snapshot handover');
    if (page.mode === 'delta' && page.snapshot_id) throw new Error('Invalid delta handover identity');
    const generation = page.mode === 'snapshot' ? `${page.snapshot_id}:${Number(state.localGeneration || 0)}` : state.generation || 'delta';
    if (page.actors?.length) await db.pg_actors.bulkPut(page.actors.map(actor => ({ ...actor, generation })));
    const referencedActors = [...new Set(page.changes.flatMap(c => c.operation === 'upsert'
      ? ['created_by_actor_id','updated_by_actor_id','deleted_by_actor_id','owner_actor_id','actor_id','viewer_actor_id'].map(key => c.row?.[key]).filter(Boolean) : []))];
    const sidecarActors = (await db.pg_actors.bulkGet(referencedActors)).filter(Boolean);
    const members = [...(await db.workspace_members.bulkGet(referencedActors)).filter(Boolean), ...sidecarActors];
    const actorNpubByActorId = new Map(members.map(m => [m.actor_id || m.id, m.npub]));
    const mapOptions = { workspaceOwnerNpub: context.workspaceOwnerNpub, actorNpubByActorId };
    const intentIds = [...new Set(page.changes.flatMap(c => [c.id, c.row?.metadata?.client_record_id, c.row?.source_message_id, c.row?.task_id]).filter(Boolean))];
    const commandRows = intentIds.length ? await db.pending_writes.where('record_id').anyOf(intentIds).toArray() : [];
    const commandIds = new Set(commandRows.map(row => row.record_id));
    const checkedIntentIds = new Set(intentIds);
    const hasCommands = async id => {
      if (!checkedIntentIds.has(id)) {
        if (await db.pending_writes.where('record_id').equals(id).count()) commandIds.add(id);
        checkedIntentIds.add(id);
      }
      return commandIds.has(id);
    };
    const changedKeys = new Set();
    const affectedTasks = new Set();
    const affectedChannels = new Set();
    const affectedResources = new Map();
    let applied = 0;
    // Store canonical records first: dependencies within a page are independent
    // of wire order. Retained deletion versions prevent stale resurrection.
    const existing = await db.pg_record_rows.bulkGet(page.changes.map(c => rawKey(c.family, c.id)));
    const versions = new Map(existing.filter(Boolean).map(row => [row.key, row]));
    for (const c of page.changes) {
      const key = rawKey(c.family, c.id);
      const prior = versions.get(key);
      if (prior && prior.generation === generation && BigInt(prior.version) >= BigInt(c.version) && !(options.reconcileKeys || []).includes(key)) continue;
      if (page.mode !== 'snapshot' && prior && BigInt(prior.version) > BigInt(c.version)) continue;
      const raw = { ...c, key, generation, parent_id: c.row?.task_id || c.row?.thread_id || prior?.parent_id || null, source_message_id: c.row?.source_message_id || prior?.source_message_id || prior?.row?.source_message_id || null };
      versions.set(key, raw); changedKeys.add(key);
      if (c.family === 'task_assignment') affectedTasks.add(raw.parent_id || c.id.split(':')[0]);
      if (c.family === 'task') affectedTasks.add(c.id);
      if (['task', 'thread', 'doc'].includes(c.family)) affectedResources.set(`${c.family}:${c.id}`, [c.family === 'doc' ? 'document' : c.family, c.id]);
      if (c.family === 'task_comment' && raw.parent_id) affectedResources.set(`task:${raw.parent_id}`, ['task', raw.parent_id]);
      if (c.family === 'resource_view_state') {
        const parts = c.id.split(':');
        const type = c.row?.resource_type || parts[1];
        const id = c.row?.resource_id || parts.slice(2).join(':');
        affectedResources.set(`${type}:${id}`, [type, id]);
      }
      if (['message', 'thread'].includes(c.family)) {
        affectedChannels.add(c.channel_id); affectedChannels.add(prior?.channel_id);
      }
    }
    if (changedKeys.size) await db.pg_record_rows.bulkPut([...changedKeys].map(key => versions.get(key)));
    const materialize = async (raw) => {
      if (!FAMILY[raw.family]) return;
      const [tableName, mapRow] = FAMILY[raw.family];
      const table = db.table(tableName);
      let localId = raw.id;
      if (raw.family === 'resource_view_state') localId = raw.row
        ? `${raw.row.resource_type}:${raw.row.resource_id}` : raw.id.split(':').slice(1).join(':');
      if (raw.family === 'feed_subscription' || raw.family === 'feed_item_state') {
        const reader = { ...context, readerActorId: resolvePgReaderActorId(store) };
        if (!reader.readerActorId) throw new Error('reader_identity_required');
        if (raw.operation === 'delete') {
          await table.where('context').equals(feedContextKey(reader)).filter(r => r.id === raw.id).delete();
        } else {
          const mapped = inboundFeedReaderRow(raw.row, reader, raw.family === 'feed_item_state');
          const prior = await table.get(mapped.key);
          if (!prior || prior.row_version <= mapped.row_version) await table.put({ ...mapped, pg_delta_generation: generation, pg_delta_family: raw.family });
        }
        applied++; return;
      }
      const prior = await table.get(localId);
      // Read receipts are monotonic watermarks, not competing content edits.
      // Keep an ahead local receipt pending so reconnect can still send it.
      if (raw.family === 'resource_view_state') {
        if (raw.operation === 'delete' || raw.row?.deleted_at) {
          if (prior) { await table.delete(localId); applied++; }
        } else {
          const localViewed = Number(prior?.viewed_activity_version || 0);
          const sharedViewed = Number(raw.row.viewed_activity_version || 0);
          const mapped = {
            ...prior, ...mapRow(raw.row),
            scope_id: raw.row.scope_id || prior?.scope_id || null,
            channel_id: raw.row.channel_id || prior?.channel_id || null,
            viewed_activity_version: Math.max(localViewed, sharedViewed),
            sync_status: localViewed > sharedViewed ? 'pending' : 'synced',
            pg_reconciliation_pending: false, pg_sync_conflict: false,
            pg_delta_generation: generation, pg_delta_family: raw.family,
          };
          if (!sameLogicalValue(prior, mapped)) { await table.put(mapped); applied++; }
        }
        await db.pg_record_conflicts.delete(raw.key);
        return;
      }
      const clientRecordId = raw.row?.metadata?.client_record_id;
      if (clientRecordId && clientRecordId !== localId) {
        const optimistic = await table.get(clientRecordId);
        if (optimistic && ((await hasCommands(clientRecordId))
          || Number(optimistic.version || 0) > Number(raw.row?.row_version || 0))) {
          await db.pg_record_conflicts.put({ key: raw.key, family: raw.family, record_id: clientRecordId, local: optimistic, remote: raw, reason: 'unresolved_local_command' });
          await table.update(clientRecordId, { pg_sync_conflict: true });
          return;
        }
      }
      const commands = await hasCommands(localId);
      const acknowledgedClientId = raw.row?.metadata?.client_record_id;
      const acknowledgesOptimistic = Boolean(acknowledgedClientId && prior?.pg_reconciliation_pending
        && [prior.record_id, prior.pg_client_record_id].includes(acknowledgedClientId));
      if (commands || (pending(prior) && !acknowledgesOptimistic)) {
        await db.pg_record_conflicts.put({ key: raw.key, family: raw.family, record_id: localId, local: prior || null, remote: raw, reason: 'unresolved_local_command' });
        if (prior) {
          if (raw.operation === 'delete' || raw.row?.deleted_at) await table.delete(localId);
          else await table.update(localId, { pg_sync_conflict: true, pg_delta_generation: generation, pg_delta_family: raw.family });
        }
        return;
      }
      if (raw.operation === 'delete' || raw.row?.deleted_at
        || (['autopilot_connection', 'workspace_agent'].includes(raw.family) && raw.row?.archived_at)) {
        if (raw.family === 'thread' && (raw.source_message_id || prior?.pg_source_message_id)) {
          const source = await db.chat_messages.get(raw.source_message_id || prior.pg_source_message_id);
          if (source && !pending(source) && !(await hasCommands(source.record_id))) await db.chat_messages.delete(source.record_id);
        }
        if (prior) { await table.delete(localId); applied++; }
        return;
      }
      if (Number(prior?.version || 0) > Number(raw.row?.row_version || raw.row?.version || 0)) {
        // A newer local version is still present in the authorized snapshot.
        await table.update(localId, { pg_delta_generation: generation, pg_delta_family: raw.family });
        return;
      }
      // Canonical PG JSON uses +00:00 timestamps; all local chronology indexes
      // use normalized UTC ISO milliseconds, identical to legacy transport rows.
      let canonical = Object.fromEntries(Object.entries(raw.row).map(([key, value]) => [key,
        key.endsWith('_at') && typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value]));
      let extra = mapOptions;
      if (raw.family === 'message') {
        const thread = canonical.thread_id ? await db.pg_record_rows.get(rawKey('thread', canonical.thread_id)) : null;
        extra = { ...mapOptions, threadById: new Map(thread?.row ? [[canonical.thread_id, thread.row]] : []) };
      }
      if (raw.family === 'task') {
        const assignments = await db.pg_record_rows.where('[family+parent_id]').equals(['task_assignment', raw.id]).toArray();
        canonical = { ...canonical, assignments: assignments.filter(a => a.operation === 'upsert' && !a.row.deleted_at).map(a => a.row) };
      }
      // Dependent rematerialization may reference identities introduced on an
      // earlier page (for example another task assignee or a thread source).
      const actorIds = [...new Set([canonical, ...(canonical.assignments || [])].flatMap(row =>
        ['created_by_actor_id','updated_by_actor_id','owner_actor_id','actor_id','viewer_actor_id'].map(key => row[key]).filter(Boolean)))];
      const missingActors = actorIds.filter(id => !actorNpubByActorId.has(id));
      if (missingActors.length) {
        const identities = [...(await db.workspace_members.bulkGet(missingActors)).filter(Boolean), ...(await db.pg_actors.bulkGet(missingActors)).filter(Boolean)];
        for (const actor of identities) actorNpubByActorId.set(actor.actor_id, actor.npub);
      }
      const rowActors = actorNpubByActorId;
      let mapped = mapRow(canonical, { ...extra, actorNpubByActorId: rowActors });
      if (raw.family === 'thread' && prior?.pg_effective_message_ids
        && threadHistoryLineage(prior) === threadHistoryLineage(mapped)) {
        mapped.pg_effective_message_ids = prior.pg_effective_message_ids;
      }
      if (raw.family === 'resource_view_state' && prior) mapped.viewed_activity_version = Math.max(Number(prior.viewed_activity_version || 0), Number(mapped.viewed_activity_version || 0));
      mapped = { ...mapped, pg_delta_generation: generation, pg_delta_family: raw.family };
      // Preserve separately hydrated document bytes, absent from canonical PG rows.
      if (raw.family === 'doc' && prior && mapped.content_storage_object_id
        && mapped.content_storage_object_id === prior.content_storage_object_id
        && (!mapped.content_sha256_hex || !prior.content_sha256_hex || mapped.content_sha256_hex === prior.content_sha256_hex)) {
        const canonicalVersionId = mapped.pg_canonical_version_id;
        mapped = preserveHydratedDocumentContent({ ...prior, version: mapped.version }, mapped);
        mapped.pg_canonical_version_id = canonicalVersionId;
      }
      if (raw.family === 'thread' && canonical.source_message_id && !Array.isArray(mapped.pg_effective_message_ids)) {
        const source = await db.chat_messages.get(canonical.source_message_id);
        // Typed reads and POST acknowledgements may have the source before
        // the canonical journal does. Do not render a second title-only root.
        if (source?.pg_record_type === 'message' && source.channel_id === canonical.channel_id
          && source.pg_thread_id === raw.id && !source.parent_message_id
          && source.record_state !== 'deleted') {
          if (prior && !pending(prior)) await table.delete(localId);
          await db.pg_record_conflicts.delete(raw.key);
          return;
        }
      }
      const clientId = mapped.pg_client_record_id || canonical.metadata?.client_record_id;
      if (clientId && clientId !== localId) {
        const optimistic = await table.get(clientId);
        const pendingCommands = await hasCommands(clientId);
        if (optimistic && !pendingCommands) await table.delete(clientId);
      }
      if (!sameLogicalValue(prior, { ...prior, ...mapped })) { await table.put(mapped); applied++; }
      if (raw.family === 'message') await reconcilePgMessageIdentity(db, mapped, clientId);
      if (raw.family === 'message' && canonical.thread_id && !mapped.parent_message_id) {
        const placeholder = await db.chat_messages.get(canonical.thread_id);
        if (placeholder?.pg_record_type === 'thread' && !Array.isArray(placeholder.pg_effective_message_ids) && !pending(placeholder)) await db.chat_messages.delete(canonical.thread_id);
      }
      await db.pg_record_conflicts.delete(raw.key);
    };
    for (const key of changedKeys) await materialize(versions.get(key));
    for (const id of affectedTasks) {
      const key = rawKey('task', id);
      if (!changedKeys.has(key)) { const raw = await db.pg_record_rows.get(key); if (raw) await materialize(raw); }
    }
    // A thread update affects its source presentation only, not every reply.
    for (const key of changedKeys) {
      const raw = versions.get(key);
      if (raw.family === 'thread' && raw.row?.source_message_id) {
        const source = await db.pg_record_rows.get(rawKey('message', raw.row.source_message_id));
        if (source && source.operation === 'upsert') {
          await materialize(source);
          const history = await db.chat_messages.get(raw.id);
          if (!Array.isArray(history?.pg_effective_message_ids)) await db.chat_messages.delete(raw.id);
        }
      }
    }
    await refreshChannelSummaries(db, [...affectedChannels]);
    await updateResourceAttentions(db, [...affectedResources.values()], store, members);
    // Retirement checkpoints commit in separate bounded transactions. The
    // terminal cursor remains at the preceding page until all omissions commit.
    const retirementPending = !options.reconcileOnly && state.snapshotComplete
      && state.snapshotReconciliationPending === true && page.mode === 'delta' && !page.has_more;
    if (options.beforeCommit) await options.beforeCommit();
    const nextState = { ...state, viewBaselineInitialized: options.viewBaselineInitialized || state.viewBaselineInitialized || false, legacyFallbackActive: false, resetting: false, cursor: retirementPending || options.partialPage ? state.cursor : page.next_cursor, applyingPage: options.partialPage ? { nextCursor: page.next_cursor, through: options.pageOffset } : null, generation, incrementalSnapshot: true, snapshotRetirement: retirementPending ? state.snapshotRetirement || { tableIndex: 0, after: null, nextCursor: page.next_cursor } : null, snapshotId: page.mode === 'snapshot' ? page.snapshot_id : state.snapshotId,
      snapshotComplete: page.snapshot_complete || state.snapshotComplete || false,
      snapshotReconciliationPending: page.mode === 'snapshot' ? true
        : (page.has_more || retirementPending) ? state.snapshotReconciliationPending === true : false,
      converged: page.mode === 'delta' && !page.has_more && !retirementPending };
    if (!options.reconcileOnly) await db.sync_state.put({ key: cursorKey, value: nextState });
    return { applied, localGeneration: Number(state.localGeneration || 0), cursor: page.next_cursor, retirementPending, hasMore: page.has_more, fullSnapshot: page.mode === 'snapshot', protocolVersion: 1, needsSummaryBackfill: Boolean(state.snapshotComplete && !state.summariesRebuilt && page.mode === 'delta' && !page.has_more) };
  });
}

// A resumable omission walk. Only a completed snapshot plus terminal handover
// authorizes it; ordinary deltas never enter this path. A reset invalidates each
// checkpoint through the same authority generation compare-and-swap as pages.
async function retireSnapshotOmissions(store, options) {
  const db = getWorkspaceDb(), cursorKey = recordDeltaCursorKey(store);
  const tables = [...new Set(Object.values(FAMILY).map(([name]) => name)), 'pg_record_rows', 'pg_actors', 'pg_resource_attention', 'pg_attention_counts'];
  while (true) {
    const done = await db.transaction('rw', db.tables, async () => {
      const state = (await db.sync_state.get(cursorKey))?.value;
      if (Object.hasOwn(options, 'expectedGeneration') && Number(state?.localGeneration || 0) !== options.expectedGeneration)
        throw new Error('Record-delta authority generation changed during retirement');
      const checkpoint = state?.snapshotRetirement;
      if (!checkpoint || checkpoint.nextCursor !== options.terminalCursor) throw new Error('Record-delta retirement authority changed');
      const tableName = tables[checkpoint.tableIndex];
      if (!tableName) {
        await db.sync_state.put({ key: cursorKey, value: { ...state, cursor: checkpoint.nextCursor,
          snapshotRetirement: null, snapshotReconciliationPending: false, converged: true } });
        return true;
      }
      const table = db.table(tableName);
      const rows = await (checkpoint.after ? table.where(':id').above(checkpoint.after) : table.toCollection()).limit(32).toArray();
      const channels = new Set();
      const obsolete = [];
      for (const row of rows) {
        if (tableName === 'pg_resource_attention') {
          const family = row.resource_type === 'document' ? 'doc' : row.resource_type;
          const canonical = await db.pg_record_rows.get(rawKey(family, row.resource_id));
          if (!canonical || canonical.generation !== state.generation) {
            await updateResourceAttention(db, row.resource_type, row.resource_id, store, []);
            obsolete.push(row.record_id);
          }
          continue;
        }
        if (tableName === 'pg_attention_counts') {
          if (!row.count) obsolete.push(row.key);
          continue;
        }
        const canonicalTable = ['pg_record_rows', 'pg_actors'].includes(tableName);
        if (canonicalTable) {
          if (row.generation !== state.generation) obsolete.push(row.key || row.actor_id);
          continue;
        }
        if (!(row.pg_backend || row.pg_delta_family || tableName === 'resource_view_states')
          || row.pg_delta_generation === state.generation) continue;
        const family = row.pg_delta_family || row.pg_record_type || Object.keys(FAMILY).find(f => FAMILY[f][0] === tableName);
        const canonical = await db.pg_record_rows.get(rawKey(family, row.record_id));
        // Typed reads may replace presentation metadata. Canonical membership
        // remains authoritative, as does a newer targeted read in this snapshot.
        if (canonical?.generation === state.generation && canonical.operation === 'upsert' && !canonical.row?.deleted_at) continue;
        const hasIntent = pending(row) || await db.pending_writes.where('record_id').equals(row.record_id).count();
        if (hasIntent) {
          if (!row.pg_delta_family && !canonical) continue; // unacknowledged local creation
          await db.pg_record_conflicts.put({ key: `reset:${tableName}:${row.record_id}`, family: tableName,
            record_id: row.record_id, local: row, reason: 'authority_reset' });
        }
        obsolete.push(tableName.startsWith('feed_') ? row.key : row.record_id);
        if (tableName === 'chat_messages') channels.add(row.channel_id);
      }
      if (obsolete.length) await table.bulkDelete(obsolete);
      if (tableName === 'pg_record_rows') {
        for (const row of rows.filter(r => obsolete.includes(r.key))) {
          if (['task', 'thread', 'doc'].includes(row.family)) {
            const type = row.family === 'doc' ? 'document' : row.family;
            await updateResourceAttention(db, type, row.id, store, []);
            await db.pg_resource_attention.delete(`${type}:${row.id}`);
          }
        }
      }
      await refreshChannelSummaries(db, [...channels]);
      await db.sync_state.put({ key: cursorKey, value: { ...state, snapshotRetirement: {
        ...checkpoint, tableIndex: rows.length ? checkpoint.tableIndex : checkpoint.tableIndex + 1,
        after: rows.length ? (rows.at(-1).key || rows.at(-1).actor_id || rows.at(-1).record_id) : null,
      } } });
      return false;
    });
    if (done) return;
    options.onRetirementProgress?.();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

export async function resetPgRecordAuthority(store, { preserveViews = false, expectedCursor, expectedGeneration } = {}) {
  const db = getWorkspaceDb();
  const cursorKey = recordDeltaCursorKey(store);
  // Cursor expiry/epoch changes invalidate the download, not cached visibility.
  // Definitive revocation hides authority and retains recoverable local intent.
  return db.transaction('rw', db.tables, async () => {
    const priorState = (await db.sync_state.get(cursorKey))?.value;
    if (expectedGeneration !== undefined && Number(priorState?.localGeneration || 0) !== expectedGeneration
      || expectedCursor !== undefined && (priorState?.cursor || null) !== expectedCursor) throw new Error('Record-delta authority changed before reset');
    const localGeneration = Number(priorState?.localGeneration || 0) + 1;
    const prefix = `${cursorKey}:staged:`;
    await db.sync_state.where('key').between(prefix, `${prefix}\uffff`, true, true).delete();
    if (preserveViews) {
      await db.sync_state.delete(`${cursorKey}:summary-backfill`);
      await db.sync_state.put({ key: cursorKey, value: { cursor: null, resetting: true, localGeneration } });
      return { localGeneration };
    }
    for (const tableName of new Set(Object.values(FAMILY).map(([name]) => name))) {
      const table = db.table(tableName);
      let after = null;
      while (true) {
        const rows = await (after ? table.where(':id').above(after) : table.toCollection()).limit(200).toArray();
        if (!rows.length) break;
        after = rows.at(-1).record_id;
        for (const row of rows) {
          if (pending(row) || await db.pending_writes.where('record_id').equals(row.record_id).count()) {
            await db.pg_record_conflicts.put({ key: `reset:${tableName}:${row.record_id}`, family: tableName, record_id: row.record_id, local: row, reason: 'authority_reset' });
          }
        }
      }
      await table.clear();
    }
    await db.sync_state.where('key').between('thread-history-page:', 'thread-history-page:\uffff', true, true).delete();
    await db.pg_record_rows.clear(); await db.channel_summaries.clear(); await db.pg_actors.clear();
    await db.pg_resource_attention.clear(); await db.pg_attention_counts.clear();
    await db.workspace_members.clear(); await db.groups.clear();
    await db.sync_state.put({ key: cursorKey, value: { cursor: null, resetting: true, localGeneration } });
    await db.sync_state.delete(`${cursorKey}:summary-backfill`);
    return { localGeneration };
  });
}

// Reapply a previously withheld acknowledgement as soon as its local command
// finishes. No unrelated server event or cursor reset is required.
export async function reconcilePgRecordConflicts(store, { acceptRemoteKey = null } = {}) {
  let after = null, applied = 0;
  do {
    const result = await reconcileConflictBatch(store, { acceptRemoteKey, after });
    applied += result.applied;
    after = result.nextAfter;
    if (after) await new Promise(resolve => setTimeout(resolve, 0));
  } while (after && !acceptRemoteKey);
  return { applied };
}

async function reconcileConflictBatch(store, { acceptRemoteKey = null, after = null } = {}) {
  const db = getWorkspaceDb();
  return db.transaction('rw', db.tables, async () => {
    const state = (await db.sync_state.get(recordDeltaCursorKey(store)))?.value;
    if (!state?.cursor) return { applied: 0 };
    const conflicts = acceptRemoteKey ? [await db.pg_record_conflicts.get(acceptRemoteKey)].filter(Boolean)
      : await (after ? db.pg_record_conflicts.where(':id').above(after) : db.pg_record_conflicts.toCollection()).limit(200).toArray();
    const changes = [];
    for (const conflict of conflicts) {
      const raw = await db.pg_record_rows.get(conflict.key);
      if (!raw || !FAMILY[raw.family]) continue;
      const table = db.table(FAMILY[raw.family][0]);
      if (raw.family === 'resource_view_state') {
        changes.push(raw);
        continue;
      }
      const local = await table.get(conflict.record_id) || await table.get(raw.id);
      const commands = await db.pending_writes.where('record_id').equals(conflict.record_id).toArray();
      if (acceptRemoteKey || isTowerWinsLocalAssetConflict(conflict)) {
        await db.pg_command_recovery.put({ key: conflict.key, record_id: conflict.record_id, local: local || conflict.local, commands, resolved_at: new Date().toISOString() });
        if (commands.length) await db.pending_writes.bulkDelete(commands.map(c=>c.row_id));
        if (local) await table.delete(local.record_id);
      } else {
        if (commands.length || !local || local.sync_status !== 'synced') continue;
        if (Number(local.version || 0) > Number(raw.row?.row_version || 0) && raw.operation === 'upsert') {
          await db.pg_record_conflicts.delete(conflict.key);
          await table.update(local.record_id, { pg_sync_conflict: false });
          continue;
        }
        await table.update(local.record_id, { pg_reconciliation_pending: false, pg_sync_conflict: false });
      }
      changes.push(raw);
    }
    const nextAfter = conflicts.length === 200 ? conflicts.at(-1).key : null;
    if (!changes.length) return { applied: 0, nextAfter };
    const result = await applyPgRecordChanges(store, { protocol_version: 1, families: PG_RECORD_DELTA_FAMILIES,
      mode: 'delta', changes, next_cursor: state.cursor, has_more: false, snapshot_id: null,
      snapshot_complete: false, partitions_complete: [] },
    { expectedCursor: state.cursor, reconcileOnly: true, reconcileKeys: changes.map(c=>c.key) });
    return { ...result, nextAfter };
  });
}

export async function rebuildPgRecordSummaries(store, { batchSize = 32 } = {}) {
  const db = getWorkspaceDb(), key = `${recordDeltaCursorKey(store)}:summary-backfill`;
  let after = (await db.sync_state.get(key))?.value?.after || null;
  let processed = 0;
  while (true) {
    let count = 0;
    await db.transaction('rw', db.tables, async () => {
      const rows = await (after ? db.pg_record_rows.where(':id').above(after) : db.pg_record_rows.toCollection()).limit(Math.min(32,batchSize)).toArray();
      count = rows.length;
      const members = await db.workspace_members.toArray();
      await updateResourceAttentions(db, rows.filter(raw => ['task','thread','doc'].includes(raw.family))
        .map(raw => [raw.family === 'doc' ? 'document' : raw.family, raw.id]), store, members);
      await refreshChannelSummaries(db,rows.filter(r=>['thread','message'].includes(r.family)).map(r=>r.channel_id));
      if (rows.length) after=rows.at(-1).key;
      await db.sync_state.put({key,value:{after,complete:!rows.length}});
      if (!rows.length) {
        const state=await db.sync_state.get(recordDeltaCursorKey(store));
        if(state) await db.sync_state.put({...state,value:{...state.value,summariesRebuilt:true}});
      }
    });
    processed += count;
    if (!count) return {processed};
    await new Promise(resolve=>setTimeout(resolve,0));
  }
}
