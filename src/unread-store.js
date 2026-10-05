import { hasPersonalUnreadAttention } from './personal-attention.js';
/**
 * Unread indicators mixin for the Alpine chat store.
 *
 * Tracks read cursors per nav section and per chat channel.
 * Shows red dots on nav items when a section has unseen updates.
 *
 * Cursor key patterns:
 *   chat:nav          - nav-level cursor for the Chat section
 *   chat:channel:<id> - per-channel cursor
 *   tasks:nav         - nav-level cursor for the Tasks section
 *   docs:nav          - nav-level cursor for the Docs section
 *
 * record_id is deterministic: hex(sha256(viewer_npub + cursor_key))
 */

import {
  upsertReadCursor,
  getWorkspaceDb,
  getChannelsByOwner,
  getReadCursorsByKeys,
  getReadCursorsByPrefix,
  getTasksByOwner,
  getSyncState,
  getResourceViewStates,
  getBulkReadResourceStates,
  getResourceViewState,
  upsertResourceViewState,
  replaceResourceViewStates,
  isWorkspaceDbOpenForKey,
} from './db.js';
import {
  getTowerPgResourceViewStates,
  markTowerPgResourcesViewed,
} from './api.js';
import { putTowerPgResourceViewState, acceptTowerPgRemoteConflict } from './tower-command-intents.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import { resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';
import {
  mapTowerResourceViewState,
  readCompleteResourceViewStateSnapshot,
  resourceViewStateId,
} from './resource-view-state.js';
import { recordFamilyHash } from './translators/chat.js';
import { matchesTaskBoardScope } from './task-board-scopes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function cursorRecordId(viewerNpub, cursorKey) {
  return sha256Hex(viewerNpub + cursorKey);
}

async function loadUnreadCursorMap(viewerNpub) {
  const [navRows, channelRows, taskRows, docRows] = await Promise.all([
    getReadCursorsByKeys(viewerNpub, ['chat:nav', 'tasks:nav', 'docs:nav']),
    getReadCursorsByPrefix(viewerNpub, 'chat:channel:'),
    getReadCursorsByPrefix(viewerNpub, 'tasks:item:'),
    getReadCursorsByPrefix(viewerNpub, 'docs:item:'),
  ]);

  const cursorMap = {};
  for (const row of [...navRows, ...channelRows, ...taskRows, ...docRows]) {
    cursorMap[row.cursor_key] = row.read_until;
  }
  return cursorMap;
}

const DOCUMENT_FAMILY = recordFamilyHash('document');
const TASK_FAMILY = recordFamilyHash('task');

function taskCommentsFor(comments = [], taskId = '') {
  return (Array.isArray(comments) ? comments : []).filter((comment) => (
    comment?.record_state !== 'deleted'
    && String(comment?.target_record_id || '').trim() === taskId
    && (
      String(comment?.pg_record_type || '').trim() === 'task_comment'
      || !comment?.target_record_family_hash
      || comment.target_record_family_hash === TASK_FAMILY
    )
  ));
}


function usesTowerResourceViewState(store) {
  return isTowerPgBackendMode()
    && Boolean(store?.isTowerPgMode || store?.currentWorkspace?.pgBackendMode || store?.pgBackendMode);
}

export const TOWER_RESOURCE_VIEW_STATE_BULK_LIMIT = 500;

export function collectChannelThreadViewResources(states = [], channelId = '') {
  const targetChannelId = String(channelId || '').trim();
  if (!targetChannelId) return [];
  return (Array.isArray(states) ? states : [])
    .filter((state) => (
      state?.resource_type === 'thread'
      && String(state?.channel_id || '').trim() === targetChannelId
      && String(state?.resource_id || '').trim()
    ))
    .map((state) => ({
      resource_type: 'thread',
      resource_id: String(state.resource_id).trim(),
      activity_version: Math.max(0, Number(state.activity_version || 0)),
    }));
}

export function collectUnreadViewResources(states = [], resourceTypes = []) {
  const allowedTypes = new Set((Array.isArray(resourceTypes) ? resourceTypes : []).map((type) => String(type || '').trim()));
  return (Array.isArray(states) ? states : [])
    .filter((state) => (
      allowedTypes.has(String(state?.resource_type || '').trim())
      && String(state?.resource_id || '').trim()
      && Number((state.attention_policy_version === 1 ? state.attention_activity_version : state.activity_version) || 0) > Number(state.viewed_activity_version || 0)
    ))
    .map((state) => ({
      resource_type: String(state.resource_type).trim(),
      resource_id: String(state.resource_id).trim(),
      activity_version: Math.max(0, Number(state.activity_version || 0)),
    }));
}

async function applyBulkReadProjection(store, states, assertCurrent) {
  if (store._recordDeltaAttentionActive) {
    const { getPgAttentionProjection } = await import('./pg-record-delta.js');
    const projection = await getPgAttentionProjection(store);
    assertCurrent();
    if (unreadStoreMixin.applyPgAttentionProjection.call(store, projection)) return;
  }
  assertCurrent();
  store.applyTowerPgResourceViewStates(states);
}

