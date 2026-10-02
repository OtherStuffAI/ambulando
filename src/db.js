import { clampBranchEffectiveMessageIds, threadHistoryLineage, mergeThreadHistoryIds } from './thread-history-coverage.js';
import Dexie from 'dexie';
import { taskIndexFields, compareIndexedTasks } from './task-index-keys.js';
import {
  preserveHydratedDocumentContent,
} from './document-selection.js';
import { getSyncFamily, getSyncStateKeyForFamily } from './sync-families.js';
import {
  resolveWindowLimit,
  takeNewestWindow,
  takeWindow,
  sortRowsByTimestamp,
} from './windowing.js';
import { sameLogicalValue } from './utils/state-helpers.js';
import { buildThreadAwarePresentationWindow } from './chat-presentation-cache.js';

// ---------------------------------------------------------------------------
// Shared DB — singleton, always open. Holds global (non-workspace) state.
// ---------------------------------------------------------------------------

const sharedDb = new Dexie('wingman-fd-shared');

sharedDb.version(1).stores({
  app_settings:        '++id',
  storage_image_cache: '&object_id, cached_at',
  profiles:            'pubkey',
  address_book:        'npub, last_used_at',
});

sharedDb.version(2).stores({
  app_settings:        '++id',
  storage_image_cache: '&object_id, cached_at',
  profiles:            'pubkey',
  address_book:        'npub, last_used_at',
  workspace_keys:      '&workspace_owner_npub, user_npub, ws_key_npub',
});

// Local connection choices are shared across workspaces, never synced to Tower.
sharedDb.version(3).stores({ tower_transport_preferences: '&logicalTower' });

// ---------------------------------------------------------------------------
// Workspace DB — one per workspace identity key.
// Contains ALL record / sync tables.
// ---------------------------------------------------------------------------

let _currentWorkspaceDb = null;
let _currentWorkspaceDbKey = null;

const WORKSPACE_STORES = {
  workspace_settings: '&workspace_owner_npub, record_id, updated_at',
  channels:           'record_id, owner_npub, *group_ids, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id',
  chat_messages:      'record_id, channel_id, parent_message_id, sync_status, updated_at',
  groups:             'group_id, owner_npub, *member_npubs',
  documents:          'record_id, owner_npub, parent_directory_id, sync_status, updated_at, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id',
  directories:        'record_id, owner_npub, parent_directory_id, sync_status, updated_at',
  reports:            'record_id, owner_npub, declaration_type, surface, generated_at, updated_at, *group_ids, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id',
  tasks:              'record_id, owner_npub, parent_task_id, state, sync_status, updated_at, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id, *predecessor_task_ids, flow_id, flow_run_id, flow_step',
  schedules:          'record_id, owner_npub, active, repeat, updated_at, sync_status',
  comments:           'record_id, target_record_id, target_record_family_hash, parent_comment_id, updated_at',
  reactions:          'record_id, target_record_id, target_record_family_hash, emoji, reactor_npub, &[target_record_family_hash+target_record_id+emoji+reactor_npub], updated_at',
  audio_notes:        'record_id, owner_npub, target_record_id, target_record_family_hash, transcript_status, sync_status, updated_at',
  scopes:             'record_id, owner_npub, level, parent_id, l1_id, l2_id, l3_id, l4_id, l5_id, updated_at',
  flows:              'record_id, owner_npub, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id, sync_status, updated_at, *group_ids',
  approvals:          'record_id, owner_npub, flow_id, flow_run_id, flow_step, status, approval_mode, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id, sync_status, updated_at, *group_ids, *task_ids',
  persons:            'record_id, owner_npub, sync_status, updated_at, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id',
  organisations:      'record_id, owner_npub, sync_status, updated_at, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id',
  sync_quarantine:    '&key, family_hash, family_id, record_id, last_seen_at',
  pending_writes:     '++row_id, record_id, record_family_hash, created_at',
  sync_state:         'key',
  read_cursors:       '&record_id, cursor_key, viewer_npub, read_until',
};

const WORKSPACE_STORES_V8 = {
  ...WORKSPACE_STORES,
  opportunities: 'record_id, owner_npub, stage, responsible_npub, sync_status, updated_at, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id, *group_ids',
};

const WORKSPACE_STORES_V10 = {
  ...WORKSPACE_STORES_V8,
  reactions: WORKSPACE_STORES.reactions,
};

const WORKSPACE_STORES_V11 = {
  ...WORKSPACE_STORES_V10,
  wapps: 'record_id, owner_npub, workspace_owner_npub, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id, updated_at',
};
const WORKSPACE_STORES_V12 = {
  ...WORKSPACE_STORES_V11,
  daily_notes: 'record_id, owner_npub, note_date, status, updated_at, sync_status, *group_ids',
};
const WORKSPACE_STORES_V13 = {
  ...WORKSPACE_STORES_V12,
  daily_notes: 'record_id, owner_npub, owner_actor_id, owner_actor_npub, note_date, status, updated_at, sync_status, *group_ids, &[owner_actor_id+note_date]',
};
const WORKSPACE_STORES_V14 = {
  ...WORKSPACE_STORES_V13,
  response_activities: 'record_id, target_type, target_id, channel_id, thread_id, task_id, doc_id, parent_comment_id, status, expires_at, updated_at',
};
const WORKSPACE_STORES_V15 = {
  ...WORKSPACE_STORES_V14,
  file_folders: 'record_id, workspace_id, scope_id, channel_id, parent_folder_id, updated_at',
};
const WORKSPACE_STORES_V16 = {
  ...WORKSPACE_STORES_V15,
  workrooms: 'record_id, workspace_id, scope_id, channel_id, status, updated_at, archived_at',
  workroom_participants: 'record_id, workroom_id, actor_npub, actor_id, role, status, access_status, updated_at, &[workroom_id+actor_npub]',
  workroom_events: 'record_id, workroom_id, channel_id, event_type, target_type, target_ref, created_at',
  workroom_links: 'record_id, workroom_id, link_type, target_type, target_id, status, updated_at',
  workroom_approvals: 'record_id, workspace_id, target_type, target_id, action, status, channel_id, reviewer_npub, requested_by_npub, updated_at',
};
const WORKSPACE_STORES_V17 = {
  ...WORKSPACE_STORES_V16,
  agent_activities: 'record_id, activity_id, channel_id, thread_id, trigger_message_id, session_id, agent_npub, state, sequence, expires_at, updated_at',
};
const WORKSPACE_STORES_V18 = {
  ...WORKSPACE_STORES_V17,
  resource_view_states: '&record_id, &[resource_type+resource_id], resource_type, resource_id, scope_id, channel_id, viewed_activity_version, sync_status, updated_at',
};
const WORKSPACE_STORES_V19 = {
  ...WORKSPACE_STORES_V18,
  wapp_publishing_grants: '&wapp_installation_id, app_id, publisher_npub, status, updated_at',
  wapp_activity_items: 'record_id, workspace_id, wapp_installation_id, category, channel_id, state, unread, muted, priority, occurred_at, updated_at',
  wapp_activity_mutes: '&record_id, target_type, target_value, updated_at, &[target_type+target_value]',
};
const WORKSPACE_STORES_V20 = {
  ...WORKSPACE_STORES_V19,
  workspace_members: '&actor_id, workspace_id, npub, role, updated_at',
};
const WORKSPACE_STORES_V21 = {
  ...WORKSPACE_STORES_V20,
  agent_activities: 'record_id, activity_id, turn_id, channel_id, thread_id, trigger_message_id, session_id, agent_npub, state, sequence, expires_at, created_at, updated_at',
};
const WORKSPACE_STORES_V22 = {
  ...WORKSPACE_STORES_V21,
  agent_activity_commentary: '&history_key, workspace_id, backend_url, turn_id, activity_id, channel_id, sequence, &[turn_id+sequence], created_at',
};
const WORKSPACE_STORES_V23 = {
  ...WORKSPACE_STORES_V22,
  chat_messages: 'record_id, channel_id, parent_message_id, sync_status, updated_at, [channel_id+updated_at]',
};
const WORKSPACE_STORES_V24 = {
  ...WORKSPACE_STORES_V23,
  document_drafts: '&draft_key, workspace_id, document_id, recovery_id, dirty_at, updated_at, &[workspace_id+document_id]',
};

// Materialized index fields keep deleted rows and replies out of root windows.
function messageIndexFields(row) {
  return {
    cache_parent: String(row.parent_message_id ? (row.pg_thread_id || row.parent_message_id) : '').trim(),
    cache_active: row.record_state === 'deleted' ? 0 : 1,
    cache_has_files: String(row.body || '').includes('storage://') ? 1 : 0,
    cache_recent: row.pg_record_type !== 'thread' && !['deleted', 'archived'].includes(row.record_state) ? 1 : 0,
    cache_time: String(row.updated_at || row.created_at || ''),
  };
}
const WORKSPACE_STORES_V25 = {
  ...WORKSPACE_STORES_V24,
  chat_messages: WORKSPACE_STORES_V24.chat_messages + ', pg_client_record_id, [channel_id+sync_status], [channel_id+cache_active+cache_parent+cache_time+record_id], [cache_parent+cache_active+cache_time+record_id], [channel_id+cache_active+cache_time+record_id], [owner_npub+cache_active+cache_time+record_id]',
  tasks: WORKSPACE_STORES_V24.tasks + ', pg_channel_id, pg_client_record_id, *cache_board_keys, *cache_search_tokens, *cache_tags, *cache_assignees',
  documents: WORKSPACE_STORES_V24.documents + ', [owner_npub+cache_active+cache_time+record_id]',
  pg_record_rows: '&key, family, parent_id, [family+parent_id], generation',
  pg_actors: '&actor_id, npub, generation',
  pg_record_conflicts: '&key, family, record_id',
  pg_command_recovery: '&key, record_id',
  channel_summaries: '&channel_id, latest_at',
  pg_resource_attention: '&record_id, channel_id, resource_type, unread',
  pg_attention_counts: '&key',
  comments: WORKSPACE_STORES_V24.comments + ', pg_client_record_id, [target_record_id+cache_active+cache_time+record_id], [parent_comment_id+cache_active+cache_time+record_id], [owner_npub+cache_active+cache_time+record_id]',
};

function activityIndexFields(row) {
  return {
    cache_active: row.record_state === 'deleted' ? 0 : 1,
    cache_time: String(row.updated_at || row.created_at || ''),
    cache_scope: String(row.scope_id || row.pg_scope_id || row.scope_l5_id || row.scope_l4_id || row.scope_l3_id || row.scope_l2_id || row.scope_l1_id || ''),
    cache_has_files: String(row.content || row.body || '').includes('storage://') ? 1 : 0,
    cache_kind: row.target_record_family_hash || (row.pg_record_type === 'file' || row.pg_storage_object_id ? 'file' : 'document'),
  };
}

const WORKSPACE_STORES_V26 = {
  ...WORKSPACE_STORES_V25,
  chat_messages: WORKSPACE_STORES_V25.chat_messages + ', [channel_id+cache_recent+cache_time+record_id], [cache_parent+cache_recent+cache_time+record_id], [channel_id+cache_has_files+cache_active+cache_time+record_id]',
  ...Object.fromEntries(['documents', 'comments'].map(table => [table, WORKSPACE_STORES_V25[table]
    + ', [cache_scope+cache_active+cache_time+record_id], [cache_scope+cache_kind+cache_active+cache_time+record_id], [owner_npub+cache_kind+cache_active+cache_time+record_id], [cache_scope+cache_has_files+cache_active+cache_time+record_id], [owner_npub+cache_has_files+cache_active+cache_time+record_id]'])),
};
const WORKSPACE_STORES_V28 = {
  ...WORKSPACE_STORES_V26,
  agent_activities: 'record_id, activity_id, turn_id, channel_id, thread_id, trigger_message_id, session_id, agent_npub, state, sequence, lease_health, lease_expires_at, expires_at, created_at, updated_at',
  agent_session_health: 'record_id, session_id, channel_id, thread_id, agent_npub, status, generation, sequence, row_version, lease_health, lease_expires_at, updated_at',
};
const WORKSPACE_STORES_V29 = {
  ...WORKSPACE_STORES_V28,
  autopilot_connections: '&id, workspace_id, installation_id, archived_at, updated_at',
  workspace_agents: '&id, workspace_id, connection_id, agent_id, agent_npub, sort_order, is_visible, archived_at, updated_at, [connection_id+sort_order]',
};

function createWorkspaceDb(workspaceDbKey) {
  const db = new Dexie(`wingman-fd-ws-${workspaceDbKey}`);
  const WORKSPACE_STORES_V2 = {
    workspace_settings: '&workspace_owner_npub, record_id, updated_at',
    channels:           'record_id, owner_npub, *group_ids, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    chat_messages:      'record_id, channel_id, parent_message_id, sync_status, updated_at',
    groups:             'group_id, owner_npub, *member_npubs',
    documents:          'record_id, owner_npub, parent_directory_id, sync_status, updated_at, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    directories:        'record_id, owner_npub, parent_directory_id, sync_status, updated_at',
    tasks:              'record_id, owner_npub, parent_task_id, state, sync_status, updated_at, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    schedules:          'record_id, owner_npub, active, repeat, updated_at, sync_status',
    comments:           'record_id, target_record_id, target_record_family_hash, parent_comment_id, updated_at',
    reactions:          'record_id, target_record_id, target_record_family_hash, emoji, reactor_npub, &[target_record_family_hash+target_record_id+emoji+reactor_npub], updated_at',
    audio_notes:        'record_id, owner_npub, target_record_id, target_record_family_hash, transcript_status, sync_status, updated_at',
    scopes:             'record_id, owner_npub, level, parent_id, product_id, project_id, updated_at',
    sync_quarantine:    '&key, family_hash, family_id, record_id, last_seen_at',
    pending_writes:     '++row_id, record_id, record_family_hash, created_at',
    sync_state:         'key',
    read_cursors:       '&record_id, cursor_key, viewer_npub, read_until',
  };
  // v1: original schema (without read_cursors)
  db.version(1).stores({
    workspace_settings: '&workspace_owner_npub, record_id, updated_at',
    channels:           'record_id, owner_npub, *group_ids, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    chat_messages:      'record_id, channel_id, parent_message_id, sync_status, updated_at',
    groups:             'group_id, owner_npub, *member_npubs',
    documents:          'record_id, owner_npub, parent_directory_id, sync_status, updated_at, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    directories:        'record_id, owner_npub, parent_directory_id, sync_status, updated_at',
    tasks:              'record_id, owner_npub, parent_task_id, state, sync_status, updated_at, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    schedules:          'record_id, owner_npub, active, repeat, updated_at, sync_status',
    comments:           'record_id, target_record_id, target_record_family_hash, parent_comment_id, updated_at',
    reactions:          'record_id, target_record_id, target_record_family_hash, emoji, reactor_npub, &[target_record_family_hash+target_record_id+emoji+reactor_npub], updated_at',
    audio_notes:        'record_id, owner_npub, target_record_id, target_record_family_hash, transcript_status, sync_status, updated_at',
    scopes:             'record_id, owner_npub, level, parent_id, product_id, project_id, updated_at',
    sync_quarantine:    '&key, family_hash, family_id, record_id, last_seen_at',
    pending_writes:     '++row_id, record_id, record_family_hash, created_at',
    sync_state:         'key',
  });
  // v2: add read_cursors for unread indicators
  db.version(2).stores(WORKSPACE_STORES_V2);
  // v3: add reports table
  db.version(3).stores({
    ...WORKSPACE_STORES_V2,
    reports: 'record_id, owner_npub, declaration_type, surface, generated_at, updated_at, *group_ids, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
  });
  // v4: canonical scope indexes (l1–l5 replacing product/project/deliverable)
  const WORKSPACE_STORES_V4 = {
    ...WORKSPACE_STORES,
    tasks: 'record_id, owner_npub, parent_task_id, state, sync_status, updated_at, scope_id, scope_l1_id, scope_l2_id, scope_l3_id, scope_l4_id, scope_l5_id',
  };
  delete WORKSPACE_STORES_V4.flows;
  delete WORKSPACE_STORES_V4.approvals;
  db.version(4).stores(WORKSPACE_STORES_V4);
  // v5: add flows, approvals tables + task flow extension indexes
  const WORKSPACE_STORES_V5 = { ...WORKSPACE_STORES };
  delete WORKSPACE_STORES_V5.persons;
  delete WORKSPACE_STORES_V5.organisations;
  db.version(5).stores(WORKSPACE_STORES_V5);
  // v6: add persons, organisations tables
  db.version(6).stores(WORKSPACE_STORES);
  db.version(7).stores(WORKSPACE_STORES);
  db.version(8).stores(WORKSPACE_STORES_V8);
  // Delete the retired legacy store without keeping its identifier in runtime bundles.
  const retiredAgentChatStore = [
    97, 103, 101, 110, 116, 95, 99, 104, 97, 116, 95, 116, 114, 105, 103, 103, 101, 114, 115,
  ].map((code) => String.fromCharCode(code)).join('');
  db.version(9).stores({ [retiredAgentChatStore]: null });
  db.version(10).stores(WORKSPACE_STORES_V10);
  db.version(11).stores(WORKSPACE_STORES_V11);
  db.version(12).stores(WORKSPACE_STORES_V12);
  db.version(13).stores(WORKSPACE_STORES_V13);
  db.version(14).stores(WORKSPACE_STORES_V14);
  db.version(15).stores(WORKSPACE_STORES_V15);
  db.version(16).stores(WORKSPACE_STORES_V16);
  db.version(17).stores(WORKSPACE_STORES_V17);
  db.version(18).stores(WORKSPACE_STORES_V18);
  db.version(19).stores(WORKSPACE_STORES_V19);
  db.version(20).stores(WORKSPACE_STORES_V20);
  db.version(21).stores(WORKSPACE_STORES_V21);
  db.version(22).stores(WORKSPACE_STORES_V22);
  // v23: additive channel/time index for bounded, thread-aware chat presentation reads.
  db.version(23).stores(WORKSPACE_STORES_V23);
  // v24: workspace/document-scoped durable editor drafts and recovery metadata.
  db.version(24).stores(WORKSPACE_STORES_V24);
  db.version(25).stores(WORKSPACE_STORES_V25).upgrade(async (tx) => {
    await tx.table('chat_messages').toCollection().modify((row) => Object.assign(row, messageIndexFields(row)));
    await tx.table('tasks').toCollection().modify((row) => Object.assign(row, taskIndexFields(row)));
    await tx.table('documents').toCollection().modify((row) => Object.assign(row, { cache_active: row.record_state === 'deleted' ? 0 : 1, cache_time: String(row.updated_at || row.created_at || '') }));
    await tx.table('comments').toCollection().modify((row) => Object.assign(row, { cache_active: row.record_state === 'deleted' ? 0 : 1, cache_time: String(row.updated_at || row.created_at || '') }));
  });
  db.version(26).stores(WORKSPACE_STORES_V26).upgrade(async tx => {
    // Additive derived-index repair only; retain all rows, pending writes,
    // canonical generations and cursors. Dexie owns the atomic upgrade.
    await tx.table('chat_messages').toCollection().modify(row => Object.assign(row, messageIndexFields(row)));
    for (const table of ['documents', 'comments']) {
      await tx.table(table).toCollection().modify(row => Object.assign(row, activityIndexFields(row)));
    }
  });
  db.version(27).stores({ ...WORKSPACE_STORES_V26, drive_shares: '&key, context, id', drive_listings: '&key, context, share_key, fetched_at' });
  db.version(28).stores({ ...WORKSPACE_STORES_V28, drive_shares: '&key, context, id', drive_listings: '&key, context, share_key, fetched_at' });
  db.version(29).stores({ ...WORKSPACE_STORES_V29, drive_shares: '&key, context, id', drive_listings: '&key, context, share_key, fetched_at' });
  db.version(30).stores({
    feed_subscriptions: '&key, context, id, status',
    feed_item_states: '&key, context, subscription_id, item_id',
    feed_items: '&key, context, subscription_id, source_key, fetched_at',
    feed_source_status: '&key, context, subscription_id',
    feed_commands: '&mutation_id, context, subscription_id',
    feed_connection_transports: '&key, context, connection_id',
  });
  db.version(31).stores({
    context_components: '&record_id, workspace_id, scope_id, parent_id, [scope_id+parent_id], [scope_id+sort_order]',
    context_references: '&record_id, workspace_id, scope_id, component_id, [scope_id+component_id]',
    context_coverage: '&scope_id, status',
    context_reference_resolutions: '&record_id, component_id, scope_id',
  });
  const commentFields = activityIndexFields;
  db.documents.hook('creating', (_key, row) => { Object.assign(row, commentFields(row)); });
  db.documents.hook('updating', (changes, _key, row) => commentFields({ ...row, ...changes }));
  db.comments.hook('creating', (_key, row) => { Object.assign(row, commentFields(row)); });
  db.comments.hook('updating', (changes, _key, row) => commentFields({ ...row, ...changes }));
  db.tasks.hook('creating', (_key, row) => { Object.assign(row, taskIndexFields(row)); });
  db.tasks.hook('updating', (changes, _key, row) => taskIndexFields({ ...row, ...changes }));
  db.chat_messages.hook('creating', (_key, row) => { Object.assign(row, messageIndexFields(row)); });
  db.chat_messages.hook('updating', (changes, _key, row) => messageIndexFields({ ...row, ...changes }));
  return db;
}

