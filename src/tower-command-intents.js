import { prepareTowerWorkspaceCommand } from './tower-command-port.js';

function issue(store, name, input, clientMutationId = '') {
  if (typeof store.commandTowerWorkspace === 'function') {
    return store.commandTowerWorkspace(name, input, { clientMutationId });
  }
  // Isolated manager tests and deliberately standalone compatibility callers
  // do not construct the Alpine sync mixin. They still use the same command
  // registry, but execute its transport descriptor without service lifecycle.
  const descriptor = prepareTowerWorkspaceCommand(store, name, input);
  if (!descriptor) throw new Error(`Tower command is not registered for ${name}`);
  return descriptor.execute();
}

function mutationKey(row = {}, suffix = '') {
  return [row?.record_id, row?.version, row?.updated_at, suffix].map((value) => String(value ?? '').trim()).join(':');
}

function issueTypedApi(store, name, args, entityId = '') {
  return issue(store, name, { args, entityId }, entityId);
}

export const createTowerPgWorkroom = (store, ...args) => issueTypedApi(store, 'workroom.create', args, args[1]?.client_record_id || args[1]?.record_id);
export const startTowerPgWorkroom = (store, ...args) => issueTypedApi(store, 'workroom.start', args, args[1]);
export const archiveTowerPgWorkroom = (store, ...args) => issueTypedApi(store, 'workroom.archive', args, args[1]);
export const updateTowerPgChannel = (store, ...args) => issueTypedApi(store, 'channel.update', args, args[1]);
export const createTowerPgScopeChannel = (store, workspaceId, scopeId, body = {}, options) => {
  const commandBody = { ...body, client_record_id: body.client_record_id || body.record_id || crypto.randomUUID() };
  return issueTypedApi(store, 'channel.create', [workspaceId, scopeId, commandBody, options], commandBody.client_record_id);
};
export const deleteTowerPgChannel = (store, ...args) => issueTypedApi(store, 'channel.delete', args, args[1]);
export const reorderTowerPgChannel = (store, ...args) => issueTypedApi(store, 'channel.reorder', args, args[1]);
export const createTowerPgChannelGrant = (store, ...args) => issueTypedApi(store, 'channel-grant.create', args, `${args[1]}:${args[2]?.principal_id || ''}`);
export const updateTowerPgChannelGrant = (store, ...args) => issueTypedApi(store, 'channel-grant.update', args, `${args[1]}:${args[2]}:${args[3]}`);
export const deleteTowerPgChannelGrant = (store, ...args) => issueTypedApi(store, 'channel-grant.delete', args, `${args[1]}:${args[2]}:${args[3]}`);
export const createTowerPgWorkspaceScope = (store, workspaceId, body = {}, options) => {
  const commandBody = { ...body, client_record_id: body.client_record_id || body.record_id || crypto.randomUUID() };
  return issueTypedApi(store, 'scope.create', [workspaceId, commandBody, options], commandBody.client_record_id);
};
export const updateTowerPgWorkspaceScope = (store, ...args) => issueTypedApi(store, 'scope.update', args, args[1]);
export const deleteTowerPgWorkspaceScope = (store, ...args) => issueTypedApi(store, 'scope.delete', args, args[1]);
export const updateTowerPgWorkspace = (store, ...args) => issueTypedApi(store, 'workspace.update', args, args[0]);
export const updateTowerPgPersonalAgentSettings = (store, ...args) => issueTypedApi(store, 'personal-agent-settings.update', args, args[0]);
export const deleteTowerPgWorkspace = (store, ...args) => issueTypedApi(store, 'workspace.delete', args, args[0]);
export const createTowerPgAdminWorkspace = (store, ...args) => issueTypedApi(store, 'workspace.bootstrap', args, args[0]?.workspace_id || args[0]?.client_record_id);
export const createTowerPgWorkspaceMember = (store, ...args) => issueTypedApi(store, 'workspace-member.create', args, args[1]?.user_npub || args[1]?.npub);
export const updateTowerPgWorkspaceMemberProfile = (store, ...args) => issueTypedApi(store, 'workspace-member.profile.update', args, args[1]);
export const createTowerPgWorkspaceGroup = (store, ...args) => issueTypedApi(store, 'workspace-group.create', args, args[1]?.client_record_id || args[1]?.group_id);
export const addTowerPgWorkspaceGroupMember = (store, ...args) => issueTypedApi(store, 'workspace-group-member.add', args, `${args[1]}:${args[2]?.actor_id || args[2]?.member_npub || ''}`);
export const removeTowerPgWorkspaceGroupMember = (store, ...args) => issueTypedApi(store, 'workspace-group-member.remove', args, `${args[1]}:${args[2]}`);
export const addTowerPgWorkspaceChildGroup = (store, ...args) => issueTypedApi(store, 'workspace-child-group.add', args, `${args[1]}:${args[2]?.child_group_id || ''}`);
export const removeTowerPgWorkspaceChildGroup = (store, ...args) => issueTypedApi(store, 'workspace-child-group.remove', args, `${args[1]}:${args[2]}`);
export const updateTowerPgNotificationPreferences = (store, ...args) => issueTypedApi(store, 'notification-preferences.update', args, 'notification-preferences');
export const upsertTowerPgPushSubscription = (store, ...args) => issueTypedApi(store, 'push-subscription.upsert', args, args[1]?.endpoint || 'push-subscription');
export const revokeTowerPgPushSubscription = (store, ...args) => issueTypedApi(store, 'push-subscription.revoke', args, args[1]);
export const decideTowerPgApproval = (store, ...args) => issueTypedApi(store, 'workroom-approval.decide', args, args[1]);
export const createTowerPgReaction = (store, ...args) => issueTypedApi(store, 'reaction.create', args, args[1]?.client_record_id || args[1]?.record_id);
export const deleteTowerPgReaction = (store, ...args) => issueTypedApi(store, 'reaction.delete', args, args[1]);
export const createTowerPgPersonalWapp = (store, ...args) => issueTypedApi(store, 'wapp.create', args, args[1]?.client_record_id || args[1]?.record_id);
export const updateTowerPgPersonalWapp = (store, ...args) => issueTypedApi(store, 'wapp.update', args, args[1]);
export const deleteTowerPgPersonalWapp = (store, ...args) => issueTypedApi(store, 'wapp.delete', args, args[1]);
export const reorderTowerPgPersonalWapps = (store, ...args) => issueTypedApi(store, 'wapp.reorder', args, 'personal-wapps');
export const putTowerPgWappPublishingGrant = (store, ...args) => issueTypedApi(store, 'wapp-publishing-grant.put', args, args[1]);
export const disableTowerPgWappPublishingGrant = (store, ...args) => issueTypedApi(store, 'wapp-publishing-grant.disable', args, args[1]);
export const revokeTowerPgWappPublishingGrant = (store, ...args) => issueTypedApi(store, 'wapp-publishing-grant.revoke', args, args[1]);
export const rotateTowerPgWappPublishingGrant = (store, ...args) => issueTypedApi(store, 'wapp-publishing-grant.rotate', args, args[1]);
export const patchTowerPgWappActivityUserState = (store, ...args) => issueTypedApi(store, 'wapp-activity.patch', args, args[1]);
export const putTowerPgWappActivityMute = (store, ...args) => issueTypedApi(store, 'wapp-activity-mute.put', args, `${args[1]}:${args[2]}`);
export const deleteTowerPgWappActivityMute = (store, ...args) => issueTypedApi(store, 'wapp-activity-mute.delete', args, `${args[1]}:${args[2]}`);
export const getTowerPgWappDelegations = (store, ...args) => issueTypedApi(store, 'wapp-delegation.list', args, 'delegations');
export const createTowerPgWappDelegation = (store, ...args) => issueTypedApi(store, 'wapp-delegation.create', args, args[1]?.delegate_actor_id || crypto.randomUUID());
export const revokeTowerPgWappDelegation = (store, ...args) => issueTypedApi(store, 'wapp-delegation.revoke', args, args[1]);
export const getTowerPgWappInstallIntents = (store, ...args) => issueTypedApi(store, 'wapp-install-intent.list', args, 'install-intents');
export const createTowerPgWappInstallIntent = (store, ...args) => issueTypedApi(store, 'wapp-install-intent.create', args, args[1]?.client_request_id);
export const getTowerPgManagedWappInstallations = (store, ...args) => issueTypedApi(store, 'wapp-installation.list', args, 'installations');
export const reconcileTowerPgManagedWappInstallation = (store, ...args) => issueTypedApi(store, 'wapp-installation.reconcile', args, args[1]);
export const revokeTowerPgManagedWappInstallation = (store, ...args) => issueTypedApi(store, 'wapp-installation.revoke', args, args[1]);
export const upsertTowerPgDailyNote = (store, ...args) => issueTypedApi(store, 'daily-note.upsert', args, args[1]?.id || args[1]?.note_date);
export const upsertTowerPgDailyScopeAgentAccess = (store, ...args) => issueTypedApi(store, 'daily-scope-access.upsert', args, args[1]?.agent_npub || 'daily-scope-access');
export const createTowerPgInvocation = (store, ...args) => issueTypedApi(store, 'invocation.create', args, args[1]?.client_record_id || args[1]?.id);
export const putTowerPgResourceViewState = (store, ...args) => issueTypedApi(store, 'resource-view-state.put', args, `${args[1]}:${args[2]}`);
export const createTowerPgAutopilotConnection = (store, ...args) => issueTypedApi(store, 'autopilot-connection.create', args, args[1]?.installation_id);
export const updateTowerPgAutopilotConnection = (store, ...args) => issueTypedApi(store, 'autopilot-connection.update', args, args[1]);
export const createTowerPgWorkspaceAgent = (store, ...args) => issueTypedApi(store, 'workspace-agent.create', args, `${args[1]?.connection_id}:${args[1]?.agent_id}`);
export const updateTowerPgDocumentMetadata = (store, ...args) => issueTypedApi(store, 'document-metadata.update', args, args[1]);
export const updateTowerPgFileMetadata = (store, ...args) => issueTypedApi(store, 'file-metadata.update', args, args[1]);
export const queueTowerPendingWrite = (store, pendingWrite) => issue(
  store,
  'compatibility.pending-write',
  { pendingWrite },
  `${pendingWrite?.record_family_hash || ''}:${pendingWrite?.record_id || ''}:${pendingWrite?.envelope?.version || ''}`,
);