// Bulk writes are confirmed-only: a failed atomic Tower batch must not leave
// monotonic pending rows that the refresh path would later replay individually.
async function markBulkViewResources(store, context, resources, assertCurrent) {
  const readStates = store.getResourceViewStates || getResourceViewStates;
  const writeState = store.upsertResourceViewState || upsertResourceViewState;
  const markResources = store.markTowerPgResourcesViewed || markTowerPgResourcesViewed;
  let count = 0;
  let skipped = 0;
  try {
    for (const chunk of chunkResourceViewStateWrites(resources)) {
      let remaining = chunk.map((resource) => ({
        resource_type: resource.resource_type,
        resource_id: resource.resource_id,
        viewed_activity_version: resource.activity_version,
      }));
      while (remaining.length) {
        assertCurrent();
        let result;
        try {
          result = await markResources(context.workspaceId, remaining, {
            baseUrl: context.baseUrl, appNpub: context.appNpub,
          });
        } catch (error) {
          assertCurrent();
          const missing = error?.payload;
          const candidate = Number.isInteger(missing?.index) ? remaining[missing.index] : null;
          // Tower validates every item before its transaction. Only this exact
          // indexed missing-resource response permits retrying the remainder.
          if (error?.status !== 404 || error?.code !== 'resource_not_found'
            || !candidate || candidate.resource_type !== missing.resource_type
            || candidate.resource_id !== missing.resource_id) throw error;
          remaining = remaining.filter((_, index) => index !== missing.index);
          skipped += 1;
          continue;
        }
        assertCurrent();
        const rows = (Array.isArray(result?.states) ? result.states : []).map(mapTowerResourceViewState);
        if (rows.length !== remaining.length || rows.some((row) => !row)
          || new Set(rows.map((row) => row.record_id)).size !== remaining.length
          || remaining.some((resource) => !rows.some((row) => row.resource_type === resource.resource_type
            && row.resource_id === resource.resource_id))) {
          throw new Error('Tower returned an incomplete bulk read acknowledgement.');
        }
        for (const row of rows) {
          assertCurrent();
          await writeState(row);
          count += 1;
        }
        break;
      }
    }
    assertCurrent();
    const states = await readStates();
    assertCurrent();
    await applyBulkReadProjection(store, states, assertCurrent);
    return { ok: true, count, ...(skipped ? { skipped } : {}) };
  } catch (error) {
    // Keep confirmed earlier chunks visible, but never touch a new activation.
    try {
      assertCurrent();
      const states = await readStates();
      assertCurrent();
      await applyBulkReadProjection(store, states, assertCurrent);
    } catch { /* The original error remains the actionable failure. */ }
    return { ok: false, count, ...(skipped ? { skipped } : {}), error: error?.message || 'Failed to mark items as read.' };
  }
}

function bulkViewWorkspaceGuard(store, context) {
  const key = store.currentWorkspaceKey;
  return () => {
    const current = resolveTowerPgWorkspaceContext(store);
    if (key !== store.currentWorkspaceKey
      || ['workspaceId', 'baseUrl', 'appNpub', 'sessionNpub', 'generation'].some((field) => current[field] !== context[field])
      || (!store.getResourceViewStates && !isWorkspaceDbOpenForKey(key))) {
      throw new Error('Workspace changed while marking items as read.');
    }
  };
}

function recordScopeId(row = {}) {
  return String(
    row?.scope_id
    || row?.scope_l5_id
    || row?.scope_l4_id
    || row?.scope_l3_id
    || row?.scope_l2_id
    || row?.scope_l1_id
    || '',
  ).trim();
}

function recordChannelId(row = {}) {
  return String(row?.channel_id || row?.pg_channel_id || '').trim();
}

function findInboxResourceRow(state, context = {}) {
  const type = String(state?.resource_type || '').trim();
  const id = String(state?.resource_id || '').trim();
  if (!id) return null;
  if (type === 'task') {
    return (context.tasks || []).find((row) => String(row?.record_id || '').trim() === id) || null;
  }
  if (type === 'document') {
    return (context.documents || []).find((row) => String(row?.record_id || '').trim() === id) || null;
  }
  if (type === 'thread') {
    return (context.messages || []).find((row) => (
      String(row?.pg_thread_id || '').trim() === id
      || String(row?.parent_message_id || '').trim() === id
      || String(row?.record_id || '').trim() === id
    )) || null;
  }
  return null;
}

function inboxResourceMatchesScope(state, selectedScope, context = {}) {
  if (!selectedScope?.record_id) return true;
  const scopesMap = context.scopesMap instanceof Map ? context.scopesMap : new Map();
  const resource = findInboxResourceRow(state, context);
  const resourceScopeId = recordScopeId(resource);
  if (resourceScopeId) {
    return matchesTaskBoardScope(resource, selectedScope, scopesMap, { includeDescendants: true });
  }

  const stateScopeId = recordScopeId(state);
  if (stateScopeId) {
    return matchesTaskBoardScope(state, selectedScope, scopesMap, { includeDescendants: true });
  }

  const channelId = recordChannelId(resource) || recordChannelId(state);
  if (!channelId) return false;
  const channel = (context.channels || []).find((row) => String(row?.record_id || '').trim() === channelId);
  return Boolean(channel && matchesTaskBoardScope(channel, selectedScope, scopesMap, { includeDescendants: true }));
}

export function collectScopeUnreadViewResources(states = [], resourceTypes = [], context = {}) {
  const selectedScopeId = String(context.selectedScopeId || '').trim();
  if (!selectedScopeId) return collectUnreadViewResources(states, resourceTypes);
  const scopesMap = context.scopesMap instanceof Map ? context.scopesMap : new Map();
  const selectedScope = scopesMap.get(selectedScopeId) || null;
  if (!selectedScope) return [];
  return collectUnreadViewResources(states, resourceTypes)
    .filter((resource) => {
      const state = (Array.isArray(states) ? states : []).find((row) => (
        String(row?.resource_type || '').trim() === resource.resource_type
        && String(row?.resource_id || '').trim() === resource.resource_id
      ));
      return inboxResourceMatchesScope(state, selectedScope, { ...context, scopesMap });
    });
}

