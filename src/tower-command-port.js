import { prepareFeedCommand } from './feed/tower.js';
import {
  addPendingWrite,
  replaceCommentRecord,
  replaceDocumentRecord,
  replaceMessageRecord,
  replaceTaskRecordId,
  upsertAudioNote,
  upsertComment,
  upsertChannel,
  upsertDocument,
  upsertFileFolder,
  upsertMessage,
  upsertReaction,
  upsertResourceViewState,
  upsertScope,
  upsertTask,
  upsertWapp,
  upsertWappActivityItem,
  upsertWappActivityMute,
  upsertWappPublishingGrant,
  upsertWorkroom,
  upsertWorkroomApproval,
  upsertDailyNote,
  deleteWappActivityMute,
  upsertAutopilotConnection,
  upsertWorkspaceAgent,
} from './db.js';
import * as pgWrites from './pg-write-adapter.js';
import * as api from './api.js';
import {
  mapPgChannelToLocal,
  mapPgDailyNoteToLocal,
  mapPgPersonalWappToLocal,
  mapPgReactionToLocal,
  mapPgScopeToLocal,
  mapPgWappActivityItemToLocal,
  mapPgWappActivityMuteToLocal,
  mapPgWappPublishingGrantToLocal,
  mapPgWorkroomApprovalToLocal,
  mapPgWorkroomToLocal,
} from './pg-read-hydrator.js';
import { mapTowerResourceViewState } from './resource-view-state.js';
import { toRaw } from './utils/state-helpers.js';
import { inboundAutopilotConnection, inboundWorkspaceAgent } from './translators/autopilot-connections.js';

export const TOWER_WORKSPACE_COMMAND_CONTRACT = Object.freeze({
  descriptorReconciled: Object.freeze([
    'context.create', 'context.update', 'context.attach', 'context.unlink', 'context.delete',
    'feed-subscription.create', 'feed-subscription.patch', 'feed-state.patch',
    'record-conflict.accept-remote',
    'task.create', 'task.update', 'task.delete', 'task.move', 'task-comment.create',
    'document.create', 'document.update', 'document.delete', 'document.move',
    'document-comment.create', 'document-comment.update', 'document-comment.delete',
    'message.create', 'message.update', 'message.delete',
    'thread.branch',
    'file.create', 'file.update', 'file-folder.create', 'audio-note.create',
    'scope.create', 'scope.update', 'scope.delete',
    'channel.create', 'channel.update', 'channel.delete',
    'workroom.create', 'workroom.start', 'workroom.archive', 'workroom-approval.decide',
    'reaction.create', 'reaction.delete',
    'wapp.create', 'wapp.update', 'wapp.delete',
    'wapp-publishing-grant.put', 'wapp-publishing-grant.disable',
    'wapp-publishing-grant.revoke', 'wapp-publishing-grant.rotate',
    'wapp-activity.patch', 'wapp-activity-mute.put', 'wapp-activity-mute.delete',
    'wapp-delegation.list', 'wapp-delegation.create', 'wapp-delegation.revoke',
    'wapp-install-intent.list', 'wapp-install-intent.create', 'wapp-installation.list',
    'wapp-installation.reconcile', 'wapp-installation.revoke',
    'daily-note.upsert', 'resource-view-state.put',
    'autopilot-connection.create', 'autopilot-connection.update', 'workspace-agent.create',
  ]),
  acknowledgementWithTargetedCoverage: Object.freeze([
    'task.assignments.sync', 'thread.delete', 'thread.archive', 'thread.title.update',
    'channel.reorder', 'channel-grant.create', 'channel-grant.update', 'channel-grant.delete',
    'workspace.update', 'personal-agent-settings.update', 'workspace.delete', 'workspace.bootstrap',
    'workspace-member.create', 'workspace-member.profile.update', 'workspace-group.create',
    'workspace-group-member.add', 'workspace-group-member.remove',
    'workspace-child-group.add', 'workspace-child-group.remove',
    'notification-preferences.update', 'push-subscription.upsert', 'push-subscription.revoke',
    'wapp.reorder', 'daily-scope-access.upsert', 'invocation.create',
    'document-metadata.update', 'file-metadata.update',
    'compatibility.pending-write',
  ]),
});