export const createTowerPgTaskFromLocal = (store, task) => issue(store, 'task.create', { task }, task?.record_id);
export const updateTowerPgTaskFromLocal = (store, task, previousTask = null, patch = {}) => issue(store, 'task.update', { task, previousTask, patch }, mutationKey(task));
export const deleteTowerPgTaskFromLocal = (store, task) => issue(store, 'task.delete', { task }, mutationKey(task, 'delete'));
export const moveTowerPgTaskFromLocal = (store, task, destinationChannelId, destinationScopeId = null) => issue(store, 'task.move', { task, destinationChannelId, destinationScopeId }, mutationKey(task, destinationChannelId));
export const syncTowerPgTaskAssignments = (store, taskId, previousNpubs = [], nextNpubs = [], contextOverride = null) => issue(store, 'task.assignments.sync', { taskId, previousNpubs, nextNpubs, contextOverride }, `${taskId}:${nextNpubs.join(',')}`);
export const createTowerPgTaskCommentFromLocal = (store, localRow, pgContext = null) => issue(store, 'task-comment.create', { localRow, pgContext }, localRow?.record_id);
export const createTowerPgDocFromLocal = (store, document) => issue(store, 'document.create', { document }, document?.record_id);
export const updateTowerPgDocFromLocal = (store, document, previousDocument = null) => issue(store, 'document.update', { document, previousDocument }, mutationKey(document));
export const deleteTowerPgDocFromLocal = (store, document) => issue(store, 'document.delete', { document }, mutationKey(document, 'delete'));
export const moveTowerPgDocFromLocal = (store, document, destinationChannelId, destinationScopeId = null) => issue(store, 'document.move', { document, destinationChannelId, destinationScopeId }, mutationKey(document, destinationChannelId));
export const createTowerPgDocCommentFromLocal = (store, comment) => issue(store, 'document-comment.create', { comment }, comment?.record_id);
export const updateTowerPgDocCommentFromLocal = (store, comment) => issue(store, 'document-comment.update', { comment }, mutationKey(comment));
export const deleteTowerPgDocCommentFromLocal = (store, comment) => issue(store, 'document-comment.delete', { comment }, mutationKey(comment, 'delete'));
export const createTowerPgMessageFromLocal = (store, message, options) => issue(store, 'message.create', { message, options }, message?.record_id);
export const branchTowerPgThreadFromMessage = (store, message, { clientRequestId, recipientNpub = '', parentThreadId = '' } = {}) => issue(store, 'thread.branch',
  { message, clientRequestId, recipientNpub, parentThreadId },
  clientRequestId || message?.record_id,
);
export const updateTowerPgMessageFromLocal = (store, message, patch = {}) => issue(store, 'message.update', { message, patch }, mutationKey(message, patch?.body));
export const deleteTowerPgMessageFromLocal = (store, message) => issue(store, 'message.delete', { message }, mutationKey(message, 'delete'));
export const deleteTowerPgThreadFromLocal = (store, parentMessage) => issue(store, 'thread.delete', { parentMessage }, mutationKey(parentMessage, 'thread-delete'));
export const archiveTowerPgThreadFromLocal = (store, parentMessage, archived = true) => issue(store, 'thread.archive', { parentMessage, archived }, mutationKey(parentMessage, archived));
export const updateTowerPgThreadTitleFromLocal = (store, threadRow, title) => issue(store, 'thread.title.update', { threadRow, title }, mutationKey(threadRow, title));
export const createTowerPgFileFromLocal = (store, file) => issue(store, 'file.create', { file }, file?.record_id);
export const updateTowerPgFileFromLocal = (store, file, previous = null) => issue(store, 'file.update', { file, previous }, mutationKey(file));
export const createTowerPgFileFolderFromLocal = (store, folder) => issue(store, 'file-folder.create', { folder }, folder?.record_id);
export const createTowerPgAudioNoteFromLocal = (store, audioNote) => issue(store, 'audio-note.create', { audioNote }, audioNote?.record_id);

export const acceptTowerPgRemoteConflict = (store, key) => issue(store, 'record-conflict.accept-remote', { key }, key);

export const createFeedSubscription = (store, input) => issue(store, 'feed-subscription.create', input, input.body.mutation_id);
export const patchFeedSubscription = (store, input) => issue(store, 'feed-subscription.patch', input, input.body.mutation_id);
export const patchFeedItemState = (store, input) => issue(store, 'feed-state.patch', input, input.body.mutation_id);

export const createTowerPgContextComponent = (store, input, mutationId) => issue(store, 'context.create', input, mutationId);
export const updateTowerPgContextComponent = (store, input, mutationId) => issue(store, 'context.update', input, mutationId);
export const attachTowerPgContextReference = (store, input, mutationId) => issue(store, 'context.attach', input, mutationId);
export const unlinkTowerPgContextReference = (store, input, mutationId) => issue(store, 'context.unlink', input, mutationId);
export const deleteTowerPgContextSubtree = (store, input, mutationId) => issue(store, 'context.delete', input, mutationId);

export const putTowerPgScopeAccess = (store, ...args) => issueTypedApi(store, 'scope-access.put', args, args[1]);