export function chunkResourceViewStateWrites(resources = [], limit = TOWER_RESOURCE_VIEW_STATE_BULK_LIMIT) {
  const size = Math.max(1, Math.min(TOWER_RESOURCE_VIEW_STATE_BULK_LIMIT, Math.trunc(Number(limit) || TOWER_RESOURCE_VIEW_STATE_BULK_LIMIT)));
  const chunks = [];
  for (let index = 0; index < resources.length; index += size) chunks.push(resources.slice(index, index + size));
  return chunks;
}

export function pickEffectiveReadUntil(navReadUntil = null, itemReadUntil = null) {
  if (itemReadUntil && (!navReadUntil || itemReadUntil > navReadUntil)) {
    return itemReadUntil;
  }
  return navReadUntil || null;
}

export function isMessageUnreadAtCutoff(message, cutoff, options = {}) {
  if (!message || !cutoff) return false;
  if ((message.record_state || 'active') === 'deleted') return false;
  const selectedChannelId = String(options.channelId || '').trim();
  if (selectedChannelId && message.channel_id !== selectedChannelId) return false;
  const viewerNpub = String(options.viewerNpub || '').trim();
  if (viewerNpub && message.sender_npub === viewerNpub) return false;
  const updatedAt = String(message.updated_at || '').trim();
  if (!updatedAt) return false;
  return updatedAt > cutoff;
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without Alpine/Dexie)
// ---------------------------------------------------------------------------

/**
 * Given a list of tasks and a cursor map, return an object mapping record_id → true
 * for every task that has unread updates.
 *
 * A task is unread when its updated_at exceeds the more recent of:
 *   - its per-task cursor  (tasks:item:<id>)
 *   - the section cursor   (tasks:nav)
 *
 * If no tasks:nav cursor exists yet the user has never visited the section,
 * so nothing can be unread (avoids a wall of red on first load).
 */
export function computeUnreadTaskMap(tasks, cursorMap, viewerNpub) {
  const navReadUntil = cursorMap['tasks:nav'] || null;
  if (!navReadUntil) return {};

  const result = {};
  for (const task of tasks) {
    if (task.record_state === 'deleted') continue;
    const taskKey = `tasks:item:${task.record_id}`;
    const taskReadUntil = cursorMap[taskKey] || null;
    let effectiveReadUntil = pickEffectiveReadUntil(navReadUntil, taskReadUntil);

    // Self-created tasks are implicitly "read" at creation time.
    // The creator already knows about the task they made, so treat
    // created_at as a floor for the read cursor.  If someone else
    // later updates the task (updated_at > created_at), it will
    // surface as unread again.
    if (
      viewerNpub &&
      task.owner_npub === viewerNpub &&
      task.created_at &&
      task.created_at > effectiveReadUntil
    ) {
      effectiveReadUntil = task.created_at;
    }

    if (task.updated_at > effectiveReadUntil) {
      result[task.record_id] = true;
    }
  }
  return result;
}

/**
 * Derive whether the tasks nav dot should show from the per-task unread map.
 * Returns true if at least one task is unread.
 */
export function hasUnreadTasks(unreadTaskItems) {
  return Object.values(unreadTaskItems).some((v) => v);
}

export function computeUnreadDocumentMap(documents, comments, cursorMap, viewerNpub) {
  const navReadUntil = cursorMap['docs:nav'] || null;
  if (!navReadUntil) return {};

  const commentsByDocument = new Map();
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!comment?.record_id || comment.record_state === 'deleted') continue;
    if (comment.target_record_family_hash && comment.target_record_family_hash !== DOCUMENT_FAMILY) continue;
    const targetId = String(comment.target_record_id || '').trim();
    if (!targetId) continue;
    const latest = commentsByDocument.get(targetId);
    if (!latest || String(comment.updated_at || '') > String(latest.updated_at || '')) {
      commentsByDocument.set(targetId, comment);
    }
  }

  const result = {};
  for (const doc of Array.isArray(documents) ? documents : []) {
    if (!doc?.record_id || doc.record_state === 'deleted' || doc.pg_record_type === 'file') continue;
    const docKey = `docs:item:${doc.record_id}`;
    const docReadUntil = cursorMap[docKey] || null;
    let effectiveReadUntil = pickEffectiveReadUntil(navReadUntil, docReadUntil);

    if (
      viewerNpub
      && doc.owner_npub === viewerNpub
      && doc.created_at
      && doc.created_at > effectiveReadUntil
    ) {
      effectiveReadUntil = doc.created_at;
    }

    const latestComment = commentsByDocument.get(doc.record_id);
    const latestActivityAt = [doc.updated_at || '', latestComment?.updated_at || '']
      .filter(Boolean)
      .sort()
      .at(-1) || '';
    if (latestActivityAt && latestActivityAt > effectiveReadUntil) {
      result[doc.record_id] = true;
    }
  }
  return result;
}

/**
 * Determine whether the tasks:nav cursor should be auto-seeded.
 * Returns true when tasks exist in the DB but no cursor has been set yet
 * (e.g. after cache clear + hard refresh).
 */