export const TOWER_WORKSPACE_COMMAND_NAMES = Object.freeze([
  ...TOWER_WORKSPACE_COMMAND_CONTRACT.descriptorReconciled,
  ...TOWER_WORKSPACE_COMMAND_CONTRACT.acknowledgementWithTargetedCoverage,
]);

function sameRow(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneableRow(row = {}, patch = {}) {
  return toRaw({ ...row, ...patch });
}

function optimisticWriterFor(input) {
  if (input.task) return upsertTask;
  if (input.document || input.file) return upsertDocument;
  if (input.comment) return upsertComment;
  if (input.message) return upsertMessage;
  if (input.folder) return upsertFileFolder;
  if (input.audioNote) return upsertAudioNote;
  return null;
}

async function reconcileTypedCommand(name, result, { owner = '', args = [] } = {}) {
  if (['workroom.create', 'workroom.start', 'workroom.archive'].includes(name)) {
    const row = mapPgWorkroomToLocal(result?.workroom || result);
    if (row.record_id) await upsertWorkroom(row);
  } else if (name === 'workroom-approval.decide') {
    const row = mapPgWorkroomApprovalToLocal(result?.approval || result);
    if (row.record_id) await upsertWorkroomApproval(row);
  } else if (['reaction.create', 'reaction.delete'].includes(name)) {
    const row = mapPgReactionToLocal(result?.reaction || result, { workspaceOwnerNpub: owner });
    if (row.record_id) await upsertReaction(name === 'reaction.delete' ? { ...row, record_state: 'deleted' } : row);
  } else if (['wapp.create', 'wapp.update', 'wapp.delete'].includes(name)) {
    const row = mapPgPersonalWappToLocal(result?.personal_wapp || result?.wapp || result, { workspaceOwnerNpub: owner });
    if (row.record_id) await upsertWapp(name === 'wapp.delete' ? { ...row, record_state: 'deleted' } : row);
  } else if (name.startsWith('wapp-publishing-grant.')) {
    const row = mapPgWappPublishingGrantToLocal(result?.grant || result);
    if (row.wapp_installation_id) await upsertWappPublishingGrant(row);
  } else if (name === 'wapp-activity.patch') {
    const row = mapPgWappActivityItemToLocal(result?.item || result?.activity || result);
    if (row.record_id) await upsertWappActivityItem(row);
  } else if (name === 'wapp-activity-mute.put') {
    const row = mapPgWappActivityMuteToLocal(result?.mute || result);
    if (row.record_id) await upsertWappActivityMute(row);
  } else if (name === 'wapp-activity-mute.delete') {
    const recordId = String(result?.mute?.id || result?.id || '').trim();
    if (recordId) await deleteWappActivityMute(recordId);
  } else if (name === 'daily-note.upsert') {
    const row = mapPgDailyNoteToLocal(result?.daily_note || result?.note || result, { workspaceOwnerNpub: owner });
    if (row.record_id) await upsertDailyNote(row);
  } else if (name === 'resource-view-state.put') {
    const row = mapTowerResourceViewState(result?.view_state || result?.resource_view_state || result, { workspaceId: args[0] });
    if (row?.record_id) await upsertResourceViewState(row);
  } else if (name === 'autopilot-connection.create' || name === 'autopilot-connection.update') {
    const row = inboundAutopilotConnection(result?.autopilot_connection || result);
    if (row.id) await upsertAutopilotConnection(row);
  } else if (name === 'workspace-agent.create') {
    const row = inboundWorkspaceAgent(result?.workspace_agent || result);
    if (row.id) await upsertWorkspaceAgent(row);
  }
  return result;
}

export function prepareTowerWorkspaceCommand(store, name, input = {}) {
  if (['context.create', 'context.update', 'context.attach', 'context.unlink', 'context.delete'].includes(name)) {
    return {
      entityKey: `context:${input.scopeId}:${input.componentId || 'new'}`,
      execute: () => pgWrites.writeTowerPgContext(store, name.split('.')[1], input),
      reconcile: async result => {
        // Acknowledgement is not convergence: subtree responses contain counts,
        // and canonical worker recovery publishes the complete authority batch.
        await store.runTowerPgWorkspaceSync({ force: true });
        return result;
      },
    };
  }
  if (name.startsWith('feed-subscription.') || name === 'feed-state.patch') return prepareFeedCommand(store, name, input);
  if (name === 'thread.branch') {
    return {
      entityKey: `thread.branch:${input.clientRequestId || input.message?.record_id || ''}`,
      execute: () => pgWrites.branchTowerPgThreadFromMessage(store, input.message, {
        clientRequestId: input.clientRequestId,
        recipientNpub: input.recipientNpub,
        parentThreadId: input.parentThreadId,
      }),
      reconcile: async (thread) => {
        if (thread?.record_id) await upsertMessage(thread);
        return thread;
      },
    };
  }
  const typedApiCommandName = {
    'workroom.create': 'createTowerPgWorkroom',
    'workroom.start': 'startTowerPgWorkroom',
    'workroom.archive': 'archiveTowerPgWorkroom',
    'channel.update': 'updateTowerPgChannel',
    'channel.create': 'createTowerPgScopeChannel',
    'channel.delete': 'deleteTowerPgChannel',
    'channel.reorder': 'reorderTowerPgChannel',
    'channel-grant.create': 'createTowerPgChannelGrant',
    'channel-grant.update': 'updateTowerPgChannelGrant',
    'channel-grant.delete': 'deleteTowerPgChannelGrant',
    'scope.create': 'createTowerPgWorkspaceScope',
    'scope.update': 'updateTowerPgWorkspaceScope',
    'scope.delete': 'deleteTowerPgWorkspaceScope',
    'workspace.update': 'updateTowerPgWorkspace',
    'personal-agent-settings.update': 'updateTowerPgPersonalAgentSettings',
    'workspace.delete': 'deleteTowerPgWorkspace',
    'workspace.bootstrap': 'createTowerPgAdminWorkspace',
    'workspace-member.create': 'createTowerPgWorkspaceMember',
    'workspace-member.profile.update': 'updateTowerPgWorkspaceMemberProfile',
    'workspace-group.create': 'createTowerPgWorkspaceGroup',
    'workspace-group-member.add': 'addTowerPgWorkspaceGroupMember',
    'workspace-group-member.remove': 'removeTowerPgWorkspaceGroupMember',
    'workspace-child-group.add': 'addTowerPgWorkspaceChildGroup',
    'workspace-child-group.remove': 'removeTowerPgWorkspaceChildGroup',
    'notification-preferences.update': 'updateTowerPgNotificationPreferences',
    'push-subscription.upsert': 'upsertTowerPgPushSubscription',
    'push-subscription.revoke': 'revokeTowerPgPushSubscription',
    'workroom-approval.decide': 'decideTowerPgApproval',
    'reaction.create': 'createTowerPgReaction',
    'reaction.delete': 'deleteTowerPgReaction',
    'wapp.create': 'createTowerPgPersonalWapp',
    'wapp.update': 'updateTowerPgPersonalWapp',
    'wapp.delete': 'deleteTowerPgPersonalWapp',
    'wapp.reorder': 'reorderTowerPgPersonalWapps',
    'wapp-publishing-grant.put': 'putTowerPgWappPublishingGrant',
    'wapp-publishing-grant.disable': 'disableTowerPgWappPublishingGrant',
    'wapp-publishing-grant.revoke': 'revokeTowerPgWappPublishingGrant',
    'wapp-publishing-grant.rotate': 'rotateTowerPgWappPublishingGrant',
    'wapp-activity.patch': 'patchTowerPgWappActivityUserState',
    'wapp-activity-mute.put': 'putTowerPgWappActivityMute',
    'wapp-activity-mute.delete': 'deleteTowerPgWappActivityMute',
    'wapp-delegation.list': 'getTowerPgWappDelegations',
    'wapp-delegation.create': 'createTowerPgWappDelegation',
    'wapp-delegation.revoke': 'revokeTowerPgWappDelegation',
    'wapp-install-intent.list': 'getTowerPgWappInstallIntents',
    'wapp-install-intent.create': 'createTowerPgWappInstallIntent',
    'wapp-installation.list': 'getTowerPgManagedWappInstallations',
    'wapp-installation.reconcile': 'reconcileTowerPgManagedWappInstallation',
    'wapp-installation.revoke': 'revokeTowerPgManagedWappInstallation',
    'daily-note.upsert': 'upsertTowerPgDailyNote',
    'daily-scope-access.upsert': 'upsertTowerPgDailyScopeAgentAccess',
    'invocation.create': 'createTowerPgInvocation',
    'resource-view-state.put': 'putTowerPgResourceViewState',
    'autopilot-connection.create': 'createTowerPgAutopilotConnection',
    'autopilot-connection.update': 'updateTowerPgAutopilotConnection',
    'workspace-agent.create': 'createTowerPgWorkspaceAgent',
    'document-metadata.update': 'updateTowerPgDoc',
    'file-metadata.update': 'updateTowerPgFile',
  }[name];
  if (typedApiCommandName) {
    const args = Array.isArray(input.args) ? input.args : [];
    const owner = store.workspaceOwnerNpub || store.currentWorkspaceOwnerNpub || '';
    const previousScope = name === 'scope.update' || name === 'scope.delete'
      ? (store.scopes || []).find((row) => row?.record_id === args[1])
      : null;
    const previousChannel = name === 'channel.update' || name === 'channel.delete'
      ? (store.channels || []).find((row) => row?.record_id === args[1])
      : null;
    const optimistic = {
      'scope.create': () => upsertScope(mapPgScopeToLocal({ id: args[1]?.client_record_id, ...args[1] }, { workspaceOwnerNpub: owner })),
      'scope.update': () => previousScope ? upsertScope(cloneableRow(previousScope, { title: args[2]?.name ?? previousScope.title, description: args[2]?.description ?? previousScope.description, sync_status: 'pending' })) : undefined,
      'scope.delete': () => previousScope ? upsertScope(cloneableRow(previousScope, { record_state: 'deleted', sync_status: 'pending' })) : undefined,
      'channel.create': () => upsertChannel(mapPgChannelToLocal({ id: args[2]?.client_record_id, scope_id: args[1], ...args[2] }, { workspaceOwnerNpub: owner })),
      'channel.update': () => previousChannel ? upsertChannel(cloneableRow(previousChannel, { ...args[2], sync_status: 'pending' })) : undefined,
      'channel.delete': () => previousChannel ? upsertChannel(cloneableRow(previousChannel, { record_state: 'deleted', sync_status: 'pending' })) : undefined,
    }[name];
    const reconcile = {
      'scope.create': async (result) => {
        const row = mapPgScopeToLocal(result?.scope || result, { workspaceOwnerNpub: owner });
        if (args[1]?.client_record_id && row.record_id !== args[1].client_record_id) {
          await upsertScope({ ...mapPgScopeToLocal({ id: args[1].client_record_id, ...args[1] }, { workspaceOwnerNpub: owner }), record_state: 'deleted' });
        }
        await upsertScope(row);
        return result;
      },
      'scope.update': async (result) => {
        await upsertScope(mapPgScopeToLocal(result?.scope || result, { workspaceOwnerNpub: owner }));
        return result;
      },
      'scope.delete': () => previousScope ? upsertScope(cloneableRow(previousScope, { record_state: 'deleted', sync_status: 'synced' })) : undefined,
      'channel.create': async (result) => {
        const row = mapPgChannelToLocal(result?.channel || result, { workspaceOwnerNpub: owner });
        if (args[2]?.client_record_id && row.record_id !== args[2].client_record_id) {
          await upsertChannel({ ...mapPgChannelToLocal({ id: args[2].client_record_id, scope_id: args[1], ...args[2] }, { workspaceOwnerNpub: owner }), record_state: 'deleted' });
        }
        await upsertChannel(row);
        return result;
      },
      'channel.update': async (result) => {
        await upsertChannel(mapPgChannelToLocal(result?.channel || result, { workspaceOwnerNpub: owner }));
        return result;
      },
      'channel.delete': () => previousChannel ? upsertChannel(cloneableRow(previousChannel, { record_state: 'deleted', sync_status: 'synced' })) : undefined,
    }[name];
    const fail = {
      'scope.create': () => upsertScope({ ...mapPgScopeToLocal({ id: args[1]?.client_record_id, ...args[1] }, { workspaceOwnerNpub: owner }), sync_status: 'failed' }),
      'scope.update': () => previousScope ? upsertScope(toRaw(previousScope)) : undefined,
      'scope.delete': () => previousScope ? upsertScope(toRaw(previousScope)) : undefined,
      'channel.create': () => upsertChannel({ ...mapPgChannelToLocal({ id: args[2]?.client_record_id, scope_id: args[1], ...args[2] }, { workspaceOwnerNpub: owner }), sync_status: 'failed' }),
      'channel.update': () => previousChannel ? upsertChannel(toRaw(previousChannel)) : undefined,
      'channel.delete': () => previousChannel ? upsertChannel(toRaw(previousChannel)) : undefined,
    }[name];
    return {
      entityKey: `${name}:${String(input.entityId || input.clientMutationId || '')}`,
      optimistic,
      execute: () => api[typedApiCommandName](...args),
      reconcile: reconcile || ((result) => reconcileTypedCommand(name, result, { owner, args })),
      fail,
    };
  }
  if (name === 'record-conflict.accept-remote') {
    return { entityKey: `record-conflict:${input.key}`,
      execute: () => store.materializeTowerPgWorkspaceBundle({ protocol_version: 1, reconcile_commands: true, accept_remote_key: input.key }) };
  }
  if (name === 'compatibility.pending-write') {
    const pendingWrite = input.pendingWrite;
    if (!pendingWrite?.record_id || !pendingWrite?.record_family_hash || !pendingWrite?.envelope) {
      throw new Error('compatibility.pending-write requires a complete pending write');
    }
    return {
      entityKey: `pending-write:${pendingWrite.record_family_hash}:${pendingWrite.record_id}`,
      execute: () => addPendingWrite(pendingWrite),
    };
  }
  const generic = {
    'task.create': () => pgWrites.createTowerPgTaskFromLocal(store, input.task),
    'task.update': () => pgWrites.updateTowerPgTaskFromLocal(store, input.task, input.previousTask, input.patch),
    'task.delete': () => pgWrites.deleteTowerPgTaskFromLocal(store, input.task),
    'task.move': () => pgWrites.moveTowerPgTaskFromLocal(store, input.task, input.destinationChannelId, input.destinationScopeId),
    'task.assignments.sync': () => pgWrites.syncTowerPgTaskAssignments(store, input.taskId, input.previousNpubs, input.nextNpubs, input.contextOverride),
    'document.create': () => pgWrites.createTowerPgDocFromLocal(store, input.document),
    'document.update': () => pgWrites.updateTowerPgDocFromLocal(store, input.document, input.previousDocument),
    'document.delete': () => pgWrites.deleteTowerPgDocFromLocal(store, input.document),
    'document.move': () => pgWrites.moveTowerPgDocFromLocal(store, input.document, input.destinationChannelId, input.destinationScopeId),
    'document-comment.create': () => pgWrites.createTowerPgDocCommentFromLocal(store, input.comment),
    'document-comment.update': () => pgWrites.updateTowerPgDocCommentFromLocal(store, input.comment),
    'document-comment.delete': () => pgWrites.deleteTowerPgDocCommentFromLocal(store, input.comment),
    'message.create': () => input.options === undefined
      ? pgWrites.createTowerPgMessageFromLocal(store, input.message)
      : pgWrites.createTowerPgMessageFromLocal(store, input.message, input.options),
    'message.update': () => pgWrites.updateTowerPgMessageFromLocal(store, input.message, input.patch),
    'message.delete': () => pgWrites.deleteTowerPgMessageFromLocal(store, input.message),
    'thread.delete': () => pgWrites.deleteTowerPgThreadFromLocal(store, input.parentMessage),
    'thread.archive': () => pgWrites.archiveTowerPgThreadFromLocal(store, input.parentMessage, input.archived),
    'thread.title.update': () => pgWrites.updateTowerPgThreadTitleFromLocal(store, input.threadRow, input.title),
    'file.create': () => pgWrites.createTowerPgFileFromLocal(store, input.file),
    'file.update': () => pgWrites.updateTowerPgFileFromLocal(store, input.file, input.previous),
    'file-folder.create': () => pgWrites.createTowerPgFileFolderFromLocal(store, input.folder),
    'audio-note.create': () => pgWrites.createTowerPgAudioNoteFromLocal(store, input.audioNote),
  }[name];
  if (name !== 'task-comment.create') {
    if (!generic) return null;
    const localRow = input.task || input.document || input.comment || input.message || input.file || input.folder || input.audioNote;
    const previousRow = input.previousTask || input.previousDocument || input.previous || input.parentMessage || input.threadRow;
    const optimisticWriter = optimisticWriterFor(input);
    const reconcile = async (accepted) => {
      if (!accepted || !optimisticWriter) return accepted;
      const localId = String(localRow?.record_id || '').trim();
      const acceptedId = String(accepted?.record_id || '').trim();
      if (localId && acceptedId && localId !== acceptedId) {
        if (input.task) await replaceTaskRecordId(localId, accepted);
        else if (input.document || input.file) await replaceDocumentRecord(localId, accepted);
        else if (input.comment) await replaceCommentRecord(localId, accepted);
        else if (input.message) await replaceMessageRecord(localId, accepted);
        else await optimisticWriter(accepted);
      } else {
        await optimisticWriter(accepted);
      }
      return accepted;
    };
    return {
      entityKey: `${name}:${localRow?.record_id || input.taskId || ''}`,
      optimistic: localRow && optimisticWriter ? () => optimisticWriter(localRow) : undefined,
      execute: generic,
      reconcile,
      fail: previousRow && optimisticWriter ? () => optimisticWriter(previousRow) : undefined,
    };
  }
  const localRow = input.localRow;
  const pgContext = input.pgContext;
  if (!localRow?.record_id || !pgContext?.workspaceId) {
    throw new Error('task-comment.create requires a local row and PG workspace context');
  }
  return {
    entityKey: `comment:${localRow.record_id}`,
    optimistic: () => upsertComment(localRow),
    execute: () => pgWrites.createTowerPgTaskCommentFromLocal(store, localRow, pgContext),
    async reconcile(serverRow) {
      const accepted = {
        ...localRow,
        ...serverRow,
        pg_client_record_id: localRow.record_id,
        pg_reconciliation_pending: true,
      };
      if (!sameRow(localRow, accepted)) await replaceCommentRecord(localRow.record_id, accepted);
      return accepted;
    },
    fail: (error) => upsertComment({
      ...localRow,
      sync_status: 'failed',
      sync_error: error?.message || String(error),
      updated_at: new Date().toISOString(),
    }),
  };
}