export function openWorkspaceDb(workspaceDbKey) {
  if (!workspaceDbKey) throw new Error('workspaceDbKey is required to open a workspace database');
  if (_currentWorkspaceDbKey === workspaceDbKey && _currentWorkspaceDb) {
    return _currentWorkspaceDb;
  }
  if (_currentWorkspaceDb) {
    try { _currentWorkspaceDb.close(); } catch { /* already closed */ }
  }
  _currentWorkspaceDb = createWorkspaceDb(workspaceDbKey);
  _currentWorkspaceDbKey = workspaceDbKey;
  return _currentWorkspaceDb;
}

export function getWorkspaceDb() {
  if (!_currentWorkspaceDb) throw new Error('No workspace database open — call openWorkspaceDb(workspaceDbKey) first');
  return _currentWorkspaceDb;
}

export function getSharedDb() {
  return sharedDb;
}

export function getCurrentWorkspaceDbKey() {
  return _currentWorkspaceDbKey;
}

export async function getResourceViewStates() {
  return wsDb().resource_view_states.toArray();
}

// Record-delta activity advances independently of the viewer watermark rows.
// Bulk read must include canonical attention even when no view-state row exists.
export async function getBulkReadResourceStates() {
  const db = wsDb();
  return db.transaction('r', db.resource_view_states, db.pg_resource_attention, async () => {
    const rows = new Map((await db.resource_view_states.toArray()).map(row => [row.record_id, row]));
    for (const attention of await db.pg_resource_attention.toArray()) {
      const view = rows.get(attention.record_id);
      rows.set(attention.record_id, {
        ...view,
        ...attention,
        scope_id: view?.scope_id || null,
        channel_id: attention.channel_id || view?.channel_id || null,
        activity_version: Math.max(Number(view?.activity_version || 0), Number(attention.activity_version || 0)),
        viewed_activity_version: Math.max(Number(view?.viewed_activity_version || 0), Number(attention.viewed_activity_version || 0)),
      });
    }
    return [...rows.values()];
  });
}

export async function getResourceViewState(resourceType, resourceId) {
  return wsDb().resource_view_states.get(`${resourceType}:${resourceId}`);
}

export async function upsertResourceViewState(row) {
  const incoming = sanitizeForStorage(row);
  const recordId = String(incoming?.record_id || `${incoming?.resource_type || ''}:${incoming?.resource_id || ''}`).trim();
  if (!recordId || !incoming?.resource_type || !incoming?.resource_id) {
    throw new Error('Resource view state requires resource_type and resource_id');
  }
  return wsDb().transaction('rw', wsDb().resource_view_states, wsDb().pg_resource_attention, wsDb().pg_attention_counts, async () => {
    const current = await wsDb().resource_view_states.get(recordId);
    const currentVersion = Number(current?.viewed_activity_version || 0);
    const incomingVersion = Number(incoming.viewed_activity_version || 0);
    if (current && currentVersion > incomingVersion) return current;
    const merged = {
      ...current,
      ...incoming,
      record_id: recordId,
      scope_id: incoming.scope_id || current?.scope_id || null,
      channel_id: incoming.channel_id || current?.channel_id || null,
      activity_version: Math.max(Number(current?.activity_version || 0), Number(incoming.activity_version || 0)),
      viewed_activity_version: Math.max(currentVersion, incomingVersion),
    };
    await wsDb().resource_view_states.put(merged);
    const attention = await wsDb().pg_resource_attention.get(recordId);
    if (attention?.unread && merged.viewed_activity_version >= attention.activity_version) {
      await wsDb().pg_resource_attention.update(recordId, { unread: 0, viewed_activity_version: merged.viewed_activity_version });
      const section = incoming.resource_type === 'thread' ? 'chat' : incoming.resource_type === 'task' ? 'tasks' : 'docs';
      for (const key of [`section:${section}`, ...(attention.channel_id ? [`channel:${attention.channel_id}`] : [])]) {
        const count = await wsDb().pg_attention_counts.get(key);
        await wsDb().pg_attention_counts.put({ key, count: Math.max(0, Number(count?.count || 0) - 1) });
      }
    }
    return merged;
  });
}