export function shouldSeedTasksNavCursor(tasks, cursorMap) {
  if (cursorMap['tasks:nav']) return false;
  return tasks.some((t) => t.record_state !== 'deleted');
}

// ---------------------------------------------------------------------------
// Mixin
// ---------------------------------------------------------------------------

export const unreadStoreMixin = {
  // Reactive unread flags — these drive the red dots in the nav
  _unreadChat: false,
  _unreadTasks: false,
  _unreadDocs: false,
  // Per-channel unread map: { channelId: boolean }
  _unreadChannels: {},
  _unreadThreadItems: {},
  // Per-task unread map: { taskRecordId: boolean }
  _unreadTaskItems: {},
  // Per-document unread map: { documentRecordId: boolean }
  _unreadDocItems: {},
  inboxReadBusy: false,
  inboxReadNotice: '',

  get unreadChat() { return this._unreadChat; },
  get unreadTasks() { return this._unreadTasks; },
  get unreadDocs() { return this._unreadDocs; },
  get unreadDeck() { return this._unreadChat || this._unreadTasks || this._unreadDocs; },

  async captureSelectedChannelUnreadSnapshot(channelId) {
    const viewerNpub = this.session?.npub;
    if (!viewerNpub || !channelId) return null;
    const cursorMap = await loadUnreadCursorMap(viewerNpub);
    return pickEffectiveReadUntil(
      cursorMap.chat_nav || cursorMap['chat:nav'] || null,
      cursorMap[`chat:channel:${channelId}`] || null,
    );
  },

  isMessageUnread(message) {
    return isMessageUnreadAtCutoff(message, this.selectedChannelUnreadCutoff, {
      channelId: this.selectedChannelUnreadChannelId,
      viewerNpub: this.session?.npub,
    });
  },

  isChannelUnread(channelId) {
    return this._unreadChannels[channelId] === true;
  },

  isThreadUnread(threadId) {
    return this._unreadThreadItems[threadId] === true;
  },

  isRootThreadUnread(message) {
    if (!message || message.parent_message_id) return false;
    const threadId = String(message.pg_thread_id || '').trim();
    return Boolean(threadId) && this.isThreadUnread(threadId);
  },

  isTaskUnread(taskId) {
    return this._unreadTaskItems[taskId] === true;
  },

  isDocUnread(docId) {
    return this._unreadDocItems[docId] === true;
  },

  /**
   * Boot unread tracking — call after workspace DB is open and session.npub is available.
   */
  async initUnreadTracking() {
    if (!isWorkspaceDbOpenForKey(this.currentWorkspaceKey)) return;
    await this.refreshUnreadFlags();
  },

  teardownUnreadTracking() {
    // No-op for now. Unread state is refreshed on sync completion and explicit read actions.
  },

  /**
   * Re-compute all unread flags.
   * Prefers worker-computed summary from sync_state when available
   * (avoids expensive DB scans on the main thread). Falls back to
   * direct computation for per-task unread maps and cursor seeding.
   */
  async refreshUnreadFlags() {
    const viewerNpub = this.session?.npub;
    if (!viewerNpub) return;
    if (!isWorkspaceDbOpenForKey(this.currentWorkspaceKey)) return;

    if (usesTowerResourceViewState(this)) {
      await this.refreshTowerPgResourceViewStates();
      return;
    }

    try {
      // Try reading the worker-computed summary first
      const summary = await getSyncState('unread_summary');
      if (summary && typeof summary === 'object' && summary.computedAt) {
        this._unreadChat = Boolean(summary.chatUnread);
        this._unreadDocs = Boolean(summary.docsUnread);
        this._unreadChannels = summary.channelUnread || {};

        // Per-task unread still needs the full task list for the map
        // (drives per-task red borders), but use the summary for the nav dot
        if (summary.tasksUnread != null) {
          this._unreadTasks = Boolean(summary.tasksUnread);
        }

        // Compute per-task map only if tasks section is active (needed for borders)
        if (this.navSection === 'tasks') {
          const db = getWorkspaceDb();
          const cursorMap = await loadUnreadCursorMap(viewerNpub);
          const allTasks = Array.isArray(this.tasks) && this.tasks.length > 0
            ? this.tasks
            : this.workspaceOwnerNpub
              ? await getTasksByOwner(this.workspaceOwnerNpub)
              : await db.tasks.toArray();

          if (shouldSeedTasksNavCursor(allTasks, cursorMap)) {
            const activeTasks = allTasks.filter((t) => t.record_state !== 'deleted');
            const oldest = activeTasks.reduce(
              (min, t) => (t.updated_at < min ? t.updated_at : min),
              activeTasks[0]?.updated_at || new Date().toISOString(),
            );
            const seedTime = new Date(new Date(oldest).getTime() - 1).toISOString();
            const cursorKey = 'tasks:nav';
            const recordId = await cursorRecordId(viewerNpub, cursorKey);
            await upsertReadCursor({
              record_id: recordId,
              cursor_key: cursorKey,
              viewer_npub: viewerNpub,
              read_until: seedTime,
            });
            cursorMap[cursorKey] = seedTime;
          }

          this._unreadTaskItems = computeUnreadTaskMap(allTasks, cursorMap, viewerNpub);
          this._unreadTasks = hasUnreadTasks(this._unreadTaskItems);
        }
        const docs = Array.isArray(this.documents) ? this.documents : [];
        const comments = Array.isArray(this.autopilotOverviewComments) ? this.autopilotOverviewComments : [];
        this._unreadDocItems = computeUnreadDocumentMap(docs, comments, await loadUnreadCursorMap(viewerNpub), viewerNpub);
        this._unreadDocs = this._unreadDocs || Object.values(this._unreadDocItems).some(Boolean);
        return;
      }

      // Fallback: no worker summary available, compute directly
      const db = getWorkspaceDb();
      const cursorMap = await loadUnreadCursorMap(viewerNpub);

      // --- Chat nav ---
      const chatReadUntil = cursorMap['chat:nav'] || '1970-01-01T00:00:00.000Z';
      const allMessages = await db.chat_messages.where('updated_at').above(chatReadUntil).first();
      this._unreadChat = allMessages != null && allMessages.record_state !== 'deleted';

      // --- Docs nav ---
      const docsReadUntil = cursorMap['docs:nav'] || '1970-01-01T00:00:00.000Z';
      const latestDoc = await db.documents.where('updated_at').above(docsReadUntil).first();
      this._unreadDocs = latestDoc != null && latestDoc.record_state !== 'deleted';
      const allDocs = Array.isArray(this.documents) && this.documents.length > 0
        ? this.documents
        : await db.documents.toArray();
      const allComments = Array.isArray(this.autopilotOverviewComments) && this.autopilotOverviewComments.length > 0
        ? this.autopilotOverviewComments
        : await db.comments.toArray();
      this._unreadDocItems = computeUnreadDocumentMap(allDocs, allComments, cursorMap, viewerNpub);
      this._unreadDocs = this._unreadDocs || Object.values(this._unreadDocItems).some(Boolean);

      // --- Per-channel unread (batched) ---
      const channels = Array.isArray(this.channels)
        ? this.channels
        : this.workspaceOwnerNpub
          ? await getChannelsByOwner(this.workspaceOwnerNpub)
          : [];
      const newChannelMap = {};
      if (channels.length > 0) {
        let earliestCursor = chatReadUntil || '1970-01-01T00:00:00.000Z';
        const channelCursors = {};
        for (const ch of channels) {
          const key = `chat:channel:${ch.record_id}`;
          const chReadUntil = cursorMap[key] || null;
          const effective = pickEffectiveReadUntil(chatReadUntil, chReadUntil)
            || '1970-01-01T00:00:00.000Z';
          channelCursors[ch.record_id] = effective;
          if (effective < earliestCursor) earliestCursor = effective;
        }
        const recentMessages = await db.chat_messages
          .where('updated_at').above(earliestCursor)
          .toArray();
        for (const ch of channels) {
          const cursor = channelCursors[ch.record_id];
          newChannelMap[ch.record_id] = recentMessages.some(
            (m) => m.channel_id === ch.record_id
              && m.updated_at > cursor
              && m.record_state !== 'deleted'
          );
        }
      }
      this._unreadChannels = newChannelMap;

      // --- Per-task unread ---
      const allTasks = Array.isArray(this.tasks)
        ? this.tasks
        : this.workspaceOwnerNpub
          ? await getTasksByOwner(this.workspaceOwnerNpub)
          : await db.tasks.toArray();

      if (shouldSeedTasksNavCursor(allTasks, cursorMap)) {
        const activeTasks = allTasks.filter((t) => t.record_state !== 'deleted');
        const oldest = activeTasks.reduce(
          (min, t) => (t.updated_at < min ? t.updated_at : min),
          activeTasks[0]?.updated_at || new Date().toISOString(),
        );
        const seedTime = new Date(new Date(oldest).getTime() - 1).toISOString();
        const cursorKey = 'tasks:nav';
        const recordId = await cursorRecordId(viewerNpub, cursorKey);
        await upsertReadCursor({
          record_id: recordId,
          cursor_key: cursorKey,
          viewer_npub: viewerNpub,
          read_until: seedTime,
        });
        cursorMap[cursorKey] = seedTime;
      }

      this._unreadTaskItems = computeUnreadTaskMap(allTasks, cursorMap, viewerNpub);
      this._unreadTasks = hasUnreadTasks(this._unreadTaskItems);
    } catch (e) {
      // Swallow errors — unread flags are non-critical
      console.warn('[unread] refresh failed:', e?.message || e);
    }
  },

  async acceptRecordSyncRemoteConflict(key) {
    try { await acceptTowerPgRemoteConflict(this, key); }
    catch (error) { this.error = error.message; }
  },

  dismissAvatarSyncConflicts() {
    this.avatarSyncConflictDismissed = true;
  },

  async useTowerForAvatarSyncConflicts() {
    const conflicts = Array.isArray(this.avatarSyncConflicts) ? [...this.avatarSyncConflicts] : [];
    if (!conflicts.length) return;
    try {
      for (const conflict of conflicts) {
        if (conflict?.key) await acceptTowerPgRemoteConflict(this, conflict.key);
      }
      this.avatarSyncConflictDismissed = true;
    } catch (error) {
      this.error = error?.message || 'Could not refresh local file sync from Tower.';
    }
  },

  applyPgAttentionProjection(projection) {
    if (!projection) { this._recordDeltaAttentionActive = false; return false; }
    this._recordDeltaAttentionActive = true;
    this.recordSyncConflictCount = projection.conflictCount || 0;
    this.recordSyncConflicts = projection.conflicts || [];
    this.avatarSyncConflictCount = projection.avatarSyncConflictCount || 0;
    this.avatarSyncConflicts = projection.avatarSyncConflicts || [];
    if (!this.avatarSyncConflictCount) this.avatarSyncConflictDismissed = false;
    this._unreadChat = Boolean(projection.values['section:chat']);
    this._unreadTasks = Boolean(projection.values['section:tasks']);
    this._unreadDocs = Boolean(projection.values['section:docs']);
    this._unreadChannels = Object.fromEntries(Object.entries(projection.values)
      .filter(([key, count]) => key.startsWith('channel:') && count > 0).map(([key]) => [key.slice(8), true]));
    for (const [type, field] of [['thread','_unreadThreadItems'],['task','_unreadTaskItems'],['document','_unreadDocItems']]) {
      this[field] = Object.fromEntries(projection.visible.filter(r => r.resource_type === type && r.unread).map(r => [r.resource_id,true]));
    }
    return true;
  },

  applyTowerPgResourceViewStates(states = []) {
    if (this._recordDeltaAttentionActive) return;
    const threadItems = {};
    const taskItems = {};
    const docItems = {};
    const channels = {};
    const tasksById = new Map((this.tasks || []).map(row => [row.record_id, row]));
    const docsById = new Map((this.documents || []).map(row => [row.record_id, row]));
    const comments = this.autopilotOverviewComments || this.taskComments || [];
    for (const state of states) {
      const row = state.resource_type === 'task' ? tasksById.get(state.resource_id)
        : state.resource_type === 'document' ? docsById.get(state.resource_id) : state;
      const options = { resourceType: state.resource_type,
        viewerActorId: this.currentPgActorId, viewerNpub: this.currentViewerNpub || this.session?.npub,
        workspaceMembers: this.pgWorkspaceMembers,
        comments: comments.filter(comment => comment.target_record_id === state.resource_id) };
      if (!hasPersonalUnreadAttention(row || {}, state, options)) continue;
      if (state.resource_type === 'thread') threadItems[state.resource_id] = true;
      if (state.resource_type === 'task') taskItems[state.resource_id] = true;
      if (state.resource_type === 'document') docItems[state.resource_id] = true;
      if (state.channel_id) channels[state.channel_id] = true;
    }
    this._unreadThreadItems = threadItems;
    this._unreadTaskItems = taskItems;
    this._unreadDocItems = docItems;
    this._unreadChannels = channels;
    this._unreadChat = Object.keys(threadItems).length > 0;
    this._unreadTasks = Object.keys(taskItems).length > 0;
    this._unreadDocs = Object.keys(docItems).length > 0;
  },

  async recomputeTowerPgUnreadProjection() {
    if (!usesTowerResourceViewState(this)) return false;
    if (!isWorkspaceDbOpenForKey(this.currentWorkspaceKey)) return false;
    const { getPgAttentionProjection } = await import('./pg-record-delta.js');
    if ((this.applyPgAttentionProjection || unreadStoreMixin.applyPgAttentionProjection).call(this, await getPgAttentionProjection(this))) return true;
    this.applyTowerPgResourceViewStates(await getResourceViewStates());
    return true;
  },

  scheduleTowerPgUnreadProjectionRefresh() {
    if (!usesTowerResourceViewState(this)) return null;
    this._towerPgUnreadProjectionRefreshRequested = true;
    if (this._towerPgUnreadProjectionRefreshPromise) {
      return this._towerPgUnreadProjectionRefreshPromise;
    }
    this._towerPgUnreadProjectionRefreshPromise = Promise.resolve()
      .then(async () => {
        do {
          this._towerPgUnreadProjectionRefreshRequested = false;
          await this.recomputeTowerPgUnreadProjection();
        } while (this._towerPgUnreadProjectionRefreshRequested);
      })
      .catch(() => false)
      .finally(() => {
        this._towerPgUnreadProjectionRefreshPromise = null;
      });
    return this._towerPgUnreadProjectionRefreshPromise;
  },

  async refreshTowerPgResourceViewStates() {
    const context = resolveTowerPgWorkspaceContext(this);
    if (!context.workspaceId || !context.baseUrl) return;
    const refreshGeneration = Number(this._towerPgResourceViewStateRefreshGeneration || 0) + 1;
    this._towerPgResourceViewStateRefreshGeneration = refreshGeneration;
    const localBefore = await getResourceViewStates();
    for (const pending of localBefore.filter((state) => state.sync_status === 'pending')) {
      try {
        const result = await putTowerPgResourceViewState(
          this,
          context.workspaceId, pending.resource_type, pending.resource_id, pending.viewed_activity_version,
          { baseUrl: context.baseUrl, appNpub: context.appNpub },
        );
        const row = mapTowerResourceViewState(result?.state);
        if (row) await upsertResourceViewState(row);
      } catch {
        // Keep the optimistic monotonic row pending for the next reconnect/sync pass.
      }
    }
    const { getPgAttentionProjection } = await import('./pg-record-delta.js');
    if ((this.applyPgAttentionProjection || unreadStoreMixin.applyPgAttentionProjection).call(this, await getPgAttentionProjection(this))) return;
    try {
      const result = await readCompleteResourceViewStateSnapshot((cursor) => (
        getTowerPgResourceViewStates(context.workspaceId, {
          baseUrl: context.baseUrl, appNpub: context.appNpub, limit: 200, cursor,
        })
      ));
      const rows = (Array.isArray(result?.states) ? result.states : [])
        .map((state) => mapTowerResourceViewState(state))
        .filter(Boolean);
      if (this._towerPgResourceViewStateRefreshGeneration === refreshGeneration) {
        await replaceResourceViewStates(rows);
      }
    } catch {
      // Offline rendering continues from Dexie.
    }
    this.applyTowerPgResourceViewStates(await getResourceViewStates());
  },

  async markTowerPgResourceViewed(resourceType, resourceId, activityVersion = null) {
    const context = resolveTowerPgWorkspaceContext(this);
    if (!context.workspaceId || !resourceId) return false;
    const current = await getResourceViewState(resourceType, resourceId);
    const targetVersion = Math.max(Number(activityVersion ?? current?.activity_version ?? 0), Number(current?.viewed_activity_version || 0));
    const optimistic = {
      ...current,
      record_id: resourceViewStateId(resourceType, resourceId),
      resource_type: resourceType,
      resource_id: resourceId,
      activity_version: Math.max(Number(current?.activity_version || 0), targetVersion),
      viewed_activity_version: targetVersion,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    };
    await upsertResourceViewState(optimistic);
    this.applyTowerPgResourceViewStates(await getResourceViewStates());
    try {
      const result = await putTowerPgResourceViewState(this, context.workspaceId, resourceType, resourceId, targetVersion, {
        baseUrl: context.baseUrl, appNpub: context.appNpub,
      });
      const row = mapTowerResourceViewState(result?.state);
      if (row) await upsertResourceViewState(row);
      this.applyTowerPgResourceViewStates(await getResourceViewStates());
    } catch {
      return false;
    }
    return true;
  },

  async markAllChannelThreadsRead(channelId) {
    const targetChannelId = String(channelId || '').trim();
    const context = resolveTowerPgWorkspaceContext(this);
    if (!targetChannelId || !context.workspaceId || !context.baseUrl) {
      return { ok: false, count: 0, error: 'Tower channel view state is unavailable.' };
    }

    const assertCurrent = bulkViewWorkspaceGuard(this, context);
    const states = await (this.getResourceViewStates || getResourceViewStates)();
    try { assertCurrent(); } catch (error) { return { ok: false, count: 0, error: error.message }; }
    const resources = collectChannelThreadViewResources(states, targetChannelId);
    if (resources.length === 0) {
      this.applyTowerPgResourceViewStates(states);
      return { ok: true, count: 0, empty: true };
    }
    return markBulkViewResources(this, context, resources, assertCurrent);
  },

  async markInboxResourcesRead(resourceTypes = [], { allScopes = false } = {}) {
    const types = [...new Set((Array.isArray(resourceTypes) ? resourceTypes : []).filter((type) => ['thread', 'task', 'document'].includes(type)))];
    if (types.length === 0) return { ok: true, count: 0, empty: true };

    if (!usesTowerResourceViewState(this)) {
      const sections = types.map((type) => ({ thread: 'chat', task: 'tasks', document: 'docs' })[type]);
      for (const section of sections) await this.markSectionRead(section);
      if (types.includes('thread')) {
        this._unreadThreadItems = {};
        this._unreadChannels = {};
      }
      if (types.includes('task')) this._unreadTaskItems = {};
      if (types.includes('document')) this._unreadDocItems = {};
      return { ok: true, count: null };
    }

    const context = resolveTowerPgWorkspaceContext(this);
    if (!context.workspaceId || !context.baseUrl) return { ok: false, count: 0, error: 'Tower Inbox view state is unavailable.' };
    const assertCurrent = bulkViewWorkspaceGuard(this, context);
    const states = await (this.getResourceViewStates || getBulkReadResourceStates)();
    try { assertCurrent(); } catch (error) { return { ok: false, count: 0, error: error.message }; }
    const resources = collectScopeUnreadViewResources(states, types, {
      selectedScopeId: allScopes ? '' : this.pgContextScopeId,
      scopesMap: this.scopesMap,
      channels: this.channels,
      messages: this.messages,
      tasks: this.tasks,
      documents: this.documents,
    });
    if (resources.length === 0) {
      this.applyTowerPgResourceViewStates(states);
      return { ok: true, count: 0, empty: true };
    }

    return markBulkViewResources(this, context, resources, assertCurrent);
  },

  async runInboxReadAction(resourceTypes, label = 'items') {
    if (this.inboxReadBusy) return;
    this.inboxReadBusy = true;
    this.inboxReadNotice = '';
    try {
      const result = await this.markInboxResourcesRead(resourceTypes);
      if (!result?.ok) {
        this.inboxReadNotice = result?.error || `Could not mark ${label} as read.`;
      } else if (result.empty) {
        this.inboxReadNotice = `No unread ${label}.`;
      } else if (result.count == null) {
        this.inboxReadNotice = `Marked all ${label} as read.`;
      } else {
        this.inboxReadNotice = `Marked ${result.count} ${result.count === 1 ? 'item' : 'items'} as read.`;
      }
      if (result?.skipped) this.inboxReadNotice += ` Skipped ${result.skipped} unavailable ${result.skipped === 1 ? 'item' : 'items'}.`;
      return result;
    } finally {
      this.inboxReadBusy = false;
    }
  },

  /**
   * Mark a nav section as read (updates cursor to now).
   */
  async markSectionRead(section) {
    if (usesTowerResourceViewState(this)) return;
    const viewerNpub = this.session?.npub;
    if (!viewerNpub) return;
    if (!isWorkspaceDbOpenForKey(this.currentWorkspaceKey)) return;

    const keyMap = {
      chat: 'chat:nav',
      tasks: 'tasks:nav',
      docs: 'docs:nav',
    };
    const cursorKey = keyMap[section];
    if (!cursorKey) return;

    const recordId = await cursorRecordId(viewerNpub, cursorKey);
    const now = new Date().toISOString();
    await upsertReadCursor({
      record_id: recordId,
      cursor_key: cursorKey,
      viewer_npub: viewerNpub,
      read_until: now,
    });

    // Immediately clear the flag
    if (section === 'chat') this._unreadChat = false;
    if (section === 'tasks') this._unreadTasks = false;
    if (section === 'docs') {
      this._unreadDocs = false;
      this._unreadDocItems = {};
    }
  },

  /**
   * Mark a specific chat channel as read.
   */
  async markChannelRead(channelId) {
    if (usesTowerResourceViewState(this)) return;
    const viewerNpub = this.session?.npub;
    if (!viewerNpub || !channelId) return;

    const cursorKey = `chat:channel:${channelId}`;
    const recordId = await cursorRecordId(viewerNpub, cursorKey);
    const now = new Date().toISOString();
    await upsertReadCursor({
      record_id: recordId,
      cursor_key: cursorKey,
      viewer_npub: viewerNpub,
      read_until: now,
    });

    // Also update nav-level chat cursor
    await this.markSectionRead('chat');

    // Immediately clear the channel flag
    this._unreadChannels = { ...this._unreadChannels, [channelId]: false };
  },

  /**
   * Mark a specific task as read.
   */
  async markTaskRead(taskId, activityVersion = null) {
    if (usesTowerResourceViewState(this)) {
      const task = this.tasks?.find?.((item) => item.record_id === taskId);
      return this.markTowerPgResourceViewed('task', taskId, activityVersion ?? task?.activity_version);
    }
    const viewerNpub = this.session?.npub;
    if (!viewerNpub || !taskId) return;

    const cursorKey = `tasks:item:${taskId}`;
    const recordId = await cursorRecordId(viewerNpub, cursorKey);
    const now = new Date().toISOString();
    await upsertReadCursor({
      record_id: recordId,
      cursor_key: cursorKey,
      viewer_npub: viewerNpub,
      read_until: now,
    });

    // Immediately clear the task flag and re-derive nav dot
    this._unreadTaskItems = { ...this._unreadTaskItems, [taskId]: false };
    this._unreadTasks = hasUnreadTasks(this._unreadTaskItems);
  },

  async markThreadRead(threadId, channelId = '') {
    if (!threadId) return false;
    if (usesTowerResourceViewState(this)) {
      return this.markTowerPgResourceViewed('thread', threadId);
    }
    if (!channelId) return false;
    await this.markChannelRead(channelId);
    return true;
  },

  async markDocRead(docId) {
    if (usesTowerResourceViewState(this)) {
      const doc = this.documents?.find?.((item) => item.record_id === docId);
      return this.markTowerPgResourceViewed('document', docId, doc?.activity_version);
    }
    const viewerNpub = this.session?.npub;
    if (!viewerNpub || !docId) return;

    const cursorKey = `docs:item:${docId}`;
    const recordId = await cursorRecordId(viewerNpub, cursorKey);
    const now = new Date().toISOString();
    await upsertReadCursor({
      record_id: recordId,
      cursor_key: cursorKey,
      viewer_npub: viewerNpub,
      read_until: now,
    });

    this._unreadDocItems = { ...this._unreadDocItems, [docId]: false };
    this._unreadDocs = Object.values(this._unreadDocItems).some(Boolean);
  },

  async markDeckResourceRead(resourceType, resourceId, channelId = '') {
    const type = String(resourceType || '').trim();
    const id = String(resourceId || '').trim();
    if (!id) return false;
    if (type === 'thread') return this.markThreadRead(id, channelId);
    if (type === 'task') return this.markTaskRead(id);
    if (type === 'document') return this.markDocRead(id);
    return false;
  },

  async markDeckReviewTaskDone(taskId) {
    const id = String(taskId || '').trim();
    const task = this.tasks?.find?.((item) => item.record_id === id);
    if (!task || String(task.state || '').trim() !== 'review') return false;

    let acceptedTask = null;
    try {
      acceptedTask = await this.applyTaskPatch(id, { state: 'done' }, {
        silent: true,
        sync: true,
        backgroundPg: false,
        intent: 'move',
        rollbackOnFailure: true,
      });
    } catch (error) {
      this.error = error?.message || 'Failed to mark task done.';
      return false;
    }
    if (!acceptedTask || String(acceptedTask.state || '').trim() !== 'done') return false;

    try {
      const markedRead = await this.markTaskRead(id, acceptedTask.activity_version);
      if (markedRead === false) {
        this.error = 'Task was marked done, but its Inbox read state could not be cleared.';
        return false;
      }
      return true;
    } catch (error) {
      this.error = error?.message || 'Task was marked done, but its Inbox read state could not be cleared.';
      return false;
    }
  },

  /**
   * Mark all tasks as read — advances tasks:nav cursor to now,
   * which clears every per-task unread indicator at once.
   */
  async markAllTasksRead() {
    const viewerNpub = this.session?.npub;
    if (!viewerNpub) return;

    if (usesTowerResourceViewState(this)) {
      return unreadStoreMixin.markInboxResourcesRead.call(this, ['task'], { allScopes: true });
    }
    await this.markSectionRead('tasks');
    this._unreadTaskItems = {};
    this._unreadTasks = false;
  },
};