export async function replaceResourceViewStates(rows) {
  const incoming = Array.isArray(rows) ? rows : [];
  await wsDb().transaction('rw', wsDb().resource_view_states, async () => {
    const existing = await wsDb().resource_view_states.toArray();
    const existingById = new Map(existing.map((row) => [row.record_id, row]));
    await wsDb().resource_view_states.clear();
    for (const row of incoming) {
      const value = sanitizeForStorage(row);
      const current = existingById.get(value.record_id);
      const currentRowVersion = Number(current?.row_version || 0);
      const incomingRowVersion = Number(value?.row_version || 0);
      const currentActivityVersion = Number(current?.activity_version || 0);
      const incomingActivityVersion = Number(value?.activity_version || 0);
      const currentViewedVersion = Number(current?.viewed_activity_version || 0);
      const incomingViewedVersion = Number(value?.viewed_activity_version || 0);
      const currentIsNewer = current && (
        currentRowVersion > incomingRowVersion
        || currentActivityVersion > incomingActivityVersion
        || currentViewedVersion > incomingViewedVersion
      );
      const merged = {
        ...(currentIsNewer ? value : current),
        ...(currentIsNewer ? current : value),
        record_id: value.record_id,
        activity_version: Math.max(currentActivityVersion, incomingActivityVersion),
        viewed_activity_version: Math.max(currentViewedVersion, incomingViewedVersion),
        row_version: Math.max(currentRowVersion, incomingRowVersion),
      };
      await wsDb().resource_view_states.put(merged);
      existingById.delete(value.record_id);
    }
    for (const row of existingById.values()) {
      if (row.sync_status === 'pending') await wsDb().resource_view_states.put(row);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeForStorage(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/** Shorthand — workspace db, throws if none open. */
function wsDb() {
  // A transaction must retain its original partition across workspace switches.
  if (Dexie.currentTransaction?.db?.name?.startsWith('wingman-fd-ws-')) return Dexie.currentTransaction.db;
  if (!_currentWorkspaceDb) throw new Error('No workspace database open — call openWorkspaceDb(workspaceDbKey) first');
  return _currentWorkspaceDb;
}

export function hasWorkspaceDb() {
  return _currentWorkspaceDb !== null;
}

export function isWorkspaceDbOpenForKey(workspaceDbKey) {
  const key = String(workspaceDbKey || '').trim();
  return Boolean(key && _currentWorkspaceDb && _currentWorkspaceDbKey === key);
}

export async function deleteWorkspaceDb(workspaceDbKey) {
  if (!workspaceDbKey) throw new Error('workspaceDbKey is required to delete a workspace database');
  if (_currentWorkspaceDbKey === workspaceDbKey && _currentWorkspaceDb) {
    _currentWorkspaceDb.close();
    _currentWorkspaceDb = null;
    _currentWorkspaceDbKey = null;
  }
  const dbName = `wingman-fd-ws-${workspaceDbKey}`;
  await Dexie.delete(dbName);
}

// ---------------------------------------------------------------------------
// Migration: move app_settings from old CoworkerV4 DB into shared DB.
// Called once on first load with the new code.
// ---------------------------------------------------------------------------

export async function migrateFromLegacyDb() {
  const legacyDbName = 'CoworkerV4';
  const databases = await Dexie.getDatabaseNames();
  if (!databases.includes(legacyDbName)) return false;

  const legacyDb = new Dexie(legacyDbName);
  legacyDb.version(10).stores({
    app_settings:       '++id',
    workspace_settings: '&workspace_owner_npub, record_id, updated_at',
    storage_image_cache:'&object_id, cached_at',
    channels:           'record_id, owner_npub, *group_ids, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    chat_messages:      'record_id, channel_id, parent_message_id, sync_status, updated_at',
    groups:             'group_id, owner_npub, *member_npubs',
    documents:          'record_id, owner_npub, parent_directory_id, sync_status, updated_at, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    directories:        'record_id, owner_npub, parent_directory_id, sync_status, updated_at',
    tasks:              'record_id, owner_npub, parent_task_id, state, sync_status, updated_at, scope_id, scope_product_id, scope_project_id, scope_deliverable_id',
    comments:           'record_id, target_record_id, target_record_family_hash, parent_comment_id, updated_at',
    audio_notes:        'record_id, owner_npub, target_record_id, target_record_family_hash, transcript_status, sync_status, updated_at',
    scopes:             'record_id, owner_npub, level, parent_id, product_id, project_id, updated_at',
    schedules:          'record_id, owner_npub, active, repeat, updated_at, sync_status',
    sync_quarantine:    '&key, family_hash, family_id, record_id, last_seen_at',
    pending_writes:     '++row_id, record_id, record_family_hash, created_at',
    profiles:           'pubkey',
    address_book:       'npub, last_used_at',
    sync_state:         'key',
  });

  try {
    await legacyDb.open();

    const settings = await legacyDb.app_settings.toCollection().first();
    if (settings) {
      const { id: _id, ...rest } = settings;
      await sharedDb.app_settings.add(rest);
    }

    const profiles = await legacyDb.profiles.toArray();
    if (profiles.length > 0) {
      await sharedDb.profiles.bulkPut(profiles);
    }

    const contacts = await legacyDb.address_book.toArray();
    if (contacts.length > 0) {
      await sharedDb.address_book.bulkPut(contacts);
    }

    const images = await legacyDb.storage_image_cache.toArray();
    if (images.length > 0) {
      await sharedDb.storage_image_cache.bulkPut(images);
    }

    legacyDb.close();
    await Dexie.delete(legacyDbName);
    return true;
  } catch (error) {
    console.warn('Legacy DB migration failed, will re-sync from server:', error?.message || error);
    try { legacyDb.close(); } catch { /* ignore */ }
    try { await Dexie.delete(legacyDbName); } catch { /* ignore */ }
    return false;
  }
}

// ---------------------------------------------------------------------------
// app_settings helpers — shared DB
// ---------------------------------------------------------------------------

export async function getSettings() {
  return sharedDb.app_settings.toCollection().first();
}

export async function saveSettings(settings) {
  const sanitized = sanitizeForStorage(settings);
  const existing = await sharedDb.app_settings.toCollection().first();
  if (existing) {
    return sharedDb.app_settings.update(existing.id, sanitized);
  }
  return sharedDb.app_settings.add(sanitized);
}

// ---------------------------------------------------------------------------
// workspace_settings helpers — workspace DB
// ---------------------------------------------------------------------------

export async function getWorkspaceSettings(workspaceOwnerNpub) {
  if (!workspaceOwnerNpub) return null;
  return wsDb().workspace_settings.get(workspaceOwnerNpub);
}

export async function getWorkspaceSettingsSnapshot(workspaceDbKey, workspaceOwnerNpub) {
  if (!workspaceDbKey || !workspaceOwnerNpub) return null;
  // Reuse the already-open workspace DB when the key matches to avoid
  // creating (and schema-parsing) a throwaway Dexie instance on every call.
  if (_currentWorkspaceDbKey === workspaceDbKey && _currentWorkspaceDb) {
    try {
      return await _currentWorkspaceDb.workspace_settings.get(workspaceOwnerNpub);
    } catch {
      return null;
    }
  }
  const tempDb = createWorkspaceDb(workspaceDbKey);
  try {
    await tempDb.open();
    return await tempDb.workspace_settings.get(workspaceOwnerNpub);
  } catch {
    return null;
  } finally {
    tempDb.close();
  }
}

export async function upsertWorkspaceSettings(settings) {
  return wsDb().workspace_settings.put(sanitizeForStorage(settings));
}

// ---------------------------------------------------------------------------
// storage_image_cache helpers — shared DB
// ---------------------------------------------------------------------------

export async function getCachedStorageImage(objectId) {
  if (!objectId) return null;
  const entry = await sharedDb.storage_image_cache.get(objectId);
  if (entry) {
    // Touch cached_at so it acts as a last-accessed timestamp for LRU eviction
    sharedDb.storage_image_cache.update(objectId, { cached_at: Date.now() }).catch(() => {});
  }
  return entry;
}

export async function cacheStorageImage({ object_id, blob, content_type = '', cached_at = Date.now() }) {
  if (!object_id || !(blob instanceof Blob)) return null;
  const result = await sharedDb.storage_image_cache.put({
    object_id,
    blob,
    content_type,
    cached_at,
  });
  // Fire-and-forget eviction after caching a new entry
  evictStorageImageCache().catch(() => {});
  return result;
}

export async function evictStorageImageCache(maxEntries = 100) {
  const count = await sharedDb.storage_image_cache.count();
  if (count <= maxEntries) return 0;
  const excess = count - maxEntries;
  // sorted ascending by cached_at — oldest first
  const oldest = await sharedDb.storage_image_cache
    .orderBy('cached_at')
    .limit(excess)
    .primaryKeys();
  await sharedDb.storage_image_cache.bulkDelete(oldest);
  return oldest.length;
}

// ---------------------------------------------------------------------------
// channels — workspace DB
// ---------------------------------------------------------------------------

export async function getChannelsByOwner(ownerNpub) {
  const rows = await wsDb().channels.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function upsertChannel(channel) {
  return wsDb().channels.put(sanitizeForStorage(channel));
}

export async function upsertPgListedChannel(channel) {
  const db = wsDb();
  return db.transaction('rw', db.channels, db.pending_writes, db.pg_record_rows, async () => {
    const existing = await db.channels.get(channel.record_id);
    const canonical = await db.pg_record_rows.get(`channel:${channel.record_id}`);
    if (canonical?.operation === 'delete' || canonical?.row?.deleted_at
      || Number(canonical?.row?.row_version || 0) > Number(channel.version || 0)
      || Number(existing?.version || 0) > Number(channel.version || 0)) return existing;
    if (['pending', 'failed'].includes(existing?.sync_status) || existing?.pg_reconciliation_pending
      || await db.pending_writes.where('record_id').equals(channel.record_id).count()) return existing;
    return db.channels.put(sanitizeForStorage(channel));
  });
}

export async function replaceChannelsForOwner(ownerNpub, channels = []) {
  if (!ownerNpub) return 0;
  const rows = (Array.isArray(channels) ? channels : [])
    .map((channel) => sanitizeForStorage(channel))
    .filter((channel) => channel?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.channels, async () => {
    await db.channels.where('owner_npub').equals(ownerNpub).delete();
    if (rows.length > 0) await db.channels.bulkPut(rows);
    return rows.length;
  });
}

export async function getChannelById(recordId) {
  return wsDb().channels.get(recordId);
}

export async function deleteChannelRuntimeState(channelId) {
  if (!channelId) {
    return { deletedChannels: 0, deletedMessages: 0, deletedPendingWrites: 0 };
  }

  const db = wsDb();
  return db.transaction('rw', db.channels, db.chat_messages, db.pending_writes, async () => {
    const messageIds = (await db.chat_messages.where('channel_id').equals(channelId).primaryKeys())
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const pendingWriteRecordIds = [...new Set([channelId, ...messageIds])];
    const deletedMessages = await db.chat_messages.where('channel_id').equals(channelId).delete();
    const deletedPendingWrites = pendingWriteRecordIds.length > 0
      ? await db.pending_writes.where('record_id').anyOf(pendingWriteRecordIds).delete()
      : 0;
    const deletedChannels = await db.channels.where('record_id').equals(channelId).delete();

    return { deletedChannels, deletedMessages, deletedPendingWrites };
  });
}

// ---------------------------------------------------------------------------
// directories — workspace DB
// ---------------------------------------------------------------------------

export async function getDirectoriesByOwner(ownerNpub) {
  const rows = await wsDb().directories.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function upsertDirectory(directory) {
  return wsDb().directories.put(sanitizeForStorage(directory));
}

export async function getDirectoryById(recordId) {
  return wsDb().directories.get(recordId);
}

// ---------------------------------------------------------------------------
// documents — workspace DB
// ---------------------------------------------------------------------------

export async function getDocumentsByOwner(ownerNpub) {
  const rows = await wsDb().documents.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function upsertDocument(document) {
  const incoming = sanitizeForStorage(document);
  if (!incoming?.record_id) return null;
  const db = wsDb();
  return db.transaction('rw', db.documents, async () => {
    const current = await db.documents.get(incoming.record_id);
    const next = preserveHydratedDocumentContent(current, incoming);
    if (next === current) return current.record_id;
    return db.documents.put(next);
  });
}

export async function replaceDocumentRecord(previousRecordId, document) {
  const row = sanitizeForStorage(document);
  if (!row?.record_id) return null;
  const db = wsDb();
  return db.transaction('rw', db.documents, async () => {
    const previousId = String(previousRecordId || '').trim();
    if (previousId && previousId !== row.record_id) {
      await db.documents.delete(previousId);
    }
    await db.documents.put(row);
    return row.record_id;
  });
}

export async function replaceDocumentsForOwner(ownerNpub, documents = []) {
  if (!ownerNpub) return 0;
  const rows = (Array.isArray(documents) ? documents : [])
    .map((document) => sanitizeForStorage(document))
    .filter((document) => document?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.documents, async () => {
    await db.documents.where('owner_npub').equals(ownerNpub).delete();
    if (rows.length > 0) await db.documents.bulkPut(rows);
    return rows.length;
  });
}

export async function replacePgDocumentsForChannel(channelId, documents = []) {
  if (!channelId) return 0;
  const incomingRows = (Array.isArray(documents) ? documents : [])
    .map((document) => sanitizeForStorage(document))
    .filter((document) => document?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.documents, async () => {
    const existing = await db.documents.toArray();
    const existingById = new Map(existing.map((document) => [document?.record_id, document]));
    const rows = incomingRows.map((document) => {
      const cached = existingById.get(document.record_id);
      return preserveHydratedDocumentContent(cached, document);
    });
    const pgDocumentIds = existing
      .filter((document) => document?.pg_backend === true && document?.pg_channel_id === channelId)
      .map((document) => document.record_id)
      .filter(Boolean);
    if (pgDocumentIds.length > 0) await db.documents.bulkDelete(pgDocumentIds);
    if (rows.length > 0) await db.documents.bulkPut(rows);
    return rows.length;
  });
}

export async function getDocumentById(recordId) {
  return wsDb().documents.get(recordId);
}

export function documentDraftKey(workspaceId, documentId) {
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  const normalizedDocumentId = String(documentId || '').trim();
  return normalizedWorkspaceId && normalizedDocumentId
    ? `${normalizedWorkspaceId}:${normalizedDocumentId}`
    : '';
}

export async function getDocumentDraft(workspaceId, documentId) {
  const draftKey = documentDraftKey(workspaceId, documentId);
  if (!draftKey || !_currentWorkspaceDb) return null;
  return wsDb().document_drafts.get(draftKey);
}

export async function upsertDocumentDraft(draft = {}) {
  const workspaceId = String(draft?.workspace_id || '').trim();
  const documentId = String(draft?.document_id || '').trim();
  const draftKey = documentDraftKey(workspaceId, documentId);
  if (!draftKey) throw new Error('Document draft requires workspace_id and document_id');
  const row = sanitizeForStorage({
    ...draft,
    draft_key: draftKey,
    workspace_id: workspaceId,
    document_id: documentId,
    updated_at: draft.updated_at || new Date().toISOString(),
  });
  if (!_currentWorkspaceDb) return row;
  await wsDb().document_drafts.put(row);
  return row;
}

export async function deleteDocumentDraft(workspaceId, documentId) {
  const draftKey = documentDraftKey(workspaceId, documentId);
  if (!draftKey || !_currentWorkspaceDb) return false;
  await wsDb().document_drafts.delete(draftKey);
  return true;
}

// ---------------------------------------------------------------------------
// file_folders — workspace DB
// ---------------------------------------------------------------------------

export async function getFileFoldersByWorkspace(workspaceId) {
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  if (!normalizedWorkspaceId) return [];
  const rows = await wsDb().file_folders.where('workspace_id').equals(normalizedWorkspaceId).toArray();
  return sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'), 'updated_at');
}

export async function upsertFileFolder(folder) {
  const row = sanitizeForStorage(folder);
  if (!row?.record_id) return null;
  await wsDb().file_folders.put(row);
  return row.record_id;
}

export async function replaceFileFoldersForWorkspace(workspaceId, folders = []) {
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  if (!normalizedWorkspaceId) return 0;
  const rows = (Array.isArray(folders) ? folders : [])
    .map((folder) => sanitizeForStorage(folder))
    .filter((folder) => folder?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.file_folders, async () => {
    await db.file_folders.where('workspace_id').equals(normalizedWorkspaceId).delete();
    if (rows.length > 0) await db.file_folders.bulkPut(rows);
    return rows.length;
  });
}

export async function replacePgFileFoldersForChannel(channelId, folders = []) {
  const normalizedChannelId = String(channelId || '').trim();
  if (!normalizedChannelId) return 0;
  const rows = (Array.isArray(folders) ? folders : [])
    .map((folder) => sanitizeForStorage(folder))
    .filter((folder) => folder?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.file_folders, async () => {
    await db.file_folders.where('channel_id').equals(normalizedChannelId).delete();
    if (rows.length > 0) await db.file_folders.bulkPut(rows);
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// chat_messages — workspace DB
// ---------------------------------------------------------------------------

export async function getMessagesByChannel(channelId, options = {}) {
  const rows = await wsDb().chat_messages.where('channel_id').equals(channelId).sortBy('updated_at');
  const activeRows = rows.filter((row) => row.record_state !== 'deleted');
  if (!options.limit) return activeRows;
  return takeWindow(activeRows, resolveWindowLimit('chatMessages', options), { fromStart: false });
}

export async function getMessagePresentationWindowByChannel(channelId, options = {}) {
  const normalizedChannelId = String(channelId || '').trim();
  if (!normalizedChannelId) return [];
  const rootLimit = Math.max(1, Number(options.rootLimit) || 80);
  const db = wsDb();
  let recentRows = await db.chat_messages
    .where('[channel_id+cache_active+cache_parent+cache_time+record_id]')
    .between([normalizedChannelId, 1, '', Dexie.minKey, Dexie.minKey],
      options.before ? [normalizedChannelId, 1, '', options.before.timestamp, options.before.recordId]
        : [normalizedChannelId, 1, '', '\uffff', Dexie.maxKey], true, !options.before)
    .reverse().limit(rootLimit + 1).toArray();
  // A recent thread title can refer to a source older than this bounded page.
  // Fetch only those exact source IDs, retaining the history metadata row.
  const sourceIds = [...new Set(recentRows.filter(row => row.pg_record_type === 'thread')
    .map(row => row.pg_source_message_id).filter(Boolean))];
  if (sourceIds.length) {
    const sources = (await db.chat_messages.bulkGet(sourceIds)).filter(row => row
      && row.channel_id === normalizedChannelId && row.record_state !== 'deleted');
    recentRows = [...new Map([...recentRows, ...sources].map(row => [row.record_id, row])).values()];
  }
  const rootIds = recentRows.map((row) => row.record_id);
  const replyRootIds = [...new Set([...recentRows.map(row => row.pg_thread_id || row.record_id), options.activeThreadId].filter(Boolean))];
  const [replyPages, unsynced, focused] = await Promise.all([
    Promise.all(replyRootIds.map((rootId) => db.chat_messages
      .where('[cache_parent+cache_active+cache_time+record_id]')
      .between([rootId, 1, Dexie.minKey, Dexie.minKey], [rootId, 1, '\uffff', Dexie.maxKey])
      .reverse().limit(Math.max(1, Number(options.replyLimit) || 80) + 1).toArray())),
    db.chat_messages.where('[channel_id+sync_status]')
      .anyOf([[normalizedChannelId, 'pending'], [normalizedChannelId, 'failed']]).limit(rootLimit).toArray(),
    db.chat_messages.bulkGet([...new Set([options.activeThreadId, options.focusMessageId].filter(Boolean))]),
  ]);
  const replies = replyPages.flat();
  const focusedRows = focused.filter(Boolean);
  for (const parentKey of new Set(focusedRows.map(row => row.pg_thread_id).filter(id => id && !replyRootIds.includes(id)))) {
    replies.push(...await db.chat_messages.where('[cache_parent+cache_active+cache_time+record_id]')
      .between([parentKey, 1, Dexie.minKey, Dexie.minKey], [parentKey, 1, '\uffff', Dexie.maxKey])
      .reverse().limit(Math.max(1, Number(options.replyLimit) || 80) + 1).toArray());
  }
  const effectiveMessageIds = [...new Set(focusedRows.flatMap((row) => (
    Array.isArray(row?.pg_effective_message_ids) ? row.pg_effective_message_ids.slice(-(Math.max(1, Number(options.replyLimit) || 80) + 1)).map(String) : []
  )).filter(Boolean))];
  const effectiveRows = effectiveMessageIds.length
    ? (await db.chat_messages.bulkGet(effectiveMessageIds.slice(-(Math.max(1, Number(options.replyLimit) || 80) + 1)))).filter(Boolean)
    : [];
  const focusedRootIds = [...focusedRows, ...unsynced]
    .map((row) => String(row.parent_message_id || '').trim())
    .filter((recordId) => recordId && !rootIds.includes(recordId));
  const focusedRoots = focusedRootIds.length
    ? (await db.chat_messages.bulkGet(focusedRootIds)).filter(Boolean)
    : [];
  const rowsById = new Map();
  for (const row of [...recentRows, ...replies, ...unsynced, ...focusedRows, ...focusedRoots, ...effectiveRows]) {
    if (row?.record_id && row.channel_id === normalizedChannelId) rowsById.set(row.record_id, row);
  }
  const rootsByThread = new Map([...rowsById.values()].filter(row => !row.parent_message_id && row.pg_thread_id)
    .sort((a, b) => Number(a.pg_record_type === 'message') - Number(b.pg_record_type === 'message'))
    .map(row => [row.pg_thread_id, row.record_id]));
  const presentationRows = [...rowsById.values()].map(row => row.parent_message_id && rootsByThread.has(row.pg_thread_id)
    ? { ...row, parent_message_id: rootsByThread.get(row.pg_thread_id) } : row);
  return buildThreadAwarePresentationWindow(presentationRows, { ...options, rootLimit: rootLimit + 1 });
}

// A thread detail must not inherit the selected channel or Inbox source window.
// Each parent key reads only the explicitly requested prefix plus one lookahead.
export async function getThreadMessagePresentationWindow(channelId, rootId, options = {}) {
  const db = wsDb();
  const root = await db.chat_messages.get(rootId);
  const threadId = String(options.threadId || root?.pg_thread_id || rootId || '').trim();
  const thread = threadId === rootId ? root : await db.chat_messages.get(threadId);
  const limit = Math.max(1, Number(options.replyLimit) || 6) + 1;
  const keys = [...new Set([threadId, rootId].filter(Boolean))];
  const pages = await Promise.all(keys.map(key => db.chat_messages
    .where('[cache_parent+cache_active+cache_time+record_id]')
    .between([key, 1, Dexie.minKey, Dexie.minKey], [key, 1, '\uffff', Dexie.maxKey])
    .reverse().limit(limit).toArray()));
  const coverage = await db.sync_state.get(`thread-history-page:${threadId}`);
  const lineage = threadHistoryLineage(thread);
  const effectiveIds = mergeThreadHistoryIds(thread?.pg_effective_message_ids || [],
    coverage?.value?.lineage === lineage ? coverage.value.messageIds : []).slice(-limit);
  const effective = effectiveIds.length ? await db.chat_messages.bulkGet(effectiveIds) : [];
  const clampedEffectiveIds = clampBranchEffectiveMessageIds(effectiveIds, effective.filter(Boolean), thread);
  const sourceId = thread?.pg_source_message_id;
  const source = sourceId && sourceId !== rootId ? await db.chat_messages.get(sourceId) : null;
  const parent = root || thread;
  if (thread?.record_state === 'deleted') return [];
  if (!parent || parent.channel_id !== channelId || parent.record_state === 'deleted') return [];
  const candidates = [...pages.flat(), ...effective, source].filter(Boolean);
  const authority = await db.pg_record_rows.bulkGet([`thread:${threadId}`, `channel:${channelId}`, ...candidates.map(row => `message:${row.record_id}`)]);
  const revoked = record => record && (record.operation === 'delete' || record.row?.deleted_at);
  if (revoked(authority[0]) || revoked(authority[1])) return [];
  const rows = new Map();
  for (const [index, row] of candidates.entries()) {
    if (revoked(authority[index + 2])) continue;
    // Indexed own-thread replies remain live; inherited rows require membership.
    if (row.pg_thread_id && row.pg_thread_id !== threadId && !clampedEffectiveIds.includes(row.record_id)) continue;
    if (!row || row.channel_id !== channelId || row.record_state === 'deleted' || row.record_id === rootId) continue;
    rows.set(row.record_id, { ...row, parent_message_id: rootId });
  }
  return [parent, ...[...rows.values()].sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || ''))
    || String(a.record_id).localeCompare(String(b.record_id))).slice(-limit)];
}

export async function getMessagesByChannels(channelIds = [], options = {}) {
  const ids = [...new Set(
    (Array.isArray(channelIds) ? channelIds : [])
      .map((channelId) => String(channelId || '').trim())
      .filter(Boolean),
  )];
  if (ids.length === 0) return [];
  const rows = await wsDb().chat_messages.where('channel_id').anyOf(ids).toArray();
  const activeRows = rows
    .filter((row) => row.record_state !== 'deleted')
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
  if (!options.limit) return activeRows;
  return takeWindow(activeRows, resolveWindowLimit('chatMessages', options), { fromStart: false });
}

export async function getMessagePresentationWindowByChannels(channelIds = [], options = {}) {
  const ids = [...new Set(channelIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const pages = await Promise.all(ids.map((id) => getMessagePresentationWindowByChannel(id, options)));
  return buildThreadAwarePresentationWindow(pages.flat(), options);
}

export async function getMessagesByOwner(ownerNpub) {
  const channels = await getChannelsByOwner(ownerNpub);
  const channelIds = channels.map((channel) => channel.record_id).filter(Boolean);
  if (channelIds.length === 0) return [];
  const rows = await wsDb().chat_messages.where('channel_id').anyOf(channelIds).toArray();
  return rows
    .filter((row) => row.record_state !== 'deleted')
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
}

export async function upsertMessage(msg) {
  return wsDb().chat_messages.put(sanitizeForStorage(msg));
}

// Late send completions must never select the workspace that happens to be
// active when the response arrives. Use a separate connection and transaction
// so existing message helpers resolve wsDb() to the captured partition.
export async function withWorkspaceMessageTransaction(workspaceDbKey, operation) {
  if (!workspaceDbKey) throw new Error('Message workspace database key is required');
  const db = createWorkspaceDb(workspaceDbKey);
  try {
    await db.open();
    return await db.transaction('rw', db.chat_messages, operation);
  } finally {
    db.close();
  }
}

export async function updateExistingMessageSyncStatus(recordId, syncStatus) {
  const db = wsDb();
  return db.transaction('rw', db.chat_messages, async () => {
    const row = await db.chat_messages.get(recordId);
    if (!row) return null; // An SSE acknowledgement may already have replaced it.
    await db.chat_messages.update(recordId, { sync_status: syncStatus });
    return { ...row, sync_status: syncStatus };
  });
}

export async function deleteMessageRuntimeState(recordId) {
  const normalizedRecordId = String(recordId || '').trim();
  if (!normalizedRecordId) return 0;
  return wsDb().chat_messages.delete(normalizedRecordId);
}

// Local identity edges only: never rewrite the signed body or outbound command.
export async function reconcilePgMessageIdentity(db, accepted, previousId = '') {
  if (accepted.pg_record_type === 'thread' && accepted.pg_source_message_id && !Array.isArray(accepted.pg_effective_message_ids)) {
    const source = await db.chat_messages.get(accepted.pg_source_message_id);
    if (source?.pg_record_type === 'message' && source.channel_id === accepted.channel_id
      && source.pg_thread_id === accepted.record_id && !source.parent_message_id
      && source.record_state !== 'deleted') await db.chat_messages.delete(accepted.record_id);
  }
  if (accepted.pg_record_type !== 'message' || accepted.parent_message_id || !accepted.pg_thread_id) return;
  const placeholder = await db.chat_messages.get(accepted.pg_thread_id);
  if (placeholder?.pg_record_type === 'thread' && !Array.isArray(placeholder.pg_effective_message_ids) && placeholder.channel_id === accepted.channel_id
    && placeholder.pg_source_message_id === accepted.record_id) {
    await db.chat_messages.delete(placeholder.record_id);
  }
  if (previousId && previousId !== accepted.record_id) {
    await db.chat_messages.where('parent_message_id').equals(previousId)
      .filter(reply => reply.channel_id === accepted.channel_id)
      .modify({ parent_message_id: accepted.record_id, pg_thread_id: accepted.pg_thread_id });
  }
}

export async function replaceMessageRecord(previousRecordId, msg) {
  const row = sanitizeForStorage(msg);
  if (!row?.record_id) return null;
  const db = wsDb();
  return db.transaction('rw', db.chat_messages, async () => {
    const previousId = String(previousRecordId || '').trim();
    if (previousId && previousId !== row.record_id) {
      await db.chat_messages.delete(previousId);
    }
    const canonical = await db.chat_messages.get(row.record_id);
    // SSE can acknowledge (or edit) the message before its POST returns.
    // An already materialized canonical revision wins over that delayed ack.
    const canonicalWins = row.pg_reconciliation_pending === true && canonical
      && (Number(canonical.version || 0) > Number(row.version || 0)
        || (canonical.pg_delta_family === 'message' && Number(canonical.version || 0) >= Number(row.version || 0)));
    if (!canonicalWins) await db.chat_messages.put(row);
    const accepted = canonicalWins ? canonical : row;
    await reconcilePgMessageIdentity(db, accepted, previousId);
    return row.record_id;
  });
}

export async function replacePgThreadsForChannel(channelId, messages = []) {
  if (!channelId) return 0;
  const rows = (Array.isArray(messages) ? messages : [])
    .map((message) => sanitizeForStorage(message))
    .filter((message) => message?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.chat_messages, async () => {
    const existing = await db.chat_messages.where('channel_id').equals(channelId).toArray();
    const pgThreadIds = existing
      .filter((message) => message?.pg_record_type === 'thread')
      .map((message) => message.record_id)
      .filter(Boolean);
    if (pgThreadIds.length > 0) await db.chat_messages.bulkDelete(pgThreadIds);
    if (rows.length > 0) await db.chat_messages.bulkPut(rows);
    for (const row of rows) await reconcilePgMessageIdentity(db, row);
    return rows.length;
  });
}

export async function replacePgMessagesForChannel(channelId, messages = [], options = {}) {
  if (!channelId) return 0;
  const rows = (Array.isArray(messages) ? messages : [])
    .map((message) => sanitizeForStorage(message))
    .filter((message) => message?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.chat_messages, db.pending_writes, db.pg_record_rows, async () => {
    const incomingIds = [...new Set(rows.flatMap((row) => [row.record_id, row.pg_client_record_id]).filter(Boolean))];
    const clientIds = [...new Set(rows.map((row) => row.pg_client_record_id).filter(Boolean))];
    const existing = options.authoritative === true
      ? await db.chat_messages.where('channel_id').equals(channelId).toArray()
      : [...new Map([
        ...(await db.chat_messages.bulkGet(incomingIds)).filter(Boolean),
        ...(clientIds.length ? await db.chat_messages.where('pg_client_record_id').anyOf(clientIds).toArray() : []),
      ].filter((row) => row.channel_id === channelId).map((row) => [row.record_id, row])).values()];
    const commandIds = new Set((existing.length ? await db.pending_writes.where('record_id').anyOf(existing.map(row => row.record_id)).toArray() : []).map(row => row.record_id));
    const blockedClients = new Set(existing.filter(local => {
      const ack = rows.find(row => row.pg_client_record_id === (local.pg_client_record_id || local.record_id));
      return ack && (commandIds.has(local.record_id) || Number(local.version || 0) > Number(ack.version || 0));
    }).map(row => row.pg_client_record_id || row.record_id));
    const authoritativeClientIds = new Set(rows
      .map((message) => String(message?.pg_client_record_id || '').trim())
      .filter(Boolean));
    const reconciledRows = rows.filter(row => !blockedClients.has(row.pg_client_record_id)).map((message) => {
      const clientRecordId = String(message?.pg_client_record_id || '').trim();
      if (!clientRecordId) return message;
      const { pg_reconciliation_pending, ...reconciled } = message;
      return reconciled;
    });
    const protectedIds = new Set(existing
      .filter((message) => (
        message?.sync_status === 'pending'
        || message?.sync_status === 'failed'
        || message?.pg_reconciliation_pending === true
      ))
      .filter((message) => {
        const clientRecordId = String(message?.pg_client_record_id || message?.record_id || '').trim();
        return !authoritativeClientIds.has(clientRecordId);
      })
      .map((message) => message.record_id)
      .filter(Boolean));
    for (const row of existing) {
      if (commandIds.has(row.record_id) || blockedClients.has(row.pg_client_record_id || row.record_id)) protectedIds.add(row.record_id);
    }
    const reconciledClientIds = new Set(reconciledRows
      .map((message) => String(message?.pg_client_record_id || '').trim())
      .filter(Boolean));
    const reconciledRecordIds = new Set(reconciledRows.map((message) => message.record_id));
    const supersededOptimisticIds = existing
      .filter((message) => {
        const clientRecordId = String(message?.pg_client_record_id || message?.record_id || '').trim();
        return !protectedIds.has(message.record_id) && clientRecordId
          && reconciledClientIds.has(clientRecordId)
          && !reconciledRecordIds.has(message.record_id);
      })
      .map((message) => message.record_id)
      .filter(Boolean);
    const omittedIds = options.authoritative === true
      ? existing
        .filter((message) => message?.pg_backend === true)
        .map((message) => message.record_id)
        .filter((recordId) => recordId && !protectedIds.has(recordId) && !reconciledRecordIds.has(recordId))
      : [];
    const deleteIds = [...new Set([...supersededOptimisticIds, ...omittedIds])];
    const existingById = new Map(existing.map((message) => [message.record_id, message]));
    const canonical = await db.pg_record_rows.bulkGet(reconciledRows.map(row => `${row.pg_record_type === 'thread' ? 'thread' : 'message'}:${row.record_id}`));
    const changedRows = reconciledRows.filter((message, index) => (
      canonical[index]?.operation !== 'delete' && !canonical[index]?.row?.deleted_at
      && Number(canonical[index]?.row?.row_version || 0) <= Number(message.version || 0)
      &&
      Number(existingById.get(message.record_id)?.version || 0) <= Number(message.version || 0)
      && !protectedIds.has(message.record_id)
      && !sameLogicalValue(existingById.get(message.record_id), { ...message, ...messageIndexFields(message) })
    ));
    if (deleteIds.length > 0) await db.chat_messages.bulkDelete(deleteIds);
    if (changedRows.length > 0) await db.chat_messages.bulkPut(changedRows);
    for (const row of changedRows) {
      if ((!row.parent_message_id && row.pg_thread_id) || row.pg_source_message_id) {
        await reconcilePgMessageIdentity(db, row, row.pg_client_record_id);
      }
    }
    return changedRows.length + deleteIds.length;
  });
}

export async function getMessageById(recordId) {
  const row = await wsDb().chat_messages.get(recordId);
  if (!row) return row;
  const { cache_active, cache_parent, cache_time, cache_recent, cache_has_files, ...message } = row;
  return message;
}

export async function getRecentChatMessagesSince(sinceIso, options = {}) {
  const rows = await wsDb().chat_messages.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeWindow(ordered, resolveWindowLimit('chatMessages', options), { fromStart: true });
}

export async function getRecentDocumentChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().documents.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('documents', options));
}

export async function getRecentDirectoryChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().directories.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('directories', options));
}

// ---------------------------------------------------------------------------
// reports — workspace DB
// ---------------------------------------------------------------------------

export async function getReportsByOwner(ownerNpub) {
  const rows = await wsDb().reports.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getRecentReportChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().reports.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('reports', options));
}

export async function upsertReport(report) {
  return wsDb().reports.put(sanitizeForStorage(report));
}

export async function getReportById(recordId) {
  return wsDb().reports.get(recordId);
}

// ---------------------------------------------------------------------------
// daily notes — workspace DB
// ---------------------------------------------------------------------------

export async function getDailyNotesByOwner(ownerNpub) {
  const rows = await wsDb().daily_notes.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getDailyNotesForOwnerAndDate(ownerNpub, noteDate) {
  const rows = await wsDb().daily_notes
    .where('owner_npub').equals(ownerNpub)
    .toArray();

  const date = String(noteDate || '').trim();
  if (!date) return rows.filter((row) => row.record_state !== 'deleted');

  return rows
    .filter((row) => row.record_state !== 'deleted' && String(row.note_date || '').trim() === date);
}

export async function getRecentDailyNoteChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().daily_notes.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('daily_notes', options));
}

export async function upsertDailyNote(dailyNote) {
  return wsDb().daily_notes.put(sanitizeForStorage(dailyNote));
}

export async function replaceDailyNotesForOwner(ownerNpub, dailyNotes = []) {
  if (!ownerNpub) return 0;
  const rows = (Array.isArray(dailyNotes) ? dailyNotes : [])
    .map((dailyNote) => sanitizeForStorage(dailyNote))
    .filter((dailyNote) => dailyNote?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.daily_notes, async () => {
    await db.daily_notes.where('owner_npub').equals(ownerNpub).delete();
    if (rows.length > 0) await db.daily_notes.bulkPut(rows);
    return rows.length;
  });
}

export async function replacePgDailyNotesForOwnerAndDate(ownerActorId, noteDate, dailyNotes = []) {
  if (!ownerActorId || !noteDate) return 0;
  const rows = (Array.isArray(dailyNotes) ? dailyNotes : [])
    .map((dailyNote) => sanitizeForStorage(dailyNote))
    .filter((dailyNote) => dailyNote?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.daily_notes, async () => {
    const existing = await db.daily_notes.toArray();
    const pgDailyNoteIds = existing
      .filter((dailyNote) =>
        dailyNote?.pg_backend === true
        && String(dailyNote?.owner_actor_id || dailyNote?.pg_owner_actor_id || '') === ownerActorId
        && dailyNote?.note_date === noteDate
      )
      .map((dailyNote) => dailyNote.record_id)
      .filter(Boolean);
    if (pgDailyNoteIds.length > 0) await db.daily_notes.bulkDelete(pgDailyNoteIds);
    if (rows.length > 0) await db.daily_notes.bulkPut(rows);
    return rows.length;
  });
}

export const replacePgDailyNotesForChannelAndDate = replacePgDailyNotesForOwnerAndDate;

export async function getDailyNoteById(recordId) {
  return wsDb().daily_notes.get(recordId);
}

// ---------------------------------------------------------------------------
// wapps — workspace DB
// ---------------------------------------------------------------------------

export async function upsertWapp(wapp) {
  return wsDb().wapps.put(sanitizeForStorage(wapp));
}

export async function getWappsByOwner(ownerNpub) {
  const db = wsDb();
  const [workspaceRows, ownerRows] = await Promise.all([
    db.wapps.where('workspace_owner_npub').equals(ownerNpub).toArray(),
    db.wapps.where('owner_npub').equals(ownerNpub).toArray(),
  ]);
  const rowsById = new Map([...workspaceRows, ...ownerRows].map((row) => [row.record_id, row]));
  return [...rowsById.values()].filter((row) => row.record_state !== 'archived' && row.record_state !== 'deleted' && row.status !== 'archived');
}

export async function getManageableWappsByOwner(ownerNpub) {
  const db = wsDb();
  const [workspaceRows, ownerRows] = await Promise.all([
    db.wapps.where('workspace_owner_npub').equals(ownerNpub).toArray(),
    db.wapps.where('owner_npub').equals(ownerNpub).toArray(),
  ]);
  const rowsById = new Map([...workspaceRows, ...ownerRows].map((row) => [row.record_id, row]));
  return sortRowsByTimestamp([...rowsById.values()].filter((row) => row.record_state !== 'deleted'));
}

export async function replacePgPersonalWappsForOwner(ownerActorId, personalWapps = []) {
  const db = wsDb();
  const rows = (Array.isArray(personalWapps) ? personalWapps : [])
    .map((wapp) => sanitizeForStorage(wapp))
    .filter((wapp) => wapp?.record_id);
  return db.transaction('rw', db.wapps, async () => {
    const existing = await db.wapps.toArray();
    const existingRows = existing
      .filter((wapp) =>
        wapp?.pg_backend === true
        && wapp?.pg_record_type === 'personal_wapp'
        && String(wapp?.owner_actor_id || wapp?.pg_owner_actor_id || '') === ownerActorId
      );
    const incomingIds = new Set(rows.map((wapp) => wapp.record_id));
    const existingById = new Map(existingRows.map((wapp) => [wapp.record_id, wapp]));
    const deleteIds = existingRows.map((wapp) => wapp.record_id).filter((id) => id && !incomingIds.has(id));
    const changedRows = rows.filter((wapp) => !sameLogicalValue(existingById.get(wapp.record_id), wapp));
    if (deleteIds.length > 0) await db.wapps.bulkDelete(deleteIds);
    if (changedRows.length > 0) await db.wapps.bulkPut(changedRows);
    return rows.length;
  });
}

export async function getPgPersonalWappsByOwnerActor(ownerActorId) {
  const rows = await wsDb().wapps.toArray();
  return rows
    .filter((row) =>
      row?.pg_backend === true
      && row?.pg_record_type === 'personal_wapp'
      && String(row?.owner_actor_id || row?.pg_owner_actor_id || '') === ownerActorId
      && row.record_state !== 'archived'
      && row.record_state !== 'deleted'
      && row.status !== 'archived'
    )
    .sort((a, b) => {
      const orderDelta = Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0);
      if (orderDelta !== 0) return orderDelta;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
}

export async function getWappById(recordId) {
  return wsDb().wapps.get(recordId);
}

export async function getRecentWappChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().wapps.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'archived' && row.record_state !== 'deleted' && row.status !== 'archived'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('wapps', options));
}

// ---------------------------------------------------------------------------
// WApp publishing grants/activity — Tower PG materialized cache
// ---------------------------------------------------------------------------

export async function replaceWappPublishingGrants(grants = []) {
  const db = wsDb();
  const rows = (Array.isArray(grants) ? grants : [])
    .map((grant) => sanitizeForStorage(grant))
    .filter((grant) => String(grant?.wapp_installation_id || '').trim());
  return db.transaction('rw', db.wapp_publishing_grants, async () => {
    return reconcileAuthoritativeRows(db.wapp_publishing_grants, rows, 'wapp_installation_id');
  });
}

export async function upsertWappPublishingGrant(grant) {
  const row = sanitizeForStorage(grant);
  if (!String(row?.wapp_installation_id || '').trim()) throw new Error('WApp publishing grant requires wapp_installation_id');
  await wsDb().wapp_publishing_grants.put(row);
  return row;
}

export async function getWappPublishingGrants() {
  return wsDb().wapp_publishing_grants.toArray();
}

async function reconcileAuthoritativeRows(table, rows, keyField) {
  const existing = await table.toArray();
  const incomingIds = new Set(rows.map((row) => String(row?.[keyField] || '').trim()).filter(Boolean));
  const existingById = new Map(existing.map((row) => [String(row?.[keyField] || '').trim(), row]));
  const deleteIds = existing
    .map((row) => String(row?.[keyField] || '').trim())
    .filter((id) => id && !incomingIds.has(id));
  const changedRows = rows.filter((row) => {
    const id = String(row?.[keyField] || '').trim();
    return !sameLogicalValue(existingById.get(id), row);
  });
  if (deleteIds.length > 0) await table.bulkDelete(deleteIds);
  if (changedRows.length > 0) await table.bulkPut(changedRows);
  return rows;
}

export async function getWorkspaceMembers(workspaceId) {
  const rows = workspaceId
    ? await wsDb().workspace_members.where('workspace_id').equals(workspaceId).toArray()
    : await wsDb().workspace_members.toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function replaceWorkspaceMembers(workspaceId, members = []) {
  if (!workspaceId) return [];
  const db = wsDb();
  const rows = (Array.isArray(members) ? members : [])
    .map((member) => sanitizeForStorage({ ...member, workspace_id: workspaceId }))
    .filter((member) => String(member?.actor_id || '').trim());
  return db.transaction('rw', db.workspace_members, async () => {
    const existing = await db.workspace_members.where('workspace_id').equals(workspaceId).toArray();
    const incomingIds = new Set(rows.map((row) => row.actor_id));
    const deleteIds = existing.filter((row) => !incomingIds.has(row.actor_id)).map((row) => row.actor_id);
    const existingById = new Map(existing.map((row) => [row.actor_id, row]));
    const changedRows = rows.filter((row) => !sameLogicalValue(existingById.get(row.actor_id), row));
    if (deleteIds.length > 0) await db.workspace_members.bulkDelete(deleteIds);
    if (changedRows.length > 0) await db.workspace_members.bulkPut(changedRows);
    return rows;
  });
}

export async function replaceWappActivityItems(items = [], options = {}) {
  const db = wsDb();
  const rows = (Array.isArray(items) ? items : [])
    .map((item) => sanitizeForStorage(item))
    .filter((item) => String(item?.record_id || '').trim());
  return db.transaction('rw', db.wapp_activity_items, async () => {
    if (options.authoritative === false) {
      if (rows.length > 0) await db.wapp_activity_items.bulkPut(rows);
      return rows;
    }
    return reconcileAuthoritativeRows(db.wapp_activity_items, rows, 'record_id');
  });
}

export async function upsertWappActivityItem(item) {
  const row = sanitizeForStorage(item);
  if (!String(row?.record_id || '').trim()) throw new Error('WApp activity item requires record_id');
  await wsDb().wapp_activity_items.put(row);
  return row;
}

export async function getWappActivityItems() {
  return wsDb().wapp_activity_items.orderBy('occurred_at').reverse().toArray();
}

export async function replaceWappActivityMutes(mutes = []) {
  const db = wsDb();
  const rows = (Array.isArray(mutes) ? mutes : [])
    .map((mute) => sanitizeForStorage(mute))
    .filter((mute) => String(mute?.record_id || '').trim());
  return db.transaction('rw', db.wapp_activity_mutes, async () => {
    return reconcileAuthoritativeRows(db.wapp_activity_mutes, rows, 'record_id');
  });
}

export async function getWappActivityMutes() {
  return wsDb().wapp_activity_mutes.toArray();
}

export async function deleteWappActivityMute(recordId) {
  const id = String(recordId || '').trim();
  if (!id) return;
  await wsDb().wapp_activity_mutes.delete(id);
}

export async function upsertWappActivityMute(mute) {
  const row = sanitizeForStorage(mute);
  if (!String(row?.record_id || '').trim()) throw new Error('WApp activity mute requires record_id');
  await wsDb().wapp_activity_mutes.put(row);
  return row;
}

export async function getWappActivityProjection() {
  const [items, mutes] = await Promise.all([
    getWappActivityItems(),
    getWappActivityMutes(),
  ]);
  const mutedTargets = new Set(mutes.map((mute) => `${mute?.target_type}:${mute?.target_value}`));
  const projectedItems = items.map((item) => ({
    ...item,
    muted: item?.muted === true
      || mutedTargets.has(`installation:${item?.wapp_installation_id}`)
      || mutedTargets.has(`category:${item?.category}`),
  }));
  const unread = projectedItems.filter((item) => item.unread === true && !item.dismissed_at && item.muted !== true).length;
  return { items: projectedItems, counts: { unread }, mutes };
}

// ---------------------------------------------------------------------------
// groups — workspace DB
// ---------------------------------------------------------------------------

export async function getGroupsByOwner(ownerNpub) {
  return wsDb().groups.where('owner_npub').equals(ownerNpub).toArray();
}

export async function getAllGroups() {
  return wsDb().groups.toArray();
}

export async function upsertGroup(group) {
  return wsDb().groups.put(sanitizeForStorage(group));
}

export async function deleteGroupById(groupId) {
  return wsDb().groups.delete(groupId);
}

// ---------------------------------------------------------------------------
// address book — shared DB
// ---------------------------------------------------------------------------

export async function upsertAddressBookPerson(entry) {
  const existing = await sharedDb.address_book.get(entry.npub);
  const merged = {
    npub: entry.npub,
    label: entry.label ?? existing?.label ?? null,
    avatar_url: entry.avatar_url ?? existing?.avatar_url ?? null,
    bio: entry.bio ?? entry.about ?? existing?.bio ?? null,
    nip05: entry.nip05 ?? existing?.nip05 ?? null,
    source: entry.source ?? existing?.source ?? 'unknown',
    last_used_at: entry.last_used_at ?? new Date().toISOString(),
  };
  return sharedDb.address_book.put(merged);
}

export async function getAddressBookPeople(query = '') {
  const all = await sharedDb.address_book.orderBy('last_used_at').reverse().toArray();
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return all;

  return all.filter((entry) =>
    String(entry.npub || '').toLowerCase().includes(needle)
    || String(entry.label || '').toLowerCase().includes(needle)
    || String(entry.nip05 || '').toLowerCase().includes(needle)
  );
}

// ---------------------------------------------------------------------------
// profiles — shared DB
// ---------------------------------------------------------------------------

const PROFILE_CACHE_HOURS = 24;

export async function cacheProfile(pubkey, profile) {
  return sharedDb.profiles.put({
    pubkey,
    profile: sanitizeForStorage(profile),
    cachedAt: Date.now(),
  });
}

export async function getCachedProfile(pubkey) {
  const row = await sharedDb.profiles.get(pubkey);
  if (!row) return null;

  const maxAge = PROFILE_CACHE_HOURS * 60 * 60 * 1000;
  if (Date.now() - row.cachedAt > maxAge) {
    await sharedDb.profiles.delete(pubkey);
    return null;
  }

  return row.profile;
}

export async function clearCachedProfiles(pubkeys = null) {
  if (!Array.isArray(pubkeys)) {
    await sharedDb.profiles.clear();
    return;
  }
  const uniquePubkeys = [...new Set(pubkeys.map((pubkey) => String(pubkey || '').trim()).filter(Boolean))];
  if (uniquePubkeys.length === 0) return;
  await sharedDb.profiles.bulkDelete(uniquePubkeys);
}

// ---------------------------------------------------------------------------
// pending_writes — workspace DB
// ---------------------------------------------------------------------------

export async function addPendingWrite(write) {
  return wsDb().pending_writes.add(sanitizeForStorage({ ...write, created_at: new Date().toISOString() }));
}

export async function updatePendingWrite(rowId, patch = {}) {
  if (rowId == null) return 0;
  return wsDb().pending_writes.update(rowId, sanitizeForStorage(patch));
}

export async function getPendingWrites() {
  return wsDb().pending_writes.toArray();
}

export async function getPendingWritesByFamilies(familyIds = []) {
  const hashes = [...new Set(familyIds.map((familyId) => getSyncFamily(familyId)?.hash).filter(Boolean))];
  if (hashes.length === 0) return [];
  return wsDb().pending_writes.where('record_family_hash').anyOf(hashes).toArray();
}

export async function removePendingWrite(rowId) {
  return wsDb().pending_writes.delete(rowId);
}

// ---------------------------------------------------------------------------
// sync_state — workspace DB
// ---------------------------------------------------------------------------

export async function getSyncState(key) {
  const row = await wsDb().sync_state.get(key);
  return row?.value ?? null;
}

export async function setSyncState(key, value) {
  return wsDb().sync_state.put({ key, value });
}

export async function runWorkspaceSyncTransaction(callback) {
  const db = wsDb();
  return db.transaction('rw', [
    db.pg_record_rows,
    db.scopes,
    db.channels,
    db.groups,
    db.chat_messages,
    db.pending_writes,
    db.tasks,
    db.comments,
    db.documents,
    db.file_folders,
    db.audio_notes,
    db.daily_notes,
    db.wapps,
    db.workspace_members,
    db.wapp_publishing_grants,
    db.wapp_activity_items,
    db.wapp_activity_mutes,
    db.autopilot_connections,
    db.workspace_agents,
    db.sync_state,
  ], callback);
}

export async function deleteTowerPgSyncTombstones(tombstones = []) {
  const db = wsDb();
  for (const tombstone of (Array.isArray(tombstones) ? tombstones : [])) {
    const entityId = String(tombstone?.entity_id || '').trim();
    if (!entityId) continue;
    switch (String(tombstone?.entity_type || '').trim()) {
      case 'scope': await db.scopes.delete(entityId); break;
      case 'channel': await db.channels.delete(entityId); break;
      case 'message':
      case 'thread': await db.chat_messages.delete(entityId); break;
      case 'task': await db.tasks.delete(entityId); break;
      case 'task_comment':
      case 'doc_comment': await db.comments.delete(entityId); break;
      case 'doc':
      case 'file': await db.documents.delete(entityId); break;
      case 'file_folder': await db.file_folders.delete(entityId); break;
      case 'audio_note': await db.audio_notes.delete(entityId); break;
      case 'daily_note': await db.daily_notes.delete(entityId); break;
      case 'personal_wapp': await db.wapps.delete(entityId); break;
      case 'wapp_activity_item': await db.wapp_activity_items.delete(entityId); break;
      case 'autopilot_connection': await db.autopilot_connections.delete(entityId); break;
      case 'workspace_agent': await db.workspace_agents.delete(entityId); break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------------------
// Autopilot connections and workspace-installed agents — Tower PG cache
// ---------------------------------------------------------------------------

export async function getAutopilotConnectionsByWorkspace(workspaceId, { includeArchived = false } = {}) {
  const rows = await wsDb().autopilot_connections.where('workspace_id').equals(String(workspaceId || '')).toArray();
  return rows.filter(row => includeArchived || !row.archived_at)
    .sort((left, right) => String(left.display_name || '').localeCompare(String(right.display_name || '')) || String(left.id).localeCompare(String(right.id)));
}

export async function upsertAutopilotConnection(row) { return wsDb().autopilot_connections.put(sanitizeForStorage(row)); }
export async function upsertWorkspaceAgent(row) { return wsDb().workspace_agents.put(sanitizeForStorage(row)); }

export async function getWorkspaceAgentsByWorkspace(workspaceId, { includeArchived = false, visibleOnly = false } = {}) {
  const db = wsDb();
  const normalizedWorkspaceId = String(workspaceId || '');
  const rows = await db.workspace_agents.where('workspace_id').equals(normalizedWorkspaceId).toArray();
  const shadowedCompatibilityIds = await getShadowedLegacyAgentIds(db, normalizedWorkspaceId, rows);
  return rows.filter(row => !shadowedCompatibilityIds.has(row.id)
      && (includeArchived || !row.archived_at) && (!visibleOnly || row.is_visible === true))
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0)
      || String(left.display_name || '').localeCompare(String(right.display_name || '')) || String(left.id).localeCompare(String(right.id)));
}

function normalizedPublicEndpoint(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch { return ''; }
}

async function getShadowedLegacyAgentIds(db, workspaceId, materializedAgents) {
  const compatibilityAgents = materializedAgents.filter((row) => row?.pg_backend === false);
  if (compatibilityAgents.length === 0) return new Set();
  const rawRows = await db.pg_record_rows.where('family').anyOf('autopilot_connection', 'workspace_agent').toArray();
  const canonicalConnections = new Map(rawRows
    .filter((raw) => raw.family === 'autopilot_connection' && raw.operation === 'upsert'
      && raw.row?.workspace_id === workspaceId)
    .map((raw) => [raw.id, new Set([
      normalizedPublicEndpoint(raw.row?.fips_endpoint),
      normalizedPublicEndpoint(raw.row?.https_endpoint),
    ].filter(Boolean))]));
  const canonicalLauncherKeys = new Set(rawRows
    .filter((raw) => raw.family === 'workspace_agent' && raw.operation === 'upsert'
      && raw.row?.workspace_id === workspaceId && canonicalConnections.has(raw.row?.connection_id))
    .flatMap((raw) => [...canonicalConnections.get(raw.row.connection_id)]
      .map((endpoint) => `${String(raw.row?.agent_npub || '').trim()}\n${endpoint}`)));
  return new Set(compatibilityAgents
    .filter((row) => canonicalLauncherKeys.has(`${String(row.agent_npub || '').trim()}\n${normalizedPublicEndpoint(row.metadata?.launcher_url)}`))
    .map((row) => row.id));
}

export async function getWorkspaceAgentsByConnection(connectionId, options = {}) {
  const rows = await wsDb().workspace_agents.where('connection_id').equals(String(connectionId || '')).toArray();
  return rows.filter(row => (options.includeArchived || !row.archived_at) && (!options.visibleOnly || row.is_visible === true))
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0)
      || String(left.display_name || '').localeCompare(String(right.display_name || '')) || String(left.id).localeCompare(String(right.id)));
}

function legacyCompatibilityId(prefix, value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy-${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Preserve compatible flat launcher settings as local-only rows. These rows do
 * not assert a verified installation_id or FIPS endpoint and are replaced by
 * canonical Tower rows only when later commands establish that authority.
 */
export async function migrateLegacyAutopilotLaunchers(workspaceId, entries = []) {
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  if (!normalizedWorkspaceId) return { connections: 0, agents: 0 };
  const normalized = [];
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const agentNpub = String(entry?.agent_npub || '').trim();
    const rawUrl = String(entry?.url || '').trim();
    let endpoint = '';
    endpoint = normalizedPublicEndpoint(rawUrl);
    if (agentNpub && endpoint) normalized.push({ agentNpub, endpoint, index });
  }
  const db = wsDb();
  return db.transaction('rw', db.autopilot_connections, db.workspace_agents, async () => {
    let connections = 0, agents = 0;
    const connectionByEndpoint = new Map();
    for (const entry of normalized) {
      let connectionId = connectionByEndpoint.get(entry.endpoint);
      if (!connectionId) {
        connectionId = legacyCompatibilityId('connection', `${normalizedWorkspaceId}:${entry.endpoint}`);
        connectionByEndpoint.set(entry.endpoint, connectionId);
        if (!(await db.autopilot_connections.get(connectionId))) {
          await db.autopilot_connections.put({
            id: connectionId, record_id: connectionId, workspace_id: normalizedWorkspaceId, installation_id: null,
            display_name: new URL(entry.endpoint).hostname, fips_endpoint: null, https_endpoint: entry.endpoint,
            api_version: null, capabilities: [], metadata: { compatibility_source: 'legacy_launcher', installation_identity_verified: false },
            row_version: 0, created_by_actor_id: null, updated_by_actor_id: null, archived_by_actor_id: null,
            created_at: null, updated_at: null, archived_at: null, sync_status: 'local_compatibility', pg_backend: false,
          });
          connections++;
        }
      }
      const agentId = legacyCompatibilityId('agent', `${normalizedWorkspaceId}:${connectionId}:${entry.agentNpub}`);
      const prior = await db.workspace_agents.get(agentId);
      const row = {
        id: agentId, record_id: agentId, workspace_id: normalizedWorkspaceId, connection_id: connectionId,
        agent_id: null, agent_npub: entry.agentNpub, display_name: entry.agentNpub, avatar_url: null,
        capabilities: [], sort_order: entry.index, is_visible: true,
        metadata: { compatibility_source: 'legacy_launcher', installation_identity_verified: false, launcher_url: entry.endpoint },
        row_version: 0, created_by_actor_id: null, updated_by_actor_id: null, archived_by_actor_id: null,
        created_at: null, updated_at: null, archived_at: null, sync_status: 'local_compatibility', pg_backend: false,
      };
      if (!sameLogicalValue(prior, row)) { await db.workspace_agents.put(row); agents++; }
    }
    return { connections, agents };
  });
}

export async function reconcileTowerPgSnapshot(manifest = {}) {
  const db = wsDb();
  const seen = (family) => new Set(Array.isArray(manifest?.[family]) ? manifest[family] : []);
  const deleteOmitted = async (table, family, predicate = (row) => row?.pg_backend === true) => {
    const accepted = seen(family);
    const ids = (await table.toArray())
      .filter(predicate)
      .filter((row) => row?.sync_status !== 'pending' && row?.sync_status !== 'failed')
      .map((row) => String(row?.record_id || '').trim())
      .filter((id) => id && !accepted.has(id));
    if (ids.length > 0) await table.bulkDelete(ids);
  };
  await deleteOmitted(db.scopes, 'scopes');
  await deleteOmitted(db.channels, 'channels');
  await deleteOmitted(db.chat_messages, 'messages');
  await deleteOmitted(db.tasks, 'tasks');
  await deleteOmitted(db.comments, 'comments');
  await deleteOmitted(db.documents, 'documents');
  await deleteOmitted(db.file_folders, 'folders');
  await deleteOmitted(db.audio_notes, 'audio_notes');
  await deleteOmitted(db.daily_notes, 'daily_notes');
  await deleteOmitted(db.wapps, 'personal_wapps', (row) => row?.pg_backend === true || Boolean(row?.pg_personal_wapp_id));
  await deleteOmitted(db.autopilot_connections, 'autopilot_connections');
  await deleteOmitted(db.workspace_agents, 'workspace_agents');
}

export async function deleteSyncState(key) {
  return wsDb().sync_state.delete(key);
}

export async function clearSyncStateForFamilies(familyIds = []) {
  const keys = [...new Set(familyIds.map((familyId) => getSyncStateKeyForFamily(familyId)).filter(Boolean))];
  if (keys.length === 0) return;
  await Promise.all(keys.map((key) => deleteSyncState(key)));
}

export async function clearSyncState() {
  return wsDb().sync_state.clear();
}

// ---------------------------------------------------------------------------
// sync_quarantine — workspace DB
// ---------------------------------------------------------------------------

export function syncQuarantineKey(familyHash, recordId) {
  return `${String(familyHash || '').trim()}:${String(recordId || '').trim()}`;
}

export async function getSyncQuarantineEntries() {
  const rows = await wsDb().sync_quarantine.orderBy('last_seen_at').reverse().toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function upsertSyncQuarantineEntry(entry) {
  const db = wsDb();
  const key = syncQuarantineKey(entry.family_hash, entry.record_id);
  const existing = await db.sync_quarantine.get(key);
  const now = new Date().toISOString();
  return db.sync_quarantine.put(sanitizeForStorage({
    ...existing,
    ...entry,
    key,
    first_seen_at: existing?.first_seen_at || entry.first_seen_at || now,
    last_seen_at: entry.last_seen_at || now,
    skip_count: Number(existing?.skip_count || 0) + 1,
    record_state: 'active',
  }));
}

export async function deleteSyncQuarantineEntry(familyHash, recordId) {
  return wsDb().sync_quarantine.delete(syncQuarantineKey(familyHash, recordId));
}

export async function clearSyncQuarantineForFamilies(familyIds = []) {
  const hashes = [...new Set(familyIds.map((familyId) => getSyncFamily(familyId)?.hash).filter(Boolean))];
  if (hashes.length === 0) return;
  await Promise.all(hashes.map((hash) => wsDb().sync_quarantine.where('family_hash').equals(hash).delete()));
}

// ---------------------------------------------------------------------------
// tasks — workspace DB
// ---------------------------------------------------------------------------

// Manual board order is stable by record ID for ties, matching IndexedDB's
// previous owner-index iteration. Counts use index keys, not materialized cards.
export async function getTaskBoardWindow({ ownerNpub, channelId, threadId, scopeIds, limit = 50, state, sortMode = 'manual' } = {}) {
  const db = wsDb();
  const field = threadId ? 'thread' : channelId ? 'channel' : scopeIds ? 'scope' : 'owner';
  const values = threadId ? [threadId] : channelId ? [channelId] : scopeIds || [ownerNpub];
  const states = state ? [state] : ['new', 'ready', 'in_progress', 'blocked', 'review', 'done', 'archive'];
  const counts = {};
  const pages = await Promise.all(states.map(async (taskState) => {
    let count = 0;
    const rows = (await Promise.all(values.map(async (value) => {
      const query = db.tasks.where('cache_board_keys')
        .between([`${field}:${value}`, 1, taskState, sortMode, Dexie.minKey], [`${field}:${value}`, 1, taskState, sortMode, Dexie.maxKey]);
      const [total, page] = await Promise.all([query.clone().count(), query.clone().limit(limit + 1).toArray()]);
      count += total;
      return page;
    }))).flat().sort((a,b) => compareIndexedTasks(a,b,sortMode));
    counts[taskState] = count;
    return rows.slice(0, limit);
  }));
  const rows = pages.flat().map(taskWithoutIndexFields);
  return { rows, counts, hasMore: Object.values(counts).some((count) => count > limit) };
}

// Overview/files read a bounded activity prefix. The visible Load older control
// expands this prefix; source history is never silently fetched in a subscription.
export async function getOwnerActivityWindow(tableName, ownerNpub, options = {}) {
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 100));
  if (tableName === 'chat_messages') {
    const channels = options.channels || await getChannelsByOwner(ownerNpub);
    return getChannelActivityWindow(channels.map(row => row.record_id), options);
  }
  if (tableName === 'tasks') {
    if (options.matches) {
      const field = options.channelId ? 'channel' : options.scopeIds ? 'scope' : 'owner';
      const values = options.channelId ? [options.channelId] : options.scopeIds || [ownerNpub];
      const states = ['new', 'ready', 'in_progress', 'blocked', 'review', 'done'];
      if (options.search && !options.scopeIds && !options.channelId) {
        const token = options.search.slice(0, 3);
        const candidates = await wsDb().tasks.where('cache_search_tokens').equals(token).limit(limit + 1).toArray();
        const scoped = candidates.slice(0, limit).filter(row => row.owner_npub === ownerNpub && row.cache_active === 1
          && (!options.scopeIds || options.scopeIds.includes(row.cache_scope))
          && (!options.channelId || row.pg_channel_id === options.channelId) && options.matches(row));
        return { rows: scoped.sort((a, b) => compareIndexedTasks(a, b, 'modified_desc')).map(taskWithoutIndexFields), hasMore: candidates.length > limit };
      }
      const pages = await Promise.all(values.flatMap(value => states.map(state => wsDb().tasks.where('cache_board_keys')
        .between([`${field}:${value}`, 1, state, 'modified_desc', Dexie.minKey],
          [`${field}:${value}`, 1, state, 'modified_desc', Dexie.maxKey])
        .limit(limit + 1).toArray())));
      const rows = pages.flatMap(page => page.slice(0, limit)).filter(options.matches)
        .sort((a, b) => compareIndexedTasks(a, b, 'modified_desc'));
      return { rows: rows.slice(0, limit).map(taskWithoutIndexFields), hasMore: rows.length > limit || pages.some(page => page.length > limit) };
    }
    const page = await getTaskBoardWindow({ ownerNpub, limit, sortMode: 'modified_desc' });
    return { rows: page.rows, hasMore: page.hasMore };
  }
  if (!['comments', 'documents'].includes(tableName)) throw new Error('Unsupported activity family');
  const field = options.scopeIds ? 'cache_scope' : 'owner_npub';
  const values = options.scopeIds || [ownerNpub];
  const index = `[${field}+${options.filesOnly ? 'cache_has_files+' : options.kind ? 'cache_kind+' : ''}cache_active+cache_time+record_id]`;
  const pages = await Promise.all(values.map(value => {
    const prefix = options.filesOnly ? [value, 1, 1] : options.kind ? [value, options.kind, 1] : [value, 1];
    return wsDb().table(tableName).where(index)
      .between([...prefix, Dexie.minKey, Dexie.minKey], [...prefix, '\uffff', Dexie.maxKey])
      .reverse().limit(limit + 1).toArray();
  }));
  const rows = pages.flatMap(page => page.slice(0, limit)).filter(options.matches || (() => true))
    .sort((a, b) => String(b.cache_time).localeCompare(String(a.cache_time)) || String(b.record_id).localeCompare(String(a.record_id)));
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit || pages.some(page => page.length > limit) };
}

// Channel indexes existed before owner-indexed activity. Reading these also
// recovers already materialized PG rows that never carried owner_npub, without
// rewriting user data, pending commands or sync cursors.
export async function getChannelActivityWindow(channelIds, options = {}) {
  const db = wsDb();
  const limit = Math.max(1, Number(options.limit) || 100);
  let hasMore = false;
  const pages = await Promise.all([...new Set(channelIds)].map(async channelId => {
    const prefix = options.filesOnly ? [channelId, 1, 1] : [channelId, 1];
    const recent = await db.chat_messages.where(options.filesOnly ? '[channel_id+cache_has_files+cache_active+cache_time+record_id]' : '[channel_id+cache_recent+cache_time+record_id]')
      .between([...prefix, Dexie.minKey, Dexie.minKey], [...prefix, '\uffff', Dexie.maxKey])
      .reverse().limit(limit + 1).toArray();
    let candidates = options.groupThreads ? recent : recent.slice(0, limit);
    if (!options.groupThreads) hasMore ||= recent.length > limit;
    if (options.groupThreads) {
      // A huge busy thread must not hide the next roots or make deduplication
      // walk its entire reply history. Both root and message prefixes are
      // explicitly bounded; latest replies use one indexed lookup per root.
      const roots = await db.chat_messages.where('[channel_id+cache_active+cache_parent+cache_time+record_id]')
        .between([channelId, 1, '', Dexie.minKey, Dexie.minKey], [channelId, 1, '', '\uffff', Dexie.maxKey])
        .reverse().limit(limit + 1).toArray();
      hasMore ||= roots.length > limit || (roots.length === 0 && recent.length > limit);
      candidates.push(...roots);
    }
    const matched = candidates.filter(row => row.record_state !== 'archived' && (!options.matches || options.matches(row)));
    if (!options.groupThreads) return matched;
    const threadIds = [...new Set(matched.map(row => row.pg_thread_id || row.parent_message_id || row.record_id))];
    const latest = await Promise.all(threadIds.map(id => db.chat_messages.where('[cache_parent+cache_recent+cache_time+record_id]')
      .between([id, 1, Dexie.minKey, Dexie.minKey], [id, 1, '\uffff', Dexie.maxKey]).reverse().first()));
    return [...matched, ...latest.filter(Boolean)];
  }));
  const ordered = [...new Map(pages.flat().map(row => [row.record_id, row])).values()]
    .sort((a, b) => String(b.cache_time).localeCompare(String(a.cache_time)) || String(b.record_id).localeCompare(String(a.record_id)));
  const seen = new Set();
  const selected = ordered.filter(row => {
    const id = options.groupThreads ? row.pg_thread_id || row.parent_message_id || row.record_id : row.record_id;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
  hasMore ||= selected.length > limit;
  const rows = selected.slice(0, limit);
  if (options.groupThreads) {
    const roots = await db.chat_messages.bulkGet([...new Set(rows.flatMap(row => [row.pg_thread_id, row.parent_message_id]).filter(Boolean))]);
    const selectedIds = new Set(rows.map(row => row.pg_thread_id || row.parent_message_id || row.record_id));
    const latestContent = new Set();
    const matchingContent = new Set();
    for (const row of ordered) {
      const id = row.pg_thread_id || row.parent_message_id || row.record_id;
      if (!selectedIds.has(id)) continue;
      if (row.pg_record_type !== 'thread' && !latestContent.has(id)) { latestContent.add(id); rows.push(row); }
      if (options.search && !matchingContent.has(id) && options.matches?.(row)) { matchingContent.add(id); rows.push(row); }
    }
    rows.push(...roots.filter(row => row && !['deleted', 'archived'].includes(row.record_state)));
  }
  return { rows: [...new Map(rows.map(row => [row.record_id, row])).values()], hasMore };
}

export async function getRecentChannelActivity(ownerNpub) {
  const db = wsDb();
  const channels = await getChannelsByOwner(ownerNpub);
  // Eligibility is indexed, so any number of archived/metadata rows cannot
  // force a history scan or conceal the actual latest channel message.
  const rows = await Promise.all(channels.filter(row => row.record_state !== 'archived').map(row =>
    db.chat_messages.where('[channel_id+cache_recent+cache_time+record_id]')
      .between([row.record_id, 1, Dexie.minKey, Dexie.minKey], [row.record_id, 1, '\uffff', Dexie.maxKey])
      .reverse().first()));
  return rows.filter(Boolean);
}

export async function getActivityThreadAttention(messages) {
  const ids = [...new Set(messages.map(row => row.pg_thread_id || row.parent_message_id || row.record_id))];
  const rows = await wsDb().pg_resource_attention.bulkGet(ids.map(id => `thread:${id}`));
  return Object.fromEntries(rows.filter(Boolean).map(row => [row.resource_id, Boolean(row.unread)]));
}

export async function getTasksByOwner(ownerNpub) {
  const rows = await wsDb().tasks.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getRecentTaskChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().tasks.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('tasks', options));
}

export async function upsertTask(task) {
  return wsDb().tasks.put(sanitizeForStorage(task));
}

export async function replaceTaskRecordId(previousRecordId, task) {
  if (!task?.record_id) return null;
  const nextTask = sanitizeForStorage(task);
  const previousId = String(previousRecordId || '').trim();
  const db = wsDb();
  return db.transaction('rw', db.tasks, async () => {
    if (previousId && previousId !== nextTask.record_id) {
      await db.tasks.delete(previousId);
    }
    await db.tasks.put(nextTask);
    return nextTask.record_id;
  });
}

export async function replaceTasksForOwner(ownerNpub, tasks = [], options = {}) {
  if (!ownerNpub) return 0;
  const rows = (Array.isArray(tasks) ? tasks : []).map(sanitizeForStorage).filter(row => row?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.tasks, async () => {
    const existing = options.authoritative === true ? await db.tasks.where('owner_npub').equals(ownerNpub).toArray()
      : (await db.tasks.bulkGet(rows.map(row=>row.record_id))).filter(Boolean);
    const byId = new Map(existing.map(row=>[row.record_id,row]));
    const protectedRow = row => ['pending','failed'].includes(row?.sync_status) || row?.pg_reconciliation_pending;
    const changed = rows.filter(row => !protectedRow(byId.get(row.record_id))
      && Number(byId.get(row.record_id)?.version || 0) <= Number(row.version || 0)
      && !sameLogicalValue(byId.get(row.record_id),{...row,...taskIndexFields(row)}));
    const incoming = new Set(rows.map(row=>row.record_id));
    const omitted = options.authoritative === true ? existing.filter(row=>!incoming.has(row.record_id) && !protectedRow(row)).map(row=>row.record_id) : [];
    if (omitted.length) await db.tasks.bulkDelete(omitted);
    if (changed.length) await db.tasks.bulkPut(changed);
    return changed.length + omitted.length;
  });
}

// Ordinary list/bundle responses are partial. Only an explicitly complete snapshot
// may reconcile omissions; commands and tombstones have their own identity paths.
export async function replacePgTasksForChannel(channelId, tasks = [], options = {}) {
  if (!channelId) return 0;
  const rows = (Array.isArray(tasks) ? tasks : []).map(sanitizeForStorage).filter(row => row?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.tasks, db.pending_writes, async () => {
    const ids = [...new Set(rows.flatMap(row => [row.record_id, row.pg_client_record_id]).filter(Boolean))];
    const clients = rows.map(row => row.pg_client_record_id).filter(Boolean);
    const existing = options.authoritative === true ? await db.tasks.where('pg_channel_id').equals(channelId).toArray()
      : [...new Map([...(await db.tasks.bulkGet(ids)).filter(Boolean),
        ...(clients.length ? await db.tasks.where('pg_client_record_id').anyOf(clients).toArray() : [])].map(row => [row.record_id, row])).values()];
    const byId = new Map(existing.map(row => [row.record_id, row]));
    const commands = new Set((ids.length ? await db.pending_writes.where('record_id').anyOf([...ids,...existing.map(row=>row.record_id)]).toArray() : []).map(row => row.record_id));
    const incoming = new Set(rows.map(row => row.record_id));
    const protectedRow = row => commands.has(row?.record_id) || ['pending','failed'].includes(row?.sync_status) || row?.pg_reconciliation_pending;
    const changed = [], deletes = new Set();
    for (const row of rows) {
      const prior = byId.get(row.record_id);
      const aliases = row.pg_client_record_id ? existing.filter(local => (local.pg_client_record_id || local.record_id) === row.pg_client_record_id) : [];
      if (aliases.some(local => commands.has(local.record_id) || Number(local.version || 0) > Number(row.version || 0))) continue;
      if (protectedRow(prior) && !aliases.includes(prior)) continue;
      if (Number(prior?.version || 0) > Number(row.version || 0)) continue;
      for (const alias of aliases) if (alias.record_id !== row.record_id) deletes.add(alias.record_id);
      const { pg_reconciliation_pending, ...canonical } = row;
      if (!sameLogicalValue(prior, { ...canonical, ...taskIndexFields(canonical) })) changed.push(canonical);
    }
    if (options.authoritative === true) for (const row of existing) {
      if (row.pg_backend && !incoming.has(row.record_id) && !protectedRow(row)) deletes.add(row.record_id);
    }
    if (deletes.size) await db.tasks.bulkDelete([...deletes]);
    if (changed.length) await db.tasks.bulkPut(changed);
    return changed.length + deletes.size;
  });
}

export function taskWithoutIndexFields(row) {
  if (!row) return row;
  const { cache_active, cache_order, cache_scope, cache_state, cache_board_keys, cache_search_tokens, cache_tags, cache_assignees, ...task } = row;
  return task;
}

export async function getTaskById(recordId) {
  return taskWithoutIndexFields(await wsDb().tasks.get(recordId));
}

// ---------------------------------------------------------------------------
// schedules — workspace DB
// ---------------------------------------------------------------------------

export async function getSchedulesByOwner(ownerNpub) {
  const rows = await wsDb().schedules.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getRecentScheduleChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().schedules.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('schedules', options));
}

export async function upsertSchedule(schedule) {
  return wsDb().schedules.put(sanitizeForStorage(schedule));
}

export async function getScheduleById(recordId) {
  return wsDb().schedules.get(recordId);
}

// ---------------------------------------------------------------------------
// comments — workspace DB
// ---------------------------------------------------------------------------

export async function getCommentsByTarget(targetRecordId, options = {}) {
  const query = wsDb().comments.where('[target_record_id+cache_active+cache_time+record_id]')
    .between([targetRecordId, 1, Dexie.minKey, Dexie.minKey],
      options.before ? [targetRecordId, 1, options.before.timestamp, options.before.recordId]
        : [targetRecordId, 1, '\uffff', Dexie.maxKey], true, !options.before)
    .reverse();
  const rows = await (options.limit ? query.limit(resolveWindowLimit('threadReplies', options)) : query).toArray();
  if (!options.limit) return rows;
  const byId = new Map(rows.map(row => [row.record_id, row]));
  const parentIds = [...new Set(rows.map(row => row.parent_comment_id).filter(id => id && !byId.has(id)))];
  if (options.focusId && !byId.has(options.focusId)) parentIds.push(options.focusId);
  for (const row of (await wsDb().comments.bulkGet(parentIds)).filter(Boolean)) {
    if (row.target_record_id === targetRecordId && row.record_state !== 'deleted') byId.set(row.record_id,row);
  }
  if (options.focusId) {
    const replies = await wsDb().comments.where('[parent_comment_id+cache_active+cache_time+record_id]')
      .between([options.focusId,1,Dexie.minKey,Dexie.minKey],[options.focusId,1,'\uffff',Dexie.maxKey])
      .reverse().limit(resolveWindowLimit('threadReplies',options)).toArray();
    for(const row of replies) if(row.target_record_id === targetRecordId) byId.set(row.record_id,row);
  }
  return [...byId.values()].sort((a,b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')) || b.record_id.localeCompare(a.record_id));
}

export async function getCommentsByOwner(ownerNpub) {
  const owner = String(ownerNpub || '').trim();
  if (!owner) return [];
  const rows = await wsDb().comments.toArray();
  return rows
    .filter((row) => row.record_state !== 'deleted' && row.owner_npub === owner)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

export async function getRecentCommentsSince(sinceIso, options = {}) {
  const rows = await wsDb().comments.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('threadReplies', options));
}

export async function upsertComment(comment) {
  return wsDb().comments.put(sanitizeForStorage(comment));
}

export async function replaceCommentRecord(previousRecordId, comment) {
  const row = sanitizeForStorage(comment);
  if (!row?.record_id) return null;
  const db = wsDb();
  return db.transaction('rw', db.comments, async () => {
    const previousId = String(previousRecordId || '').trim();
    if (previousId && previousId !== row.record_id) {
      await db.comments.delete(previousId);
    }
    await db.comments.put(row);
    return row.record_id;
  });
}

export async function replacePgCommentsForTarget(targetRecordId, comments = [], options = {}) {
  const targetId = String(targetRecordId || '').trim();
  if (!targetId) return 0;
  const rows = (Array.isArray(comments) ? comments : [])
    .map((comment) => sanitizeForStorage(comment))
    .filter((comment) => comment?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.comments, db.pending_writes, async () => {
    const ids = [...new Set(rows.flatMap((row) => [row.record_id, row.pg_client_record_id]).filter(Boolean))];
    const clients = [...new Set(rows.map((row) => row.pg_client_record_id).filter(Boolean))];
    const existing = options.authoritative === true
      ? await db.comments.where('target_record_id').equals(targetId).toArray()
      : [...new Map([
        ...(await db.comments.bulkGet(ids)).filter(Boolean),
        ...(clients.length ? await db.comments.where('pg_client_record_id').anyOf(clients).toArray() : []),
      ].filter((row) => row.target_record_id === targetId).map((row) => [row.record_id, row])).values()];
    const commandIds = new Set((existing.length ? await db.pending_writes.where('record_id').anyOf(existing.map(row => row.record_id)).toArray() : []).map(row => row.record_id));
    const blockedClients = new Set(existing.filter(local => {
      const ack = rows.find(row => row.pg_client_record_id === (local.pg_client_record_id || local.record_id));
      return ack && (commandIds.has(local.record_id) || Number(local.version || 0) > Number(ack.version || 0));
    }).map(row => row.pg_client_record_id || row.record_id));
    const authoritativeClientIds = new Set(rows
      .map((comment) => String(comment?.pg_client_record_id || '').trim())
      .filter(Boolean));
    const authoritativeRecordIds = new Set(rows.map((comment) => comment.record_id).filter(Boolean));
    const reconciledRows = rows.filter(row => !blockedClients.has(row.pg_client_record_id)).map((comment) => {
      const { pg_reconciliation_pending, ...reconciled } = comment;
      return reconciled;
    });
    const protectedIds = new Set(existing
      .filter((comment) => (
        comment?.sync_status === 'pending'
        || comment?.sync_status === 'failed'
        || comment?.pg_reconciliation_pending === true
      ))
      .filter((comment) => {
        const clientRecordId = String(comment?.pg_client_record_id || comment?.record_id || '').trim();
        return !authoritativeClientIds.has(clientRecordId);
      })
      .map((comment) => comment.record_id)
      .filter(Boolean));
    for (const row of existing) {
      if (commandIds.has(row.record_id) || blockedClients.has(row.pg_client_record_id || row.record_id)) protectedIds.add(row.record_id);
    }
    const pgCommentIds = existing
      .filter((comment) => comment?.pg_backend === true && !protectedIds.has(comment.record_id))
      .filter((comment) => !authoritativeRecordIds.has(comment.record_id))
      .filter((comment) => options.authoritative === true || authoritativeClientIds.has(comment.pg_client_record_id || comment.record_id))
      .map((comment) => comment.record_id);
    const byId = new Map(existing.map((row) => [row.record_id, row]));
    const changed = reconciledRows.filter((row) => !protectedIds.has(row.record_id) && Number(byId.get(row.record_id)?.version || 0) <= Number(row.version || 0)
      && !sameLogicalValue(byId.get(row.record_id), { ...row, ...activityIndexFields(row) }));
    if (pgCommentIds.length > 0) await db.comments.bulkDelete(pgCommentIds);
    if (changed.length > 0) await db.comments.bulkPut(changed);
    return changed.length + pgCommentIds.length;
  });
}

export async function getCommentById(recordId) {
  return wsDb().comments.get(recordId);
}

// ---------------------------------------------------------------------------
// reactions — workspace DB
// ---------------------------------------------------------------------------

function reactionIdentityKey(row = {}) {
  return [
    String(row.target_record_family_hash || '').trim(),
    String(row.target_record_id || '').trim(),
    String(row.emoji || '').trim(),
    String(row.reactor_npub || '').trim(),
  ];
}

function reactionFreshness(row = {}) {
  return `${String(row.updated_at || '')}\u0000${String(row.version ?? 0).padStart(12, '0')}`;
}

export async function getReactionsByTarget(targetRecordId, targetRecordFamilyHash = null) {
  const targetId = String(targetRecordId || '').trim();
  if (!targetId) return [];
  const rows = await wsDb().reactions.where('target_record_id').equals(targetId).toArray();
  const targetFamily = String(targetRecordFamilyHash || '').trim();
  return rows
    .filter((row) => !targetFamily || row.target_record_family_hash === targetFamily)
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
}

export async function getReactionsByTargets(targetRecordIds = [], targetRecordFamilyHash = null) {
  const targetIds = [...new Set((Array.isArray(targetRecordIds) ? targetRecordIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (targetIds.length === 0) return [];
  const rows = await wsDb().reactions.where('target_record_id').anyOf(targetIds).toArray();
  const targetFamily = String(targetRecordFamilyHash || '').trim();
  return rows
    .filter((row) => !targetFamily || row.target_record_family_hash === targetFamily)
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
}

export async function getRecentReactionsSince(sinceIso, options = {}) {
  const rows = await wsDb().reactions.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('threadReplies', options));
}

export async function getReactionByIdentity({
  target_record_family_hash,
  target_record_id,
  emoji,
  reactor_npub,
}) {
  const key = reactionIdentityKey({
    target_record_family_hash,
    target_record_id,
    emoji,
    reactor_npub,
  });
  if (key.some((part) => !part)) return null;
  return wsDb().reactions
    .where('[target_record_family_hash+target_record_id+emoji+reactor_npub]')
    .equals(key)
    .first();
}

export async function upsertReaction(reaction) {
  const row = sanitizeForStorage(reaction);
  const key = reactionIdentityKey(row);
  if (key.some((part) => !part)) {
    throw new Error('reaction identity requires target family, target id, emoji, and reactor');
  }
  const db = wsDb();
  return db.transaction('rw', db.reactions, async () => {
    const existing = await db.reactions
      .where('[target_record_family_hash+target_record_id+emoji+reactor_npub]')
      .equals(key)
      .first();
    if (existing?.record_id && existing.record_id !== row.record_id) {
      if (reactionFreshness(existing) > reactionFreshness(row)) {
        return existing.record_id;
      }
      await db.reactions.delete(existing.record_id);
    }
    return db.reactions.put(row);
  });
}

export async function replacePgReactionsForTarget(targetRecordFamilyHash, targetRecordId, reactions = []) {
  const familyHash = String(targetRecordFamilyHash || '').trim();
  const targetId = String(targetRecordId || '').trim();
  if (!familyHash || !targetId) return 0;
  const rows = (Array.isArray(reactions) ? reactions : [])
    .map((reaction) => sanitizeForStorage(reaction))
    .filter((reaction) => reaction?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.reactions, async () => {
    const existing = await db.reactions
      .where('target_record_id')
      .equals(targetId)
      .toArray();
    const pgReactionIds = existing
      .filter((reaction) => reaction?.pg_backend === true && reaction?.target_record_family_hash === familyHash)
      .map((reaction) => reaction.record_id)
      .filter(Boolean);
    if (pgReactionIds.length > 0) await db.reactions.bulkDelete(pgReactionIds);
    if (rows.length > 0) await db.reactions.bulkPut(rows);
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// response activities — workspace DB
// ---------------------------------------------------------------------------

function isActiveResponseActivity(row = {}, nowMs = Date.now()) {
  if (!row?.record_id) return false;
  if (String(row.status || '') === 'cleared' || String(row.record_state || '') === 'cleared' || row.cleared_at) return false;
  const expiresAt = Date.parse(row.expires_at || '');
  return !Number.isFinite(expiresAt) || expiresAt > nowMs;
}

export async function upsertResponseActivity(activity) {
  const row = sanitizeForStorage(activity);
  if (!row?.record_id) return null;
  return wsDb().response_activities.put(row);
}

export async function clearResponseActivity(recordId) {
  const id = String(recordId || '').trim();
  if (!id) return 0;
  return wsDb().response_activities.delete(id);
}

export async function replacePgResponseActivitiesForChannel(channelId, activities = []) {
  const id = String(channelId || '').trim();
  if (!id) return 0;
  const rows = (Array.isArray(activities) ? activities : [])
    .map((activity) => sanitizeForStorage(activity))
    .filter((activity) => activity?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.response_activities, async () => {
    const existing = await db.response_activities.where('channel_id').equals(id).toArray();
    const pgActivityIds = existing
      .filter((activity) => activity?.pg_backend === true && activity?.target_type === 'chat_thread')
      .map((activity) => activity.record_id)
      .filter(Boolean);
    if (pgActivityIds.length > 0) await db.response_activities.bulkDelete(pgActivityIds);
    if (rows.length > 0) await db.response_activities.bulkPut(rows);
    return rows.length;
  });
}

export async function replacePgResponseActivitiesForTarget(targetType, targetId, activities = []) {
  const type = String(targetType || '').trim();
  const id = String(targetId || '').trim();
  if (!type || !id) return 0;
  const rows = (Array.isArray(activities) ? activities : [])
    .map((activity) => sanitizeForStorage(activity))
    .filter((activity) => activity?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.response_activities, async () => {
    const existing = await db.response_activities.where('target_id').equals(id).toArray();
    const pgActivityIds = existing
      .filter((activity) => activity?.pg_backend === true && activity?.target_type === type)
      .map((activity) => activity.record_id)
      .filter(Boolean);
    if (pgActivityIds.length > 0) await db.response_activities.bulkDelete(pgActivityIds);
    if (rows.length > 0) await db.response_activities.bulkPut(rows);
    return rows.length;
  });
}

export async function getResponseActivitiesForTarget(targetType, targetId) {
  const type = String(targetType || '').trim();
  const id = String(targetId || '').trim();
  if (!type || !id) return [];
  const nowMs = Date.now();
  const rows = await wsDb().response_activities.where('target_id').equals(id).toArray();
  return rows
    .filter((row) => row.target_type === type && isActiveResponseActivity(row, nowMs))
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
}

export async function getResponseActivitiesForChannel(channelId) {
  const id = String(channelId || '').trim();
  if (!id) return [];
  const nowMs = Date.now();
  const rows = await wsDb().response_activities.where('channel_id').equals(id).toArray();
  return rows
    .filter((row) => row.target_type === 'chat_thread' && isActiveResponseActivity(row, nowMs))
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
}

export async function pruneExpiredResponseActivities(now = new Date()) {
  const nowIso = now.toISOString();
  return wsDb().response_activities.where('expires_at').belowOrEqual(nowIso).delete();
}

export async function upsertAgentActivity(activity) {
  const row = sanitizeForStorage(activity);
  if (!row?.record_id || !row?.activity_id) return false;
  const db = wsDb();
  return db.transaction('rw', db.agent_activities, async () => {
    const current = await db.agent_activities.get(row.record_id);
    const sameActivity = current && current.activity_id === row.activity_id;
    const sameLifecycle = sameActivity && (
      String(current.turn_id || '') === String(row.turn_id || '')
      || (!current.turn_id && Boolean(row.turn_id))
    );
    if (current && (!sameLifecycle || Number(current.sequence) >= Number(row.sequence))) return false;
    await db.agent_activities.put({
      ...current,
      ...row,
      created_at: current?.created_at || row.created_at || null,
    });
    return true;
  });
}

export async function clearAgentActivity(recordId) {
  const id = String(recordId || '').trim();
  if (!id) return 0;
  const db = wsDb();
  return db.transaction('rw', db.agent_activities, db.agent_activity_commentary, async () => {
    const activity = await db.agent_activities.get(id);
    const deleted = await db.agent_activities.delete(id);
    if (activity?.turn_id) await db.agent_activity_commentary.where('turn_id').equals(activity.turn_id).delete();
    return deleted;
  });
}

export async function mergeAgentActivityCommentary(rows = []) {
  const validRows = (Array.isArray(rows) ? rows : [])
    .map(sanitizeForStorage)
    .filter((row) => row?.history_key && row?.turn_id && Number.isSafeInteger(Number(row.sequence)));
  if (validRows.length === 0) return 0;
  const db = wsDb();
  return db.transaction('rw', db.agent_activity_commentary, async () => {
    let changed = 0;
    for (const row of validRows) {
      if (await db.agent_activity_commentary.get(row.history_key)) continue;
      await db.agent_activity_commentary.add(row);
      changed += 1;
    }
    return changed;
  });
}

export async function getAgentActivityCommentaryForChannel(channelId) {
  const id = String(channelId || '').trim();
  if (!id) return [];
  return wsDb().agent_activity_commentary.where('channel_id').equals(id).sortBy('sequence');
}

export async function replacePgAgentActivitiesForChannel(channelId, activities = [], options = {}) {
  const id = String(channelId || '').trim();
  if (!id) return 0;
  const rows = (Array.isArray(activities) ? activities : []).map(sanitizeForStorage).filter((row) => row?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.agent_activities, db.agent_activity_commentary, async () => {
    let changed = 0;
    for (const row of rows) {
      const current = await db.agent_activities.get(row.record_id);
      const sameActivity = current && current.activity_id === row.activity_id;
      const sameLifecycle = sameActivity && (
        String(current.turn_id || '') === String(row.turn_id || '')
        || (!current.turn_id && Boolean(row.turn_id))
      );
      if (!current || sameLifecycle) {
        const next = Number(row.sequence) > Number(current?.sequence ?? -1) ? { ...current, ...row } : { ...current };
        if (/^\d+$/.test(String(row.commentary_cursor ?? ''))) {
          const priorCursor = /^\d+$/.test(String(current?.commentary_cursor ?? '')) ? current.commentary_cursor : '0';
          next.commentary_cursor = BigInt(row.commentary_cursor) > BigInt(priorCursor) ? row.commentary_cursor : priorCursor;
        }
        if (Object.prototype.hasOwnProperty.call(row, 'commentary_next_before_sequence')) {
          const previous = current?.commentary_next_before_sequence;
          const incoming = row.commentary_next_before_sequence;
          next.commentary_next_before_sequence = previous === null || incoming === null
            ? null
            : previous === undefined ? incoming : Math.min(previous, incoming);
        }
        await db.agent_activities.put({ ...next, created_at: current?.created_at || row.created_at || null });
        changed += 1;
      }
    }
    // List omission and freshness expiry are not lifecycle transitions. Keep
    // received runs and history until an explicit removal, even on old Towers.
    return changed;
  });
}

export async function getAgentActivitiesForChannel(channelId) {
  const id = String(channelId || '').trim();
  if (!id) return [];
  const db = wsDb();
  const [activities, commentary] = await Promise.all([
    db.agent_activities.where('channel_id').equals(id).toArray(),
    db.agent_activity_commentary.where('channel_id').equals(id).toArray(),
  ]);
  const historyByTurn = commentary.reduce((byTurn, item) => {
    const rows = byTurn.get(item.turn_id) || [];
    rows.push(item);
    byTurn.set(item.turn_id, rows);
    return byTurn;
  }, new Map());
  return activities.map((activity) => ({
    ...activity,
    commentary_history: (historyByTurn.get(activity.turn_id) || [])
      .filter((item) => item.activity_id === activity.activity_id)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence)),
  }));
}

export async function upsertAgentSessionHealth(health) {
  const row = sanitizeForStorage(health);
  if (!row?.record_id || !row?.session_id) return false;
  const db = wsDb();
  return db.transaction('rw', db.agent_session_health, async () => {
    const current = await db.agent_session_health.get(row.record_id);
    if (current && Number(current.row_version) >= Number(row.row_version)) return false;
    await db.agent_session_health.put({ ...current, ...row, created_at: current?.created_at || row.created_at || null });
    return true;
  });
}

export async function replacePgAgentSessionHealthForChannel(channelId, sessions = []) {
  const id = String(channelId || '').trim();
  if (!id) return 0;
  const rows = (Array.isArray(sessions) ? sessions : []).map(sanitizeForStorage).filter((row) => row?.record_id);
  let changed = 0;
  for (const row of rows) changed += await upsertAgentSessionHealth(row) ? 1 : 0;
  // Absence and lease expiry are not proof that a runtime stopped.
  return changed;
}

export async function getAgentSessionHealthForChannel(channelId) {
  const id = String(channelId || '').trim();
  if (!id) return [];
  return wsDb().agent_session_health.where('channel_id').equals(id).toArray();
}

export async function pruneExpiredAgentActivities() {
  // expires_at describes live freshness, never history retention or completion.
  return 0;
}

export async function deleteRuntimeRecordByFamily(familyIdOrHash, recordId) {
  const family = getSyncFamily(familyIdOrHash);
  const tableName = family?.table;
  if (!tableName || !recordId) return 0;
  const db = wsDb();
  const table = db[tableName];
  if (!table) return 0;
  return table.where('record_id').equals(recordId).delete();
}

// ---------------------------------------------------------------------------
// audio notes — workspace DB
// ---------------------------------------------------------------------------

export async function getAudioNotesByOwner(ownerNpub) {
  const rows = await wsDb().audio_notes.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function upsertAudioNote(audioNote) {
  return wsDb().audio_notes.put(sanitizeForStorage(audioNote));
}

export async function replaceAudioNotesForOwner(ownerNpub, audioNotes = []) {
  if (!ownerNpub) return 0;
  const rows = (Array.isArray(audioNotes) ? audioNotes : [])
    .map((audioNote) => sanitizeForStorage(audioNote))
    .filter((audioNote) => audioNote?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.audio_notes, async () => {
    await db.audio_notes.where('owner_npub').equals(ownerNpub).delete();
    if (rows.length > 0) await db.audio_notes.bulkPut(rows);
    return rows.length;
  });
}

export async function replacePgAudioNotesForChannel(channelId, audioNotes = []) {
  if (!channelId) return 0;
  const rows = (Array.isArray(audioNotes) ? audioNotes : [])
    .map((audioNote) => sanitizeForStorage(audioNote))
    .filter((audioNote) => audioNote?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.audio_notes, async () => {
    const existing = await db.audio_notes.toArray();
    const pgAudioNoteIds = existing
      .filter((audioNote) => audioNote?.pg_backend === true && audioNote?.pg_channel_id === channelId)
      .map((audioNote) => audioNote.record_id)
      .filter(Boolean);
    if (pgAudioNoteIds.length > 0) await db.audio_notes.bulkDelete(pgAudioNoteIds);
    if (rows.length > 0) await db.audio_notes.bulkPut(rows);
    return rows.length;
  });
}

export async function getAudioNoteById(recordId) {
  return wsDb().audio_notes.get(recordId);
}

// ---------------------------------------------------------------------------
// scopes — workspace DB
// ---------------------------------------------------------------------------

export async function getScopesByOwner(ownerNpub) {
  const rows = await wsDb().scopes.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getRecentScopeChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().scopes.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('scopes', options));
}

export async function upsertScope(scope) {
  return wsDb().scopes.put(scope);
}

export async function upsertPgListedScope(scope) {
  const db = wsDb();
  return db.transaction('rw', db.scopes, db.pending_writes, db.pg_record_rows, async () => {
    const existing = await db.scopes.get(scope.record_id);
    const canonical = await db.pg_record_rows.get(`scope:${scope.record_id}`);
    if (canonical?.operation === 'delete' || canonical?.row?.deleted_at
      || Number(canonical?.row?.row_version || 0) > Number(scope.version || 0)
      || Number(existing?.version || 0) > Number(scope.version || 0)) return existing;
    if (['pending', 'failed'].includes(existing?.sync_status) || existing?.pg_reconciliation_pending
      || await db.pending_writes.where('record_id').equals(scope.record_id).count()) return existing;
    return db.scopes.put(sanitizeForStorage(scope));
  });
}

export async function replaceScopesForOwner(ownerNpub, scopes = []) {
  if (!ownerNpub) return 0;
  const rows = (Array.isArray(scopes) ? scopes : [])
    .map((scope) => sanitizeForStorage(scope))
    .filter((scope) => scope?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.scopes, async () => {
    await db.scopes.where('owner_npub').equals(ownerNpub).delete();
    if (rows.length > 0) await db.scopes.bulkPut(rows);
    return rows.length;
  });
}

export async function getScopeById(recordId) {
  return wsDb().scopes.get(recordId);
}

// ---------------------------------------------------------------------------
// flows — workspace DB
// ---------------------------------------------------------------------------

export async function upsertFlow(flow) {
  return wsDb().flows.put(sanitizeForStorage(flow));
}

export async function getFlowById(recordId) {
  return wsDb().flows.get(recordId);
}

export async function getFlowsByScope(scopeId) {
  const rows = await wsDb().flows.where('scope_id').equals(scopeId).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getFlowsByOwner(ownerNpub) {
  const rows = await wsDb().flows.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getRecentFlowChangesSince(sinceIso, options = {}) {
  const rows = await wsDb().flows.where('updated_at').aboveOrEqual(sinceIso).toArray();
  const ordered = sortRowsByTimestamp(rows.filter((row) => row.record_state !== 'deleted'));
  if (!options.limit) return ordered;
  return takeNewestWindow(ordered, resolveWindowLimit('flows', options));
}

// ---------------------------------------------------------------------------
// approvals — workspace DB
// ---------------------------------------------------------------------------

export async function upsertApproval(approval) {
  return wsDb().approvals.put(sanitizeForStorage(approval));
}

export async function getApprovalById(recordId) {
  return wsDb().approvals.get(recordId);
}

export async function getApprovalsByScope(scopeId) {
  const rows = await wsDb().approvals.where('scope_id').equals(scopeId).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getApprovalsByStatus(status) {
  const rows = await wsDb().approvals.where('status').equals(status).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

export async function getAllApprovals() {
  const rows = await wsDb().approvals.toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

// ---------------------------------------------------------------------------
// workrooms — Tower PG workspace DB
// ---------------------------------------------------------------------------

function visibleWorkroomRow(row) {
  return row && row.record_state !== 'deleted' && !row.deleted_at;
}

export async function upsertWorkroom(workroom) {
  return wsDb().workrooms.put(sanitizeForStorage(workroom));
}

export async function getWorkroomById(recordId) {
  return wsDb().workrooms.get(recordId);
}

export async function getWorkroomsByChannel(channelId) {
  const rows = await wsDb().workrooms.where('channel_id').equals(channelId).toArray();
  return rows.filter(visibleWorkroomRow);
}

export async function getWorkroomsByWorkspace(workspaceId) {
  const rows = await wsDb().workrooms.where('workspace_id').equals(workspaceId).toArray();
  return rows.filter(visibleWorkroomRow);
}

export async function replacePgWorkroomsForChannel(channelId, workrooms = []) {
  if (!channelId) return 0;
  const rows = (Array.isArray(workrooms) ? workrooms : [])
    .map((workroom) => sanitizeForStorage(workroom))
    .filter((workroom) => workroom?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.workrooms, async () => {
    const existingIds = await db.workrooms
      .where('channel_id')
      .equals(channelId)
      .primaryKeys();
    if (existingIds.length > 0) await db.workrooms.bulkDelete(existingIds);
    if (rows.length > 0) await db.workrooms.bulkPut(rows);
    return rows.length;
  });
}

export async function replacePgWorkroomsForWorkspace(workspaceId, workrooms = []) {
  if (!workspaceId) return 0;
  const rows = (Array.isArray(workrooms) ? workrooms : [])
    .map((workroom) => sanitizeForStorage(workroom))
    .filter((workroom) => workroom?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.workrooms, async () => {
    const existingIds = await db.workrooms
      .where('workspace_id')
      .equals(workspaceId)
      .primaryKeys();
    if (existingIds.length > 0) await db.workrooms.bulkDelete(existingIds);
    if (rows.length > 0) await db.workrooms.bulkPut(rows);
    return rows.length;
  });
}

export async function replaceWorkroomParticipantsForRoom(workroomId, participants = []) {
  if (!workroomId) return 0;
  const rows = (Array.isArray(participants) ? participants : [])
    .map((participant) => sanitizeForStorage(participant))
    .filter((participant) => participant?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.workroom_participants, async () => {
    await db.workroom_participants.where('workroom_id').equals(workroomId).delete();
    if (rows.length > 0) await db.workroom_participants.bulkPut(rows);
    return rows.length;
  });
}

export async function getWorkroomParticipants(workroomId) {
  const rows = await wsDb().workroom_participants.where('workroom_id').equals(workroomId).toArray();
  return rows.filter((row) => row.record_state !== 'deleted' && row.status !== 'removed');
}

export async function replaceWorkroomEventsForRoom(workroomId, events = []) {
  if (!workroomId) return 0;
  const rows = (Array.isArray(events) ? events : [])
    .map((event) => sanitizeForStorage(event))
    .filter((event) => event?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.workroom_events, async () => {
    await db.workroom_events.where('workroom_id').equals(workroomId).delete();
    if (rows.length > 0) await db.workroom_events.bulkPut(rows);
    return rows.length;
  });
}

export async function getWorkroomEvents(workroomId) {
  const rows = await wsDb().workroom_events.where('workroom_id').equals(workroomId).toArray();
  return rows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

export async function replaceWorkroomLinksForRoom(workroomId, links = []) {
  if (!workroomId) return 0;
  const rows = (Array.isArray(links) ? links : [])
    .map((link) => sanitizeForStorage(link))
    .filter((link) => link?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.workroom_links, async () => {
    await db.workroom_links.where('workroom_id').equals(workroomId).delete();
    if (rows.length > 0) await db.workroom_links.bulkPut(rows);
    return rows.length;
  });
}

export async function getWorkroomLinks(workroomId) {
  const rows = await wsDb().workroom_links.where('workroom_id').equals(workroomId).toArray();
  return rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

export async function upsertWorkroomApproval(approval) {
  return wsDb().workroom_approvals.put(sanitizeForStorage(approval));
}

export async function getWorkroomApprovalById(recordId) {
  return wsDb().workroom_approvals.get(recordId);
}

export async function replaceWorkroomApprovalsForRoom(workroomId, approvals = []) {
  if (!workroomId) return 0;
  const rows = (Array.isArray(approvals) ? approvals : [])
    .map((approval) => sanitizeForStorage(approval))
    .filter((approval) => approval?.record_id);
  const db = wsDb();
  return db.transaction('rw', db.workroom_approvals, async () => {
    await db.workroom_approvals
      .where('target_id')
      .equals(workroomId)
      .and((approval) => approval.target_type === 'workroom')
      .delete();
    if (rows.length > 0) await db.workroom_approvals.bulkPut(rows);
    return rows.length;
  });
}

export async function getPendingWorkroomApprovals({ workroomId = null, channelId = null } = {}) {
  let rows = await wsDb().workroom_approvals.where('status').anyOf(['requested', 'in_review']).toArray();
  rows = rows.filter((row) => (
    row.target_type === 'workroom'
    && row.record_state !== 'deleted'
    && !row.deleted_at
  ));
  if (workroomId) rows = rows.filter((row) => row.target_id === workroomId);
  if (channelId) rows = rows.filter((row) => row.channel_id === channelId);
  return rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

// ---------------------------------------------------------------------------
// persons — workspace DB
// ---------------------------------------------------------------------------

export async function upsertPerson(person) {
  return wsDb().persons.put(sanitizeForStorage(person));
}

export async function getPersonById(recordId) {
  return wsDb().persons.get(recordId);
}

export async function getPersonsByOwner(ownerNpub) {
  const rows = await wsDb().persons.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

// ---------------------------------------------------------------------------
// organisations — workspace DB
// ---------------------------------------------------------------------------

export async function upsertOrganisation(organisation) {
  return wsDb().organisations.put(sanitizeForStorage(organisation));
}

export async function getOrganisationById(recordId) {
  return wsDb().organisations.get(recordId);
}

export async function getOrganisationsByOwner(ownerNpub) {
  const rows = await wsDb().organisations.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

// ---------------------------------------------------------------------------
// opportunities — workspace DB
// ---------------------------------------------------------------------------

export async function upsertOpportunity(opportunity) {
  return wsDb().opportunities.put(sanitizeForStorage(opportunity));
}

export async function getOpportunityById(recordId) {
  return wsDb().opportunities.get(recordId);
}

export async function getOpportunitiesByOwner(ownerNpub) {
  const rows = await wsDb().opportunities.where('owner_npub').equals(ownerNpub).toArray();
  return rows.filter((row) => row.record_state !== 'deleted');
}

// ---------------------------------------------------------------------------
// Bulk clear helpers — workspace DB
// ---------------------------------------------------------------------------

export async function clearRuntimeData() {
  const db = wsDb();
  await Promise.all([
    db.channels.clear(),
    db.chat_messages.clear(),
    db.documents.clear(),
    db.file_folders.clear(),
    db.directories.clear(),
    db.reports.clear(),
    db.daily_notes.clear(),
    db.wapps.clear(),
    db.wapp_publishing_grants.clear(),
    db.wapp_activity_items.clear(),
    db.wapp_activity_mutes.clear(),
    db.tasks.clear(),
    db.schedules.clear(),
    db.comments.clear(),
    db.reactions.clear(),
    db.response_activities.clear(),
    db.agent_activities.clear(),
    db.agent_activity_commentary.clear(),
    db.agent_session_health.clear(),
    db.autopilot_connections.clear(),
    db.workspace_agents.clear(),
    db.audio_notes.clear(),
    db.scopes.clear(),
    db.flows.clear(),
    db.approvals.clear(),
    db.workrooms.clear(),
    db.workroom_participants.clear(),
    db.workroom_events.clear(),
    db.workroom_links.clear(),
    db.workroom_approvals.clear(),
    db.persons.clear(),
    db.organisations.clear(),
    db.opportunities.clear(),
    db.sync_quarantine.clear(),
    db.groups.clear(),
    db.pending_writes.clear(),
    db.sync_state.clear(),
  ]);
}

export async function clearRuntimeFamilies(familyIds = []) {
  const tables = [...new Set(familyIds.map((familyId) => getSyncFamily(familyId)?.table).filter(Boolean))];
  if (tables.length === 0) return;
  const db = wsDb();
  await Promise.all(
    tables.map((tableName) => db[tableName]?.clear?.()).filter(Boolean)
  );
}

// ---------------------------------------------------------------------------
// read_cursors — workspace DB (for unread indicators)
// ---------------------------------------------------------------------------

export async function getReadCursor(recordId) {
  return wsDb().read_cursors.get(recordId);
}

export async function getReadCursorByKey(cursorKey, viewerNpub) {
  return wsDb().read_cursors
    .where('cursor_key').equals(cursorKey)
    .and((row) => row.viewer_npub === viewerNpub)
    .first();
}

export async function upsertReadCursor(cursor) {
  return wsDb().read_cursors.put(sanitizeForStorage(cursor));
}

export async function getAllReadCursors(viewerNpub) {
  return wsDb().read_cursors.where('viewer_npub').equals(viewerNpub).toArray();
}

export async function getReadCursorsByKeys(viewerNpub, cursorKeys = []) {
  const keys = [...new Set(cursorKeys.map((key) => String(key || '').trim()).filter(Boolean))];
  if (!viewerNpub || keys.length === 0) return [];
  return wsDb().read_cursors
    .where('cursor_key')
    .anyOf(keys)
    .and((row) => row.viewer_npub === viewerNpub)
    .toArray();
}

export async function getReadCursorsByPrefix(viewerNpub, cursorPrefix) {
  const prefix = String(cursorPrefix || '').trim();
  if (!viewerNpub || !prefix) return [];
  return wsDb().read_cursors
    .where('cursor_key')
    .between(prefix, `${prefix}\uffff`, true, true)
    .and((row) => row.viewer_npub === viewerNpub)
    .toArray();
}

export async function getWindowedTasksByOwner(ownerNpub, options = {}) {
  const rows = await getTasksByOwner(ownerNpub);
  return takeNewestWindow(rows, resolveWindowLimit('tasks', options));
}

export async function getWindowedDocumentsByOwner(ownerNpub, options = {}) {
  const rows = await getDocumentsByOwner(ownerNpub);
  return takeNewestWindow(rows, resolveWindowLimit('documents', options));
}

export async function getWindowedReportsByOwner(ownerNpub, options = {}) {
  const rows = await getReportsByOwner(ownerNpub);
  return takeNewestWindow(rows, resolveWindowLimit('reports', options));
}

export async function getWindowedWappsByOwner(ownerNpub, options = {}) {
  const rows = await getWappsByOwner(ownerNpub);
  return takeNewestWindow(rows, resolveWindowLimit('wapps', options));
}
