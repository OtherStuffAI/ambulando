import { readLiveChatDraft, rebindChatComposer } from './chat-composer-draft.js';
/**
 * Chat message management methods extracted from app.js.
 *
 * The chatMessageManagerMixin object contains methods and getters that use `this`
 * (the Alpine store) and should be spread into the store definition via applyMixins.
 */

import {
  getMessagesByChannel,
  getMessagePresentationWindowByChannels,
  getThreadMessagePresentationWindow,
  getThreadHistoryCoverage,
  getCurrentWorkspaceDbKey,
  withWorkspaceMessageTransaction,
  getMessageById,
  getWorkspaceDb,
  updateExistingMessageSyncStatus,
  upsertMessage,
  replaceMessageRecord,
  deleteMessageRuntimeState,
  upsertChannel,
  deleteChannelRuntimeState,
  clearAgentActivity,
} from './db.js';
import {
  fetchRecordHistory,
  getTowerPgThread,
  getTowerPgMessage,
} from './api.js';
import { deleteTowerPgChannel, queueTowerPendingWrite } from './tower-command-intents.js';
import {
  outboundChatMessage,
  outboundChannel,
  recordFamilyHash,
} from './translators/chat.js';
import {
  rankMainFeedMessages,
  resolveVisibleThreadReplyCount,
  sortMessagesByUpdatedAt,
} from './chat-order.js';
import {
  buildChatThreadFlowDispatchPreview,
  createChatThreadFlowDispatchState,
  getChatThreadFlowDispatchScopeSourceLabel,
  normalizeChatThreadFlowDispatchScopeAssignment,
  resolveChatThreadFlowDispatchScope,
  resolveChatThreadFlowDispatchThread,
} from './chat-thread-flow-dispatch.js';
import {
  CHAT_GET_IT_DONE_OUTPUT_TYPES,
  buildChatGetItDoneTaskDescription,
  createChatGetItDoneState,
} from './chat-get-it-done.js';
import { buildStoredFlowKickoffScopeAssignment } from './task-flow-helpers.js';
import { UNSCOPED_TASK_BOARD_ID } from './task-board-state.js';
import { defaultRecordSignature, sameListBySignature } from './utils/state-helpers.js';
import { getRecordWriteFieldsForStore } from './preferred-write-group.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import { DM_SCOPE_ID, buildDmChannelDescription, findExistingDmChannel } from './dm-scope.js';
import {
  createTowerPgMessageFromLocal,
  branchTowerPgThreadFromMessage,
  updateTowerPgMessageFromLocal,
  archiveTowerPgThreadFromLocal,
  deleteTowerPgMessageFromLocal,
  deleteTowerPgThreadFromLocal,
  updateTowerPgThreadTitleFromLocal,
} from './tower-command-intents.js';
import { mapPgMessageToLocal, mapPgThreadToLocal, resolveTowerPgWorkspaceContext, towerPgSyncCursorKey } from './pg-read-hydrator.js';
import { resolvePgThreadId } from './pg-record-context.js';
import { buildSectionUrl, parseRouteLocation } from './route-helpers.js';
import {
  buildFlightDeckReference,
  normalizeRecordLinkType,
} from './record-links.js';
import {
  hasPreviewId,
  prunePreviewState,
  schedulePreviewMeasurement,
  togglePreviewId,
} from './preview-truncation.js';
import {
  canonicalAgentMentionsFromSelection,
  filterMentionsToCurrentWorkspaceActors,
} from './agent-direct-chat.js';
import { getAgentActivityHealth, isTerminalAgentActivity, selectCurrentAgentActivities, selectVisibleAgentActivities } from './agent-activity.js';
import {
  buildHangCallInvitation,
  createHangRoomUrl,
  parseHangCallInvitation,
} from './hang-call.js';
import {
  mergeChatStorageAttachments,
  standaloneChatFileAttachments,
} from './chat-attachments.js';

const chatDerivedCache = new WeakMap();
const THREAD_REPLY_PREVIEW_WORD_LIMIT = 50;
const RESPONSE_ACTIVITY_WORDS = ['Thinking', 'Implementing', 'Writing'];
const RESPONSE_ACTIVITY_SUFFIXES = ['.', '.+', '.*', '..+', '..*', '...', '+', '*'];
const composerAutosizeFrames = new WeakMap();
const composerAutosizeMetrics = new WeakMap();
const MAX_INCREMENTAL_MESSAGE_UPDATES = 12;

function messagePresentationSignature(message) {
  return JSON.stringify([defaultRecordSignature(message), message?.parent_message_id,
    message?.pg_thread_id, message?.pg_effective_message_ids, message?.pg_client_record_id,
    message?.pg_reconciliation_pending]);
}

function incrementalMessagePatch(current = [], next = []) {
  if (!Array.isArray(current) || !Array.isArray(next) || current.length !== next.length) return null;
  const currentById = new Map(current.map((message) => [message?.record_id, message]));
  if (currentById.size !== current.length || next.some((message) => !currentById.has(message?.record_id))) return null;
  const updates = [];
  for (let index = 0; index < next.length; index += 1) {
    if (messagePresentationSignature(currentById.get(next[index]?.record_id)) === messagePresentationSignature(next[index])) continue;
    updates.push({ index, message: next[index] });
    if (updates.length > MAX_INCREMENTAL_MESSAGE_UPDATES) return null;
  }
  const orderedIds = current.map((message) => message.record_id);
  const moves = [];
  for (const { message } of updates) {
    const recordId = message.record_id;
    const from = orderedIds.indexOf(recordId);
    const to = next.findIndex((candidate) => candidate?.record_id === recordId);
    if (from < 0 || to < 0 || from === to) continue;
    orderedIds.splice(to, 0, orderedIds.splice(from, 1)[0]);
    moves.push({ from, to });
  }
  if (orderedIds.some((recordId, index) => recordId !== next[index]?.record_id)) return null;
  return { moves, updates };
}

function isVisibleResponseActivity(activity = {}, nowMs = Date.now()) {
  if (!activity?.record_id) return false;
  if (String(activity.status || '') === 'cleared' || String(activity.record_state || '') === 'cleared' || activity.cleared_at) return false;
  const expiresAt = Date.parse(activity.expires_at || '');
  return !Number.isFinite(expiresAt) || expiresAt > nowMs;
}

function sortResponseActivities(activities = []) {
  return [...activities].sort((left, right) => String(left.updated_at || '').localeCompare(String(right.updated_at || '')));
}

function pendingMessageMatchesDestination(message, destination = {}) {
  const messageChannelId = String(message?.channel_id || '').trim();
  const channelIds = new Set((Array.isArray(destination.channelIds) ? destination.channelIds : [])
    .map((channelId) => String(channelId || '').trim())
    .filter(Boolean));
  if (channelIds.size > 0 && !channelIds.has(messageChannelId)) return false;

  const workspaceId = String(destination.workspaceId || '').trim();
  const messageWorkspaceId = String(message?.pg_workspace_id || '').trim();
  if (workspaceId && messageWorkspaceId && messageWorkspaceId !== workspaceId) return false;

  const scopeId = String(destination.scopeId || '').trim();
  const messageScopeId = String(message?.pg_scope_id || '').trim();
  if (scopeId && messageScopeId && messageScopeId !== scopeId) return false;
  return channelIds.size > 0;
}

function mergePendingPgMessages(currentMessages = [], refreshedMessages = [], destination = {}) {
  const nextMessages = Array.isArray(refreshedMessages) ? refreshedMessages : [];
  const refreshedRecordIds = new Set(nextMessages.map((message) => message?.record_id).filter(Boolean));
  const authoritativeClientIds = new Set(nextMessages
    .map((message) => String(message?.pg_client_record_id || '').trim())
    .filter(Boolean));
  const retained = (Array.isArray(currentMessages) ? currentMessages : []).filter((message) => {
    if (message?.sync_status !== 'pending' && message?.pg_reconciliation_pending !== true) return false;
    if (!pendingMessageMatchesDestination(message, destination)) return false;
    if (refreshedRecordIds.has(message?.record_id)) return false;
    const clientRecordId = String(message?.pg_client_record_id || message?.record_id || '').trim();
    return !authoritativeClientIds.has(clientRecordId);
  });
  return [...nextMessages, ...retained];
}

function audioNoteSignature(audioNotes = []) {
  return (Array.isArray(audioNotes) ? audioNotes : [])
    .map((note) => [
      String(note?.record_id || ''),
      String(note?.target_record_id || ''),
      String(note?.target_record_family_hash || ''),
      String(note?.record_state || ''),
      String(note?.updated_at || ''),
      String(note?.version ?? ''),
    ].join(':'))
    .join('|');
}

function buildMessageAudioAttachmentsByTarget(audioNotes = []) {
  const byTarget = new Map();
  const chatMessageFamilyHash = recordFamilyHash('chat_message');
  for (const note of Array.isArray(audioNotes) ? audioNotes : []) {
    const recordId = String(note?.record_id || '').trim();
    const targetRecordId = String(note?.target_record_id || '').trim();
    const targetFamilyHash = String(note?.target_record_family_hash || '').trim();
    if (!recordId || !targetRecordId || targetFamilyHash !== chatMessageFamilyHash) continue;
    if (String(note?.record_state || 'active') === 'deleted') continue;
    const list = byTarget.get(targetRecordId) || [];
    list.push({
      kind: 'audio',
      audio_note_record_id: recordId,
      title: note?.title || 'Voice note',
      duration_seconds: Number.isFinite(Number(note?.duration_seconds)) ? Number(note.duration_seconds) : null,
    });
    byTarget.set(targetRecordId, list);
  }
  return byTarget;
}

function attachTargetAudioNotesToMessages(messages = [], audioNotes = []) {
  const byTarget = buildMessageAudioAttachmentsByTarget(audioNotes);
  if (byTarget.size === 0) return messages;
  return messages.map((message) => {
    const targetAttachments = byTarget.get(message?.record_id);
    if (!targetAttachments?.length) return message;
    const existingAttachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const existingAudioIds = new Set(
      existingAttachments
        .filter((attachment) => attachment?.kind === 'audio')
        .map((attachment) => String(attachment?.audio_note_record_id || '').trim())
        .filter(Boolean),
    );
    const missingAttachments = targetAttachments.filter((attachment) => !existingAudioIds.has(attachment.audio_note_record_id));
    if (missingAttachments.length === 0) return message;
    return {
      ...message,
      attachments: [...existingAttachments, ...missingAttachments],
    };
  });
}

function scheduleUiNextTick(callback) {
  const nextTick = globalThis.Alpine?.nextTick;
  if (typeof nextTick === 'function') {
    nextTick(callback);
    return;
  }
  queueMicrotask(callback);
}

function channelDescriptor(channel = {}) {
  return [
    channel.title,
    channel.name,
    channel.description,
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' ');
}

function resolveAgentDmTargetNpub(channel, botNpub, memberNpub) {
  const explicit = String(botNpub || '').trim();
  if (explicit) return explicit;
  const senderNpub = String(memberNpub || '').trim();
  const descriptor = channelDescriptor(channel);
  const candidates = descriptor.match(/\bnpub1[023456789acdefghjklmnpqrstuvwxyz]+\b/gi) || [];
  return candidates.find((npub) => npub !== senderNpub) || '';
}

function isAgentDmChannel(channel, targetNpub, memberNpub) {
  const target = String(targetNpub || '').trim();
  const senderNpub = String(memberNpub || '').trim();
  if (!channel || !target || !senderNpub) return false;
  const channelType = String(channel.channel_type || channel.kind || '').trim();
  const participants = Array.isArray(channel.participant_npubs)
    ? channel.participant_npubs.map((npub) => String(npub || '').trim())
    : [];
  if (participants.includes(target) && participants.includes(senderNpub)) return true;
  const descriptor = channelDescriptor(channel);
  return descriptor.includes(target) && (channelType === 'dm' || /^DM:/i.test(descriptor));
}

async function ensureTowerPgAgentDmAccess(store, channel) {
  const targetNpub = resolveAgentDmTargetNpub(channel, store.botNpub, store.session?.npub);
  if (!isAgentDmChannel(channel, targetNpub, store.session?.npub)) return true;
  if (typeof store.ensureTowerPgDmChannel !== 'function') {
    store.error = 'Agent DMs are not available in this workspace view.';
    return false;
  }
  try {
    await store.ensureTowerPgDmChannel(targetNpub);
    return true;
  } catch (error) {
    store.error = error?.message || 'Failed to prepare agent DM';
    return false;
  }
}

function isRepairableTowerPgDmAuthorizationFailure(error) {
  return Number(error?.status) === 403
    && error?.code === 'permission_denied'
    && (!error?.requiredPermission || error.requiredPermission === 'channel.write');
}

async function createTowerPgMessageWithLazyDmRepair(store, localRow, channel, options = {}) {
  const createMessage = () => Object.keys(options).length > 0
    ? createTowerPgMessageFromLocal(store, localRow, options)
    : createTowerPgMessageFromLocal(store, localRow);
  try {
    return await createMessage();
  } catch (error) {
    const targetNpub = resolveAgentDmTargetNpub(channel, store.botNpub, store.session?.npub);
    if (
      !isAgentDmChannel(channel, targetNpub, store.session?.npub)
      || !isRepairableTowerPgDmAuthorizationFailure(error)
    ) {
      throw error;
    }
    if (!(await ensureTowerPgAgentDmAccess(store, channel))) {
      throw new Error(store.error || 'Failed to repair agent DM access', { cause: error });
    }
    store.error = null;
    return createMessage();
  }
}

function setComposerSendPending(store, composer, pending) {
  store.composerSendPending = {
    ...(store.composerSendPending || {}),
    [composer]: pending,
  };
}

function getChatDerivedState(store) {
  const sourceMessages = Array.isArray(store?.messages) ? store.messages : [];
  const messageCollectionRevision = Number(store?.messageCollectionRevision || 0);
  const audioNotes = Array.isArray(store?.audioNotes) ? store.audioNotes : [];
  const currentAudioNoteSignature = audioNoteSignature(audioNotes);
  const activeThreadId = store?.activeThreadId ?? null;
  const focusMessageId = store?.focusMessageId ?? null;
  const showArchivedChatThreads = store?.showArchivedChatThreads === true;
  const mainFeedVisibleCount = Math.max(
    0,
    Number(store?.mainFeedVisibleCount ?? store?.MAIN_FEED_PAGE_SIZE ?? 0) || 0,
  );
  const threadVisibleReplyCount = Math.max(0, Number(store?.threadVisibleReplyCount) || 0);

  const previous = chatDerivedCache.get(store);
  if (
    previous
    && previous.messages === sourceMessages
    && previous.messageCollectionRevision === messageCollectionRevision
    && previous.audioNoteSignature === currentAudioNoteSignature
    && previous.activeThreadId === activeThreadId
    && previous.focusMessageId === focusMessageId
    && previous.showArchivedChatThreads === showArchivedChatThreads
    && previous.mainFeedVisibleCount === mainFeedVisibleCount
    && previous.threadVisibleReplyCount === threadVisibleReplyCount
  ) {
    return previous.value;
  }

  const messages = attachTargetAudioNotesToMessages(
    sourceMessages.filter((message) => String(message?.record_state || 'active') !== 'deleted'),
    audioNotes,
  );
  const mainFeedMessagesAll = rankMainFeedMessages(messages);
  const archivedMainFeedMessages = mainFeedMessagesAll
    .filter((message) => String(message?.record_state || 'active') === 'archived');
  const mainFeedMessages = showArchivedChatThreads
    ? mainFeedMessagesAll
    : mainFeedMessagesAll.filter((message) => String(message?.record_state || 'active') !== 'archived');
  const resolvedMainFeedVisibleCount = resolveVisibleThreadReplyCount(
    mainFeedMessages,
    mainFeedVisibleCount,
    focusMessageId,
  );
  const visibleMainFeedMessages = mainFeedMessages.slice(-resolvedMainFeedVisibleCount);
  const hiddenMainFeedCount = Math.max(0, mainFeedMessages.length - resolvedMainFeedVisibleCount);

  const threadRepliesByParentId = new Map();
  for (const message of messages) {
    const parentMessageId = String(message?.parent_message_id || '').trim();
    if (!parentMessageId || message.pg_record_type === 'thread') continue;
    const replies = threadRepliesByParentId.get(parentMessageId) || [];
    replies.push(message);
    threadRepliesByParentId.set(parentMessageId, replies);
  }
  for (const [parentMessageId, replies] of threadRepliesByParentId) {
    threadRepliesByParentId.set(parentMessageId, sortMessagesByUpdatedAt(replies));
  }

  const activeThreadRecord = activeThreadId
    ? messages.find((message) => message?.record_id === activeThreadId) || null
    : null;
  const effectiveMessageIds = Array.isArray(activeThreadRecord?.pg_effective_message_ids)
    ? [...new Set(activeThreadRecord.pg_effective_message_ids.map(String))]
    : [];
  const messageById = new Map(messages.map((message) => [String(message?.record_id || ''), message]));
  let threadMessages;
  if (effectiveMessageIds.length > 0) {
    const effectiveIdSet = new Set(effectiveMessageIds);
    const effectiveMessages = effectiveMessageIds
      .map((messageId) => messageById.get(messageId))
      .filter(message => message && message.pg_record_type !== 'thread' && message.record_id !== activeThreadId);
    const newlyOwnedMessages = (threadRepliesByParentId.get(activeThreadId) || [])
      .filter((message) => !effectiveIdSet.has(String(message?.record_id || '')));
    threadMessages = newlyOwnedMessages.length > 0
      ? sortMessagesByUpdatedAt([...effectiveMessages, ...newlyOwnedMessages])
      : effectiveMessages;
  } else {
    threadMessages = activeThreadId ? (threadRepliesByParentId.get(activeThreadId) || []) : [];
  }
  const resolvedThreadVisibleReplyCount = resolveVisibleThreadReplyCount(
    threadMessages,
    threadVisibleReplyCount,
    focusMessageId,
  );
  const visibleThreadMessages = threadMessages.slice(-resolvedThreadVisibleReplyCount);
  const hiddenThreadReplyCount = Math.max(0, threadMessages.length - resolvedThreadVisibleReplyCount);

  const value = {
    mainFeedMessages,
    archivedMainFeedMessages,
    resolvedMainFeedVisibleCount,
    visibleMainFeedMessages,
    hiddenMainFeedCount,
    threadRepliesByParentId,
    threadMessages,
    resolvedThreadVisibleReplyCount,
    visibleThreadMessages,
    hiddenThreadReplyCount,
  };

  chatDerivedCache.set(store, {
    messages: sourceMessages,
    messageCollectionRevision,
    audioNoteSignature: currentAudioNoteSignature,
    activeThreadId,
    focusMessageId,
    showArchivedChatThreads,
    mainFeedVisibleCount,
    threadVisibleReplyCount,
    value,
  });

  return value;
}

function normalizePreviewText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, '$1')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateWords(value, limit = THREAD_REPLY_PREVIEW_WORD_LIMIT) {
  const words = normalizePreviewText(value).split(' ').filter(Boolean);
  if (words.length <= limit) return words.join(' ');
  return `${words.slice(0, limit).join(' ')}...`;
}

// ---------------------------------------------------------------------------
// Mixin — methods and getters that use `this` (the Alpine store)
// ---------------------------------------------------------------------------

export const chatMessageManagerMixin = {

  composerSendPending: { message: false, thread: false },
  messageResendPendingIds: [],
  offlineMessageResyncInFlight: false,
  branchSubmittingMessageId: null,
  branchRequestIdsByMessage: {},
  branchThreadError: '',

  // --- computed getters ---

  get selectedChannel() {
    return this.channels.find(c => c.record_id === this.selectedChannelId) ?? null;
  },

  get activeThreadChannelId() {
    if (this.navSection === 'status' && this.deckThreadChannelId && this.activeThreadId) {
      return this.deckThreadChannelId;
    }
    return this.selectedChannelId || null;
  },

  get activeThreadChannel() {
    return this.channels.find((channel) => channel.record_id === this.activeThreadChannelId)
      ?? (this.deckThreadChannelRecord?.record_id === this.activeThreadChannelId ? this.deckThreadChannelRecord : null);
  },

  get canComposeInThreadDestination() {
    if (this.deckThreadComposerOpen) return Boolean(this.selectedChannelId && this.selectedChannel);
    return Boolean(this.activeThreadId && this.activeThreadChannelId && this.activeThreadChannel);
  },

  get threadComposerDisabledReason() {
    if (this.canComposeInThreadDestination) return '';
    if (this.deckThreadChannelState === 'error') {
      return this.deckThreadChannelError || 'The thread channel could not be loaded.';
    }
    return 'Thread channel is still loading. Attachments and replies will be available when it is ready.';
  },

  get canComposeInChatDestination() {
    if (!this.selectedChannelId || !this.selectedChannel) return false;
    if (!(this.currentWorkspace?.pgBackendMode || this.pgBackendMode)) return true;
    return this.pgContextSelectedChannelId === this.selectedChannelId;
  },

  get chatComposerDisabledReason() {
    return this.canComposeInChatDestination
      ? ''
      : 'Scope Home is a read-only rollup. Select a channel to write a message.';
  },

  getChatComposerDraftKey(context = 'message', destination = {}) {
    const channelId = String(destination.channelId ?? (context === 'thread' ? this.activeThreadChannelId : this.selectedChannelId) ?? this.selectedChannelId ?? '').trim();
    if (!channelId) return '';
    const channel = (this.channels || []).find((item) => item?.record_id === channelId) || null;
    const workspaceId = String(
      destination.workspaceId
      ?? this.currentWorkspace?.workspaceId
      ?? this.currentWorkspace?.workspace_id
      ?? this.currentWorkspaceKey
      ?? this.workspaceOwnerNpub
      ?? '',
    ).trim();
    const scopeId = String(destination.scopeId ?? channel?.scope_id ?? channel?.scope_l1_id ?? '').trim();
    const threadId = context === 'thread'
      ? String(destination.threadId ?? this.activeThreadId ?? '').trim() || (this.deckThreadComposerOpen ? '__new_thread__' : '')
      : '';
    if (context === 'thread' && !threadId) return '';
    return [workspaceId, scopeId, channelId, threadId || '__channel__'].join(':');
  },

  saveChatComposerDraft(context = 'message', destination = {}) {
    const key = this.getChatComposerDraftKey(context, destination);
    if (!key) return;
    const inputKey = context === 'thread' ? 'threadInput' : 'messageInput';
    const live = readLiveChatDraft(this, context, key);
    const mentions = live?.actorMentions ?? this.selectedAgentMentionsByComposer?.[context] ?? [];
    const value = live?.value ?? String(this[inputKey] || '');
    const drafts = { ...(this.chatComposerDrafts || {}) };
    if (!value && mentions.length === 0) delete drafts[key];
    else drafts[key] = { value, mentions: [...mentions] };
    this.chatComposerDrafts = drafts;
  },

  restoreChatComposerDraft(context = 'message', destination = {}) {
    const key = this.getChatComposerDraftKey(context, destination);
    const draft = key ? this.chatComposerDrafts?.[key] : null;
    const inputKey = context === 'thread' ? 'threadInput' : 'messageInput';
    const composer = rebindChatComposer(this, context);
    this[inputKey] = String(draft?.value || '');
    if (composer) this.syncMentionComposerFromModel?.(composer, context, this[inputKey]);
    this.selectedAgentMentionsByComposer = {
      ...(this.selectedAgentMentionsByComposer || {}),
      [context]: Array.isArray(draft?.mentions) ? [...draft.mentions] : [],
    };
    this.scheduleComposerAutosize?.(context);
  },

  clearCurrentChatComposerDraft(context = 'message') {
    const key = this.getChatComposerDraftKey(context);
    if (!key || !this.chatComposerDrafts?.[key]) return;
    const drafts = { ...this.chatComposerDrafts };
    delete drafts[key];
    this.chatComposerDrafts = drafts;
  },

  get mainFeedMessages() {
    return getChatDerivedState(this).mainFeedMessages;
  },

  get resolvedMainFeedVisibleCount() {
    return getChatDerivedState(this).resolvedMainFeedVisibleCount;
  },

  get visibleMainFeedMessages() {
    return getChatDerivedState(this).visibleMainFeedMessages;
  },

  get hiddenMainFeedCount() {
    return getChatDerivedState(this).hiddenMainFeedCount;
  },

  get archivedMainFeedMessages() {
    return getChatDerivedState(this).archivedMainFeedMessages;
  },

  get archivedMainFeedCount() {
    return this.archivedMainFeedMessages.length;
  },

  get hasArchivedChatThreads() {
    return this.archivedMainFeedCount > 0;
  },

  get hasMoreMainFeedMessages() {
    return this.hiddenMainFeedCount > 0;
  },

  get showMainFeedLoadMoreControl() {
    return this.hasMoreMainFeedMessages || this.hasArchivedChatThreads;
  },

  get threadMessages() {
    return getChatDerivedState(this).threadMessages;
  },
  get activeThreadResponseActivities() {
    const now = Date.now();
    return (Array.isArray(this.threadResponseActivities) ? this.threadResponseActivities : [])
      .filter((activity) => isVisibleResponseActivity(activity, now))
      .sort((left, right) => String(left.updated_at || '').localeCompare(String(right.updated_at || '')));
  },
  get activeThreadAgentActivities() {
    const thread = this.getThreadParentMessage?.();
    const threadIds = new Set([
      this.activeThreadId,
      thread?.record_id,
      thread?.pg_thread_id,
      thread?.thread_id,
    ].map((value) => String(value || '').trim()).filter(Boolean));
    const channelId = thread?.channel_id || this.activeChannelId;
    return this.getVisibleAgentActivities().filter((activity) => (!channelId || activity.channel_id === channelId)
      && threadIds.has(String(activity.thread_id || '').trim()));
  },

  get resolvedThreadVisibleReplyCount() {
    return getChatDerivedState(this).resolvedThreadVisibleReplyCount;
  },

  get visibleThreadMessages() {
    return getChatDerivedState(this).visibleThreadMessages;
  },

  get hiddenThreadReplyCount() {
    return getChatDerivedState(this).hiddenThreadReplyCount;
  },

  get hasMoreThreadMessages() {
    return this.hiddenThreadReplyCount > 0;
  },

  get chatThreadFlowDispatchSelectedFlow() {
    return this.flows.find((flow) => flow.record_id === this.chatThreadFlowDispatchSelectedFlowId) ?? null;
  },

  get chatThreadFlowDispatchSourceChannel() {
    const channelId = this.chatThreadFlowDispatchSource?.channelId || null;
    return this.channels.find((channel) => channel.record_id === channelId) ?? null;
  },

  get chatThreadFlowDispatchResolvedScopeLabel() {
    if (!this.chatThreadFlowDispatchResolvedScopeId) return 'No scope';
    return this.getTaskBoardOptionLabel(this.chatThreadFlowDispatchResolvedScopeId) || this.chatThreadFlowDispatchResolvedScopeId;
  },

  get chatThreadFlowDispatchScopeSourceLabel() {
    return getChatThreadFlowDispatchScopeSourceLabel(this.chatThreadFlowDispatchScopeSource);
  },

  get chatThreadFlowDispatchCanSubmit() {
    if (this.chatThreadFlowDispatchLoading || this.chatThreadFlowDispatchSubmitting) return false;
    if (!this.chatThreadFlowDispatchSelectedFlowId) return false;
    if (!this.chatThreadFlowDispatchSource?.channelId) return false;
    if (this.chatThreadFlowDispatchMessages.length === 0) return false;
    return String(this.chatThreadFlowDispatchPreview || '').trim().length > 0;
  },

  get chatGetItDoneSourceChannel() {
    const channelId = this.chatGetItDoneSource?.channelId || null;
    return this.channels.find((channel) => channel.record_id === channelId) ?? null;
  },

  get chatGetItDoneOutputTypes() {
    return CHAT_GET_IT_DONE_OUTPUT_TYPES;
  },

  get chatGetItDoneAssigneeOptions() {
    const seen = new Set();
    const add = (options, npub, role) => {
      const clean = String(npub || '').trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      options.push({
        npub: clean,
        label: this.getSenderName?.(clean) || clean,
        role,
      });
    };
    const options = [];
    add(options, this.chatGetItDoneAssigneeNpub, 'Default');
    add(options, this.defaultAgentNpub, 'Default agent');
    add(options, this.botNpub, 'Agent');
    const channel = this.chatGetItDoneSourceChannel || this.selectedChannel;
    for (const npub of (Array.isArray(channel?.participant_npubs) ? channel.participant_npubs : [])) {
      add(options, npub, 'Participant');
    }
    for (const group of (this.currentWorkspaceGroups || [])) {
      for (const npub of (Array.isArray(group?.member_npubs) ? group.member_npubs : [])) {
        add(options, npub, 'Workspace');
      }
    }
    return options;
  },

  get chatGetItDoneAssigneeLabel() {
    const npub = String(this.chatGetItDoneAssigneeNpub || '').trim();
    if (!npub) return 'Unassigned';
    return this.getSenderName?.(npub) || npub;
  },

  get chatGetItDoneAssigneeSuggestions() {
    const selected = String(this.chatGetItDoneAssigneeNpub || '').trim();
    const query = String(this.chatGetItDoneAssigneeQuery || '').trim();
    const selectedSet = new Set(selected ? [selected] : []);
    const seen = new Set();
    const options = this.chatGetItDoneAssigneeOptions
      .filter((option) => !selectedSet.has(option.npub))
      .map((option) => ({
        npub: option.npub,
        label: option.label,
        subtitle: option.role || option.npub,
        avatarUrl: this.getSenderAvatar?.(option.npub) || null,
      }));
    const addUnique = (items, item) => {
      const npub = String(item?.npub || '').trim();
      if (!npub || selectedSet.has(npub) || seen.has(npub)) return;
      seen.add(npub);
      items.push({ ...item, npub });
    };

    if (!query) {
      const defaults = [];
      for (const option of options) addUnique(defaults, option);
      return defaults.slice(0, 8);
    }

    const needle = query.toLowerCase();
    const matches = [];
    for (const person of (typeof this.findPeopleSuggestions === 'function'
      ? this.findPeopleSuggestions(query, selected ? [selected] : [])
      : [])) {
      addUnique(matches, person);
    }
    for (const option of options) {
      if (
        String(option.npub || '').toLowerCase().includes(needle)
        || String(option.label || '').toLowerCase().includes(needle)
        || String(option.subtitle || '').toLowerCase().includes(needle)
      ) {
        addUnique(matches, option);
      }
    }
    return matches.slice(0, 8);
  },

  get chatGetItDoneScopeSelection() {
    const scopeId = String(this.chatGetItDoneScopeId || '').trim();
    return scopeId ? this.scopesMap?.get(scopeId) || null : null;
  },

  get chatGetItDoneScopeLabel() {
    const scopeId = String(this.chatGetItDoneScopeId || '').trim();
    if (!scopeId) return 'Current workspace';
    return this.getTaskBoardOptionLabel?.(scopeId)
      || this.getScopeBreadcrumb?.(scopeId)
      || this.chatGetItDoneScopeSelection?.title
      || scopeId;
  },

  get chatGetItDoneScopeSuggestions() {
    const query = String(this.chatGetItDoneScopeQuery || '').trim();
    const selected = String(this.chatGetItDoneScopeId || '').trim();
    const items = typeof this.scopePickerFlatFor === 'function'
      ? this.scopePickerFlatFor(query)
      : [];
    return items
      .filter((item) => item?.record_id !== selected)
      .slice(0, 20);
  },

  get chatGetItDoneCanSubmit() {
    if (this.chatGetItDoneSubmitting) return false;
    if (!this.chatGetItDoneSource?.channelId) return false;
    if (this.chatGetItDoneMessages.length === 0) return false;
    return String(this.chatGetItDoneTitle || '').trim().length > 0;
  },

  // --- scroll anchoring ---

  scheduleLatestItemScroll({
    containerSelector,
    contentSelector,
    frameKey,
    pendingFlag,
    afterScroll,
    retries = 3,
    previousContainer = null,
    previousScrollTop = null,
  }) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    scheduleUiNextTick(() => {
      if (this[frameKey]) window.cancelAnimationFrame(this[frameKey]);
      this[frameKey] = window.requestAnimationFrame(() => {
        this[frameKey] = null;
        const container = document.querySelector(containerSelector);
        const hasRenderedContent = Boolean(container?.querySelector?.(contentSelector));
        if (!container || !hasRenderedContent) {
          if (retries > 0) {
            this.scheduleLatestItemScroll({
              containerSelector,
              contentSelector,
              frameKey,
              pendingFlag,
              afterScroll,
              retries: retries - 1,
            });
          }
          return;
        }
        const sameContainer = previousContainer === container;
        const userMovedAway = sameContainer
          && previousScrollTop != null
          && container.scrollTop < previousScrollTop - 8;
        if (userMovedAway) return;
        container.scrollTop = container.scrollHeight;
        const appliedScrollTop = container.scrollTop;
        if (pendingFlag) this[pendingFlag] = false;
        if (afterScroll && typeof this[afterScroll] === 'function') this[afterScroll](container);
        if (retries > 0) {
          this.scheduleLatestItemScroll({
            containerSelector,
            contentSelector,
            frameKey,
            pendingFlag,
            afterScroll,
            retries: retries - 1,
            previousContainer: container,
            previousScrollTop: appliedScrollTop,
          });
        }
      });
    });
  },

  scheduleChatFeedScrollToBottom(retries = 3) {
    this.scheduleLatestItemScroll({
      containerSelector: '[data-chat-feed]',
      contentSelector: '[data-message-id]',
      frameKey: 'chatFeedScrollFrame',
      pendingFlag: 'pendingChatScrollToLatest',
      afterScroll: 'updateChatFeedLoadMoreVisibility',
      retries,
    });
  },

  scheduleThreadRepliesScrollToBottom(retries = 3) {
    this.scheduleLatestItemScroll({
      containerSelector: '[data-thread-replies]',
      contentSelector: '[data-thread-message-id]',
      frameKey: 'threadRepliesScrollFrame',
      pendingFlag: 'pendingThreadScrollToLatest',
      retries,
    });
  },

  isThreadRepliesNearBottom(tolerance = 96) {
    if (typeof document === 'undefined') return false;
    const replies = document.querySelector('[data-thread-replies]');
    if (!replies) return false;
    return replies.scrollHeight - replies.scrollTop - replies.clientHeight <= tolerance;
  },

  armThreadActivityAutoScroll(message) {
    const triggerMessageId = String(message?.record_id || '').trim();
    const threadId = String(message?.pg_thread_id || message?.thread_id || this.activeThreadId || '').trim();
    if (!triggerMessageId || !threadId) return;
    this.pendingThreadActivityAutoScroll = { triggerMessageId, threadId };
  },

  revealPendingThreadAgentActivity(activities = []) {
    const pending = this.pendingThreadActivityAutoScroll;
    if (!pending) return;
    const matchingActivity = activities.find((activity) => (
      String(activity?.trigger_message_id || '').trim() === pending.triggerMessageId
      && String(activity?.thread_id || '').trim() === pending.threadId
    ));
    if (!matchingActivity) return;

    this.pendingThreadActivityAutoScroll = null;
    const thread = this.getThreadParentMessage?.();
    const activeThreadIds = new Set([
      this.activeThreadId,
      thread?.record_id,
      thread?.pg_thread_id,
      thread?.thread_id,
    ].map((value) => String(value || '').trim()).filter(Boolean));
    if (!activeThreadIds.has(pending.threadId) || !this.isThreadRepliesNearBottom()) return;
    this.scheduleThreadRepliesScrollToBottom();
  },

  // --- composer autosize ---

  autosizeComposer(textarea, options = {}) {
    if (!textarea || typeof window === 'undefined') return;
    // Descriptions are document surfaces. Their pane scrolls, so applying the
    // chat composer line cap here creates a nested scrolling edit window.
    if (textarea.dataset?.chatComposer === 'task-description') {
      textarea.style.height = 'auto';
      textarea.style.overflowY = 'visible';
      return;
    }
    if (options.resetManualSize === true) {
      textarea.style.height = 'auto';
      textarea.style.overflowY = 'hidden';
    }
    const viewportWidth = Number(window.innerWidth) || 0;
    let metrics = composerAutosizeMetrics.get(textarea);
    if (!metrics || metrics.viewportWidth !== viewportWidth || options.refreshMetrics === true) {
      const styles = window.getComputedStyle(textarea);
      const lineHeight = parseFloat(styles.lineHeight) || 20;
      const paddingY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
      const borderY = (parseFloat(styles.borderTopWidth) || 0) + (parseFloat(styles.borderBottomWidth) || 0);
      metrics = {
        viewportWidth,
        minHeight: parseFloat(styles.minHeight) || (lineHeight + paddingY + borderY),
        maxHeight: (lineHeight * this.COMPOSER_MAX_LINES) + paddingY + borderY,
        renderedHeight: parseFloat(styles.height) || 0,
      };
      composerAutosizeMetrics.set(textarea, metrics);
    }
    const { minHeight, maxHeight } = metrics;

    const composer = String(textarea.dataset?.chatComposer || '').trim();
    const preservesManualSize = ['message', 'thread', 'task-comment', 'doc-comment', 'doc-reply'].includes(composer)
      && options.resetManualSize !== true;
    if (preservesManualSize) {
      const scrollTop = textarea.scrollTop;
      const renderedHeight = textarea.getBoundingClientRect?.().height
        || metrics.renderedHeight
        || parseFloat(textarea.style.height)
        || 0;
      const scrollHeight = textarea.scrollHeight;
      const nextHeight = Math.max(
        Math.min(Math.max(scrollHeight, minHeight), maxHeight),
        renderedHeight,
      );
      const height = `${Math.max(nextHeight, 0)}px`;
      const overflowY = scrollHeight > nextHeight ? 'auto' : 'hidden';
      if (textarea.style.height !== height) textarea.style.height = height;
      if (textarea.style.overflowY !== overflowY) textarea.style.overflowY = overflowY;
      textarea.scrollTop = scrollTop;
      return;
    }

    if (options.canShrink !== false) textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    const nextHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
    const height = `${Math.max(nextHeight, 0)}px`;
    const overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
    if (textarea.style.height !== height) textarea.style.height = height;
    if (textarea.style.overflowY !== overflowY) textarea.style.overflowY = overflowY;
  },

  scheduleComposerElementAutosize(element, options = {}) {
    if (!element || typeof window === 'undefined') return;
    const previous = composerAutosizeFrames.get(element);
    if (previous?.frame != null) window.cancelAnimationFrame(previous.frame);
    const autosizeOptions = {
      ...options,
      canShrink: options.canShrink === true || previous?.options?.canShrink === true,
    };
    const frame = window.requestAnimationFrame(() => {
      composerAutosizeFrames.delete(element);
      this.autosizeComposer(element, autosizeOptions);
    });
    composerAutosizeFrames.set(element, { frame, options: autosizeOptions });
  },

  scheduleComposerAutosize(context, options = {}) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    scheduleUiNextTick(() => {
      const textarea = document.querySelector(`[data-chat-composer="${context}"]`);
      if (!textarea) return;
      this.scheduleComposerElementAutosize(textarea, options);
    });
  },

  updateChatFeedLoadMoreVisibility(feed) {
    const nextFeed = feed && typeof feed.scrollTop === 'number'
      ? feed
      : (typeof document !== 'undefined' ? document.querySelector('[data-chat-feed]') : null);
    if (!nextFeed) return;
    this.chatFeedNearTop = nextFeed.scrollTop <= 96;
  },

  // --- messages ---

  async applyMessages(messages = [], options = {}) {
    // Keep the reader's current window intact while history pages commit.
    // The explicit completion refresh publishes the expanded transcript once.
    if (this.threadHistoryLoadAll && options.threadDetail && !options.historyComplete) return;
    const startingRevision = Number(this.messageCollectionRevision || 0);
    if (options.isCurrent && !options.isCurrent()) return;
    const selectionGeneration = options.selectionGeneration;
    if (selectionGeneration != null && this.channelSelectionGeneration !== selectionGeneration) return;
    const selectedChannelId = String(this.selectedChannelId || '').trim();
    const scopeChannels = Array.isArray(this.pgContextChannels) ? this.pgContextChannels : [];
    const presentationChannelId = this.navSection === 'status' && this.activeThreadId && this.deckThreadChannelId
      ? this.deckThreadChannelId : selectedChannelId;
    const channelIds = presentationChannelId
      ? [presentationChannelId]
      : scopeChannels.map((channel) => channel?.record_id).filter(Boolean);
    const selectedChannel = presentationChannelId
      ? (this.channels || []).find((channel) => channel?.record_id === presentationChannelId)
      : null;
    let nextMessages = sortMessagesByUpdatedAt(mergePendingPgMessages(this.messages, messages, {
      channelIds,
      workspaceId: this.currentWorkspace?.workspaceId
        || this.currentWorkspace?.workspace_id
        || this.currentWorkspaceKey,
      scopeId: selectedChannel?.scope_id
        || selectedChannel?.scope_l1_id
        || this.pgContextScopeId
        || this.pgContextScope?.record_id,
    }));
    this.reconcileOpenThreadIdentity(nextMessages);
    const activeThreadId = String(this.activeThreadId || '').trim();
    const activeDeckThread = this.navSection === 'status'
      && Boolean(activeThreadId)
      && Boolean(String(this.deckThreadChannelId || '').trim());
    const activeThreadMissingFromWindow = activeThreadId
      && !nextMessages.some((message) => message.record_id === activeThreadId || message.parent_message_id === activeThreadId);
    if (activeThreadMissingFromWindow && options.threadDetail !== true) {
      const persistedThread = await getMessageById(activeThreadId).catch(() => null);
      if (Number(this.messageCollectionRevision || 0) !== startingRevision) return;
      if (selectionGeneration != null && this.channelSelectionGeneration !== selectionGeneration) return;
      if (String(this.selectedChannelId || '').trim() !== selectedChannelId) return;
      if (
        String(this.activeThreadId || '').trim() === activeThreadId
        && persistedThread
        && !['deleted', 'archived'].includes(String(persistedThread.record_state || 'active'))
      ) {
        const retainedIds = new Set(nextMessages.map((message) => message?.record_id).filter(Boolean));
        const retainedThreadMessages = [persistedThread, ...(this.messages || [])]
          .filter((message) => {
            const belongsToActiveThread = message?.record_id === activeThreadId
              || message?.parent_message_id === activeThreadId;
            if (!belongsToActiveThread || !message?.record_id || retainedIds.has(message.record_id)) return false;
            retainedIds.add(message.record_id);
            return true;
          });
        nextMessages = sortMessagesByUpdatedAt([...nextMessages, ...retainedThreadMessages]);
      } else if (
        !activeDeckThread
        && String(this.activeThreadId || '').trim() === activeThreadId
      ) {
        this.closeThread({ syncRoute: false });
      }
    }
    if (options.isCurrent && !options.isCurrent()) return;
    const messagesChanged = !sameListBySignature(this.messages, nextMessages, messagePresentationSignature);
    const scrollRequested = options.scrollToLatest === true
      || options.scrollThreadToLatest === true
      || this.pendingChatScrollToLatest
      || this.pendingThreadScrollToLatest;
    if (!messagesChanged && !scrollRequested) return;
    const chatFeedAnchor = messagesChanged
      ? this.captureScrollAnchor({
        containerSelector: '[data-chat-feed]',
        itemSelector: '[data-message-id]',
        itemAttribute: 'data-message-id',
      })
      : null;
    const threadRepliesAnchor = messagesChanged
      ? this.captureScrollAnchor({
        containerSelector: '[data-thread-replies]',
        itemSelector: this.threadHistoryLoadAll ? '[data-thread-reply]' : '[data-thread-message-id]',
        itemAttribute: 'data-thread-message-id',
      })
      : null;

    // Explicit history expansion preserves the visible message even when the
    // reader started at the bottom; new pages may append newer messages.
    if (threadRepliesAnchor && this.threadHistoryLoadAll) threadRepliesAnchor.atBottom = false;

    if (messagesChanged) {
      const incrementalPatch = incrementalMessagePatch(this.messages, nextMessages);
      if (incrementalPatch) {
        for (const { from, to } of incrementalPatch.moves) {
          const [message] = this.messages.splice(from, 1);
          this.messages.splice(to, 0, message);
        }
        for (const { index, message } of incrementalPatch.updates) this.messages.splice(index, 1, message);
        chatDerivedCache.delete(this);
        nextMessages = this.messages;
      } else {
        this.messages = nextMessages;
      }
      this.messageCollectionRevision = Number(this.messageCollectionRevision || 0) + 1;
      const tracedMessageIds = nextMessages
        .map((message) => message.record_id)
        .filter((recordId) => this.flightDeckTimingMessageIds?.has?.(recordId));
      if (tracedMessageIds.length > 0) {
        this.traceFlightDeckTiming?.('Alpine/liveQuery observed messages', {
          messageIds: tracedMessageIds,
          observedAt: new Date().toISOString(),
        });
        const renderTick = () => {
          this.traceFlightDeckTiming?.('message render tick', {
            messageIds: tracedMessageIds,
            renderedAt: new Date().toISOString(),
          });
          for (const recordId of tracedMessageIds) this.flightDeckTimingMessageIds?.delete?.(recordId);
        };
        if (typeof this.$nextTick === 'function') this.$nextTick(renderTick);
        else queueMicrotask(renderTick);
      }
    }

    const shouldScrollChatToLatest = options.scrollToLatest === true || this.pendingChatScrollToLatest || chatFeedAnchor?.atBottom;
    const shouldScrollThreadToLatest = !this.threadHistoryLoadAll
      && (options.scrollThreadToLatest === true || this.pendingThreadScrollToLatest || threadRepliesAnchor?.atBottom);

    const enrichAndRestore = () => {
      if (options.isCurrent && !options.isCurrent()) return;
      if (selectionGeneration != null && this.channelSelectionGeneration !== selectionGeneration) return;
      // Resolve sender profiles for display without writing back to Dexie.
      if (typeof this.resolveChatProfile === 'function') {
        const senderNpubs = [...new Set(nextMessages.map((m) => m.sender_npub).filter(Boolean))];
        for (const npub of senderNpubs) this.resolveChatProfile(npub);
      }
      this.syncChatPreviewState();
      this.scheduleChatPreviewMeasurement();
      this.scheduleStorageImageHydration();
      if (typeof this.refreshReactionsForVisibleTargets === 'function') {
        this.refreshReactionsForVisibleTargets().catch(() => {});
      }
      if (shouldScrollChatToLatest) this.scheduleChatFeedScrollToBottom();
      else if (chatFeedAnchor) {
        this.restoreScrollAnchor(chatFeedAnchor);
        this.updateChatFeedLoadMoreVisibility();
      }
      if (shouldScrollThreadToLatest) this.scheduleThreadRepliesScrollToBottom();
      else if (threadRepliesAnchor) this.restoreScrollAnchor(threadRepliesAnchor);
    };

    if (options.deferEnrichment) scheduleUiNextTick(enrichAndRestore);
    else enrichAndRestore();

  },
  applyThreadResponseActivities(activities = []) {
    this.threadResponseActivities = Array.isArray(activities) ? activities : [];
    this.updateResponseActivityTimer();
  },
  applyChannelResponseActivities(activities = []) {
    this.channelResponseActivities = Array.isArray(activities) ? activities : [];
    this.updateResponseActivityTimer();
  },
  applyAgentActivities(activities = []) {
    const previous = new Map((this.agentActivities || []).map((activity) => [activity.activity_id, activity]));
    for (const activity of Array.isArray(activities) ? activities : []) {
      if (isTerminalAgentActivity(activity) && !isTerminalAgentActivity(previous.get(activity.activity_id) || {})) {
        this.expandedAgentActivityIds = { ...this.expandedAgentActivityIds, [activity.activity_id]: false };
      }
    }
    this.agentActivities = Array.isArray(activities) ? activities : [];
    this.scheduleDeckInboxWorkingProjectionRefresh?.();
    this.revealPendingThreadAgentActivity(this.getVisibleAgentActivities());
    this.updateResponseActivityTimer();
  },
  applyAgentSessionHealth(sessions = []) {
    this.agentSessionHealth = Array.isArray(sessions) ? sessions : [];
  },
  updateResponseActivityTimer() {
    const hasActiveActivities = this.activeThreadResponseActivities.length > 0
      || this.getVisibleChannelResponseActivities().length > 0
      || this.getVisibleAgentActivities().some((activity) => !isTerminalAgentActivity(activity));
    if (!hasActiveActivities) {
      if (this.responseActivityTimer && typeof window !== 'undefined') {
        window.clearInterval(this.responseActivityTimer);
      }
      this.responseActivityTimer = null;
      return;
    }
    if (this.responseActivityTimer || typeof window === 'undefined') return;
    this.responseActivityTimer = window.setInterval(() => {
      this.responseActivityTick = Number(this.responseActivityTick || 0) + 1;
      if (this.activeThreadResponseActivities.length === 0 && this.getVisibleChannelResponseActivities().length === 0 && !this.getVisibleAgentActivities().some((activity) => !isTerminalAgentActivity(activity))) {
        this.updateResponseActivityTimer();
      }
    }, 900);
  },
  getVisibleChannelResponseActivities() {
    const now = Date.now();
    return sortResponseActivities((Array.isArray(this.channelResponseActivities) ? this.channelResponseActivities : [])
      .filter((activity) => isVisibleResponseActivity(activity, now)));
  },
  getVisibleAgentActivities() {
    void this.responseActivityTick;
    const towerActivities = selectVisibleAgentActivities((this.agentActivities || []).filter((activity) =>
      (!activity.workspace_id || !this.currentWorkspace?.workspaceId || activity.workspace_id === this.currentWorkspace.workspaceId)
      && (!activity.backend_url || !this.backendUrl || activity.backend_url.replace(/\/$/, '') === this.backendUrl.replace(/\/$/, ''))))
      .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || ''))
        || String(left.activity_id || '').localeCompare(String(right.activity_id || '')));
    return selectCurrentAgentActivities(this.mergeThreadLiveActivity?.(towerActivities) || towerActivities)
      .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')));
  },
  getAgentActivityHealth(activity = {}) {
    void this.responseActivityTick;
    const fallbackIsUsable = this.towerFallbackReachable === true
      && this.towerReachabilityState === 'online';
    return getAgentActivityHealth(activity, fallbackIsUsable ? 'fallback-polling' : this.sseStatus, Date.now(), {
      startedAt: fallbackIsUsable ? 0 : this.agentActivityRecoveryStartedAt,
      error: this.agentActivityRecoveryError,
    });
  },
  getAgentActivityRecoveryMessage(activity = {}) {
    if (isTerminalAgentActivity(activity) || !this.agentActivityRecoveryError) return '';
    return Number(this.agentActivityRecoveryAttempts || 0) >= 3
      ? 'Activity updates could not be recovered. Retrying with background sync.'
      : 'Activity updates could not be recovered. Retrying.';
  },
  async removeAgentActivity(activity = {}) {
    if (!activity?.record_id) return;
    await clearAgentActivity(activity.record_id);
  },
  getAgentActivitiesForMessage(message) {
    const messageId = String(message?.record_id || message || '').trim();
    if (!messageId) return [];
    return this.getVisibleAgentActivities().filter((activity) => activity.trigger_message_id === messageId);
  },
  formatEarlierAgentActivityTitle(activity = {}) {
    const state = isTerminalAgentActivity(activity) ? activity.state : 'status unconfirmed';
    return `Earlier activity · ${state}`;
  },
  formatAgentActivityTitle(activity = {}) {
    const senderName = this.getSenderName(activity.agent_npub);
    if (isTerminalAgentActivity(activity)) return `${senderName} ${activity.state}`;
    const health = this.getAgentActivityHealth(activity);
    if (health.state !== 'live') return `${senderName} · ${health.message}`;
    const tick = Number(this.responseActivityTick || 0);
    const label = activity.label || RESPONSE_ACTIVITY_WORDS[Math.floor(tick / RESPONSE_ACTIVITY_SUFFIXES.length) % RESPONSE_ACTIVITY_WORDS.length];
    return `${senderName} is ${label}${RESPONSE_ACTIVITY_SUFFIXES[tick % RESPONSE_ACTIVITY_SUFFIXES.length]}`;
  },
  getAgentActivityStatusLabel(activity = {}) {
    const health = this.getAgentActivityHealth(activity);
    if (health.state === 'stale' || health.state === 'degraded' || health.state === 'error') return health.message;
    if (activity.state === 'queued') {
      const agentName = this.getSenderName(activity.agent_npub) || 'the agent';
      return activity.queue_position ? `Queued behind ${agentName}’s current turn · position ${activity.queue_position}`
        : `Queued behind ${agentName}’s current turn`;
    }
    if (activity.state === 'accepted') return 'Message received';
    if (activity.state === 'failed') return activity.body || activity.summary || 'Failed';
    if (activity.state === 'cancelled') return activity.body || activity.summary || 'Cancelled';
    if (activity.state === 'working' || activity.state === 'waiting') return 'Working';
    return activity.label || activity.state || 'Activity';
  },
  getAgentSessionHealth(activity = {}) {
    const sessions = Array.isArray(this.agentSessionHealth) ? this.agentSessionHealth : [];
    const exact = activity.session_id
      ? sessions.filter((health) => health.session_id === activity.session_id)
      : [];
    const candidates = (exact.length > 0 ? exact : sessions.filter((health) => !activity.session_id
      && health.agent_npub === activity.agent_npub && health.channel_id === activity.channel_id
      && (!activity.thread_id || !health.thread_id || health.thread_id === activity.thread_id)))
      .sort((left, right) => Number(right.row_version) - Number(left.row_version));
    return candidates[0] || null;
  },
  getAgentSessionStatusLabel(activity = {}) {
    const health = this.getAgentSessionHealth(activity);
    if (!health) return '';
    if (health.status === 'errored') return health.error_summary ? `Session errored — ${health.error_summary}` : 'Session errored';
    if (health.status === 'stopped') return 'Session stopped';
    return `Session ${health.status}`;
  },
  toggleAgentActivity(activityId) {
    const id = String(activityId || '').trim();
    if (!id) return;
    this.expandedAgentActivityIds = { ...this.expandedAgentActivityIds, [id]: !this.expandedAgentActivityIds?.[id] };
  },
  isAgentActivityExpanded(activityId) {
    return Boolean(this.expandedAgentActivityIds?.[String(activityId || '').trim()]);
  },
  getAgentActivityCommentaryHistory(activity = {}) {
    const turnId = String(activity.turn_id || '').trim();
    const activityId = String(activity.activity_id || '').trim();
    return (Array.isArray(activity.commentary_history) ? activity.commentary_history : [])
      .filter((item) => item.turn_id === turnId && item.activity_id === activityId && item.body)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  },
  getCurrentWorkingKey(activity = {}, scope = 'thread') {
    return JSON.stringify([this.getAgentActivityRunsContext(scope).key, activity.workspace_id,
      activity.backend_url, activity.channel_id, activity.thread_id, activity.activity_id, activity.turn_id]);
  },
  getCurrentWorkingSymbol() {
    const tick = Number(this.responseActivityTick || 0);
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return '…';
    return RESPONSE_ACTIVITY_SUFFIXES[tick % RESPONSE_ACTIVITY_SUFFIXES.length];
  },
  getCurrentWorkingHistory(activity = {}) {
    const entries = this.getAgentActivityCommentaryHistory(activity).filter(item =>
      (!item.workspace_id || item.workspace_id === (activity.workspace_id || this.currentWorkspace?.workspaceId))
      && (!item.backend_url || item.backend_url.replace(/\/$/, '') === (activity.backend_url || this.backendUrl || '').replace(/\/$/, ''))
      && (!item.visibility || item.visibility === 'user_visible'));
    const bySequence = new Map(entries.map(item => [String(item.sequence), item]));
    const body = activity.body || activity.summary;
    // A snapshot can arrive before its commentary row. Preserve its full visible text.
    if (body && !entries.some(item => item.body === body)) {
      bySequence.set(String(activity.sequence), { sequence: activity.sequence, body, created_at: activity.updated_at });
    }
    return [...bySequence.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  },
  getCurrentWorkingCount(activity = {}) {
    const count = this.getCurrentWorkingHistory(activity).length;
    const label = `${count} working update${count === 1 ? '' : 's'}`;
    if (activity.commentary_next_before_sequence != null) return `${label} loaded · more available`;
    if (!Object.hasOwn(activity, 'commentary_next_before_sequence')) return `${label} loaded`;
    return label;
  },
  hasAgentActivityCommentaryHistory(activity = {}) {
    return this.getAgentActivityCommentaryHistory(activity).length > 0 || activity.commentary_next_before_sequence != null;
  },
  isCurrentAgentActivityWorking(activity = {}) {
    void this.responseActivityTick;
    if (activity.state === 'failed') return true;
    if (isTerminalAgentActivity(activity)) return false;
    if (activity.state === 'queued') {
      const expiresAt = Date.parse(activity.lease_expires_at || activity.expires_at || '');
      if (activity.lease_health === 'stale' || (Number.isFinite(expiresAt) && expiresAt <= Date.now())) return false;
    }
    const session = this.getAgentSessionHealth(activity);
    if (!session) return true;
    const activeTurnId = String(session.active_turn_id || '').trim();
    const turnId = String(activity.turn_id || '').trim();
    const state = String(activity.state || '').toLowerCase();
    // Queued work belongs to a future turn and must remain visible while the
    // session reports the turn currently ahead of it.
    if (state !== 'queued' && activeTurnId && turnId && activeTurnId !== turnId) return false;
    if (state === 'queued') return true;
    if (activeTurnId) return true;
    if (!['idle', 'errored', 'stopped'].includes(String(session.status || '').toLowerCase())) return true;
    // Ignore health left behind by an earlier lifecycle when a newer activity
    // snapshot has already arrived.
    const healthAt = Date.parse(session.updated_at || '');
    const activityAt = Date.parse(activity.updated_at || activity.created_at || '');
    return Number.isFinite(healthAt) && Number.isFinite(activityAt) && healthAt < activityAt;
  },
  getAgentActivityConnectionSummary() {
    const health = this.getAgentActivityHealth({ state: 'working', expires_at: '2999-01-01' });
    return health.message || 'Connection active';
  },
  openAgentActivityDetails(scope = 'thread') {
    this.agentActivityDetailsContext = { scope, key: this.getAgentActivityRunsContext(scope).key };
  },
  isAgentActivityDetailsOpen() {
    const context = this.agentActivityDetailsContext;
    return Boolean(context && context.key === this.getAgentActivityRunsContext(context.scope).key);
  },
  get agentActivityDetailsRows() {
    if (!this.isAgentActivityDetailsOpen()) return [];
    const scope = this.agentActivityDetailsContext.scope;
    const groups = scope === 'thread' ? this.activeThreadAgentActivities
      : this.getVisibleAgentActivities().filter(row => row.channel_id === this.activeChannelId);
    return groups.flatMap(row => [row, ...(row.earlier_activities || [])]);
  },
  getAgentActivityRunsContext(scope = 'thread') {
    const parent = scope === 'thread' ? this.getThreadParentMessage?.() : null;
    const channelId = parent?.channel_id || this.activeChannelId;
    const threadId = scope === 'thread' ? (parent?.pg_thread_id || parent?.thread_id || this.activeThreadId) : null;
    const key = `${this.currentWorkspace?.workspaceId || ''}:${this.backendUrl || ''}:${channelId || ''}:${threadId || ''}`;
    return { channelId, threadId, key };
  },
  getAgentActivityRunsLoadState(scope = 'thread') {
    return this.agentActivityRunsLoads?.[this.getAgentActivityRunsContext(scope).key] || {};
  },
  async loadEarlierAgentActivityRuns(scope = 'thread') {
    const { channelId, threadId, key } = this.getAgentActivityRunsContext(scope);
    const previous = this.agentActivityRunsLoads?.[key] || {};
    if (!channelId || (scope === 'thread' && !threadId) || previous.loading || previous.done) return;
    this.agentActivityRunsLoads = { ...this.agentActivityRunsLoads, [key]: { ...previous, loading: true, error: false } };
    try {
      const result = await this.requestTowerSyncFamily('channel-agent-activities', `${channelId}:${threadId}:${previous.cursor || 'first'}`, {
        channelId, threadId, cursor: previous.cursor,
      });
      if (this.getAgentActivityRunsContext(scope).key !== key) return;
      this.agentActivityRunsLoads = { ...this.agentActivityRunsLoads, [key]: { cursor: result?.next_cursor || null, done: !result?.next_cursor } };
    } catch {
      if (this.getAgentActivityRunsContext(scope).key !== key) return;
      this.agentActivityRunsLoads = { ...this.agentActivityRunsLoads, [key]: { ...previous, error: true } };
    } finally {
      if (this.agentActivityRunsLoads?.[key]?.loading) {
        this.agentActivityRunsLoads = { ...this.agentActivityRunsLoads, [key]: { ...previous, loading: false } };
      }
    }
  },
  async loadEarlierAgentActivityHistory(activity = {}) {
    const beforeSequence = activity.commentary_next_before_sequence;
    if (beforeSequence == null || !activity.channel_id || !activity.activity_id) return;
    const requestKey = `${activity.channel_id}:${activity.activity_id}:${beforeSequence}`;
    const key = this.getAgentActivityHistoryLoadKey(activity);
    if (this.agentActivityHistoryLoads?.[key] === 'loading') return;
    this.agentActivityHistoryLoads = { ...this.agentActivityHistoryLoads, [key]: 'loading' };
    try {
      await this.requestTowerSyncFamily('agent-activity-history', requestKey, {
        channelId: activity.channel_id, activityId: activity.activity_id,
        turnId: activity.turn_id, beforeSequence,
      });
      this.agentActivityHistoryLoads = { ...this.agentActivityHistoryLoads, [key]: '' };
    } catch {
      this.agentActivityHistoryLoads = { ...this.agentActivityHistoryLoads, [key]: 'failed' };
    }
  },
  getAgentActivityHistoryLoadKey(activity = {}) {
    return JSON.stringify([this.currentWorkspace?.workspaceId, this.backendUrl, activity.channel_id,
      activity.thread_id, activity.activity_id, activity.turn_id, activity.commentary_next_before_sequence]);
  },
  getAgentActivityHistoryLoadState(activity = {}) {
    return this.agentActivityHistoryLoads?.[this.getAgentActivityHistoryLoadKey(activity)] || '';
  },
  toggleAgentActivityHistory(activity = {}) {
    const id = String(activity.turn_id || activity.activity_id || '').trim();
    if (!id) return;
    this.expandedAgentActivityHistoryIds = { ...this.expandedAgentActivityHistoryIds, [id]: !this.expandedAgentActivityHistoryIds?.[id] };
  },
  isAgentActivityHistoryExpanded(activity = {}) {
    const id = String(activity.turn_id || activity.activity_id || '').trim();
    return Boolean(this.expandedAgentActivityHistoryIds?.[id]);
  },
  getResponseActivitiesForThread(threadOrMessage) {
    const ids = new Set();
    if (threadOrMessage && typeof threadOrMessage === 'object') {
      [threadOrMessage.record_id, threadOrMessage.pg_thread_id, threadOrMessage.thread_id].forEach((value) => {
        const id = String(value || '').trim();
        if (id) ids.add(id);
      });
    } else {
      const id = String(threadOrMessage || '').trim();
      if (id) ids.add(id);
      const message = (Array.isArray(this.messages) ? this.messages : [])
        .find((item) => item?.record_id === id || item?.pg_thread_id === id);
      [message?.record_id, message?.pg_thread_id, message?.thread_id].forEach((value) => {
        const resolved = String(value || '').trim();
        if (resolved) ids.add(resolved);
      });
    }
    if (ids.size === 0) return [];
    void this.responseActivityTick;
    return this.getVisibleChannelResponseActivities()
      .filter((activity) => activity.target_type === 'chat_thread' && (
        ids.has(String(activity.target_id || '').trim())
        || ids.has(String(activity.thread_id || '').trim())
      ));
  },
  formatResponseActivityTitle(activity = {}) {
    if (activity.status === 'failed') return activity.label || 'Response failed';
    const senderName = this.getSenderName(activity.actor_npub);
    const status = String(activity.status || '').trim().toLowerCase();
    const statusLabel = status === 'drafting' ? 'Writing' : status;
    const label = activity.label || statusLabel || 'Thinking';
    const tick = Number(this.responseActivityTick || 0);
    const suffix = RESPONSE_ACTIVITY_SUFFIXES[tick % RESPONSE_ACTIVITY_SUFFIXES.length];
    const shouldAnimateWord = !activity.label || ['thinking', 'implementing', 'writing', 'drafting'].includes(String(activity.label).toLowerCase());
    const activityText = shouldAnimateWord
      ? RESPONSE_ACTIVITY_WORDS[Math.floor(tick / RESPONSE_ACTIVITY_SUFFIXES.length) % RESPONSE_ACTIVITY_WORDS.length]
      : String(label);
    return `${senderName} is ${activityText}${suffix}`;
  },

  async refreshMessages(options = {}) {
    const revision = Number(this.messageCollectionRevision || 0);
    const workspace = this.currentWorkspaceKey;
    const threadId = this.activeThreadId;
    const selectionGeneration = this.channelSelectionGeneration;
    const originalIsCurrent = options.isCurrent;
    options = { ...options, isCurrent: () => (!originalIsCurrent || originalIsCurrent())
      && this.currentWorkspaceKey === workspace && this.activeThreadId === threadId
      && this.channelSelectionGeneration === selectionGeneration };
    if (this.navSection === 'status' && this.deckThreadChannelId && threadId) {
      const channelId = this.deckThreadChannelId;
      const messages = await getThreadMessagePresentationWindow(channelId, threadId, {
        threadId: this.deckThreadTowerId, replyLimit: this.threadVisibleReplyCount,
      });
      if (this.deckThreadChannelId !== channelId || Number(this.messageCollectionRevision || 0) !== revision) return;
      await this.applyMessages(messages, { ...options, threadDetail: true });
      return;
    }
    const channelId = this.selectedChannelId;
    if (!channelId) {
      if (this.currentWorkspace?.pgBackendMode || this.pgBackendMode) {
        const channelIds = (Array.isArray(this.pgContextChannels) ? this.pgContextChannels : [])
          .map((channel) => channel?.record_id)
          .filter(Boolean);
        const messages = await getMessagePresentationWindowByChannels(channelIds, {
          rootLimit: this.mainFeedVisibleCount || this.MAIN_FEED_PAGE_SIZE,
          activeThreadId: this.activeThreadId,
          focusMessageId: this.focusMessageId,
        });
        if (this.selectedChannelId || Number(this.messageCollectionRevision || 0) !== revision) return;
        await this.applyMessages(messages, options);
        return;
      }
      await this.applyMessages([], { scrollToLatest: false });
      return;
    }
    const messages = await getMessagesByChannel(channelId);
    if (this.selectedChannelId !== channelId || Number(this.messageCollectionRevision || 0) !== revision) return;
    await this.applyMessages(messages, options);
  },

  reconcileOpenThreadIdentity(messages = []) {
    const activeId = String(this.activeThreadId || '').trim();
    if (!activeId) return;
    const source = messages.find(row => !row.parent_message_id && row.record_id !== activeId
      && (row.pg_client_record_id === activeId || row.pg_thread_id === activeId));
    if (!source) return;
    const oldDraftKey = this.getChatComposerDraftKey('thread');
    this.activeThreadId = source.record_id;
    const drafts = { ...(this.chatComposerDrafts || {}) };
    delete drafts[oldDraftKey];
    this.chatComposerDrafts = drafts;
    this.saveChatComposerDraft('thread');
    this.syncRoute?.();
  },

  patchMessageLocal(nextMessage) {
    // Canonical rows use the source message as parent; the Inbox modal may be
    // keyed by the thread record. Match its Dexie presentation without changing storage.
    if (this.navSection === 'status' && this.deckThreadChannelId && this.activeThreadId
      && nextMessage.channel_id === this.deckThreadChannelId
      && nextMessage.record_id !== this.activeThreadId
      && nextMessage.pg_record_type !== 'thread'
      && nextMessage.pg_thread_id === (this.deckThreadTowerId || this.activeThreadId)) {
      nextMessage = { ...nextMessage, parent_message_id: this.activeThreadId };
    }
    this.reconcileOpenThreadIdentity([nextMessage]);
    if (nextMessage.pg_record_type === 'message' && !nextMessage.parent_message_id && nextMessage.pg_thread_id) {
      this.messages = this.messages.filter(row => !(row.pg_record_type === 'thread' && !Array.isArray(row.pg_effective_message_ids)
        && row.record_id === nextMessage.pg_thread_id && row.pg_source_message_id === nextMessage.record_id));
    }
    const index = this.messages.findIndex((item) => item.record_id === nextMessage.record_id);
    if (index >= 0) {
      this.messages.splice(index, 1, { ...this.messages[index], ...nextMessage });
      chatDerivedCache.delete(this);
      this.messageCollectionRevision = Number(this.messageCollectionRevision || 0) + 1;
      this.syncChatPreviewState();
      this.scheduleChatPreviewMeasurement();
      this.scheduleStorageImageHydration();
      return;
    }
    this.messages = sortMessagesByUpdatedAt([...this.messages, nextMessage]);
    this.messageCollectionRevision = Number(this.messageCollectionRevision || 0) + 1;
    this.syncChatPreviewState();
    this.scheduleChatPreviewMeasurement();
    this.scheduleStorageImageHydration();
  },

  async setMessageSyncStatus(recordId, syncStatus) {
    const message = this.messages.find((item) => item.record_id === recordId)
      ?? await getMessageById(recordId);
    if (!message) return;
    if (message.pg_backend) {
      const updated = await updateExistingMessageSyncStatus(recordId, syncStatus);
      if (updated) this.patchMessageLocal(updated);
      else this.messages = this.messages.filter(row => row.record_id !== recordId);
      return;
    }
    const updated = {
      ...message,
      sync_status: syncStatus,
    };
    await upsertMessage(updated);
    this.patchMessageLocal(updated);
  },

  // --- thread lifecycle ---

  canBranchFromMessage(message) {
    if (!this.isTowerPgMode || !message?.pg_backend || message?.record_state === 'deleted') return false;
    if (message?.pg_record_type === 'thread') return false;
    return Boolean(message?.pg_thread_id || message?.pg_effective_thread_id);
  },

  isBranchFromMessageSubmitting(recordId) {
    return this.branchSubmittingMessageId === String(recordId || '').trim();
  },

  getBranchHistoryThrough(message) {
    const messageId = String(message?.record_id || '').trim();
    if (!messageId) return [];
    const activeThread = this.getActiveThreadRecord?.();
    const activeEffectiveIds = Array.isArray(activeThread?.pg_effective_message_ids)
      ? activeThread.pg_effective_message_ids.map(String)
      : [];
    let history;
    if (activeEffectiveIds.includes(messageId)) {
      const byId = new Map((this.messages || []).map((row) => [String(row?.record_id || ''), row]));
      history = activeEffectiveIds.map((id) => byId.get(id)).filter(Boolean);
    } else {
      const rootId = String(message?.parent_message_id || messageId).trim();
      const root = (this.messages || []).find((row) => row?.record_id === rootId) || message;
      history = [root, ...(this.getThreadReplies?.(rootId) || [])];
    }
    const branchIndex = history.findIndex((row) => row?.record_id === messageId);
    return branchIndex >= 0 ? history.slice(0, branchIndex + 1) : [message];
  },

  resolveBranchAgentRecipient(message) {
    const history = this.getBranchHistoryThrough(message);
    const knownAgentNpubs = new Set((this.visiblePersonalAgents || [])
      .map((agent) => String(agent?.npub || '').trim())
      .filter(Boolean));
    for (const row of [...history].reverse()) {
      const metadata = row?.pg_metadata && typeof row.pg_metadata === 'object' ? row.pg_metadata : {};
      const mention = (Array.isArray(metadata.mentions) ? metadata.mentions : [])
        .find((entry) => {
          const npub = String(entry?.npub || '').trim();
          return npub && (entry?.type === 'agent' || knownAgentNpubs.has(npub));
        });
      if (mention) return { type: 'agent', npub: String(mention.npub).trim(), label: String(mention.label || this.getSenderName?.(mention.npub) || mention.npub).trim() };
    }
    const inheritedNpub = String(this.getActiveThreadRecord?.()?.pg_metadata?.inherited_agent_recipient_npub || '').trim();
    if (inheritedNpub) return { type: 'agent', npub: inheritedNpub, label: this.getSenderName?.(inheritedNpub) || inheritedNpub };
    const channel = (this.channels || []).find((item) => item?.record_id === message?.channel_id) || this.selectedChannel;
    if ([channel?.kind, channel?.channel_type, channel?.pg_kind].includes('dm')) {
      const ownNpub = String(this.session?.npub || '').trim();
      const agentNpub = (channel.participant_npubs || [])
        .map((npub) => String(npub || '').trim())
        .find((npub) => npub && npub !== ownNpub && knownAgentNpubs.has(npub));
      if (agentNpub) return { type: 'agent', npub: agentNpub, label: this.getSenderName?.(agentNpub) || agentNpub };
    }
    return null;
  },

  getActiveBranchRecipientNpub() {
    return String(this.getActiveThreadRecord?.()?.pg_metadata?.inherited_agent_recipient_npub || '').trim();
  },

  async branchFromMessage(recordId) {
    const messageId = String(recordId || '').trim();
    const message = (this.messages || []).find((row) => row?.record_id === messageId) || null;
    if (!this.canBranchFromMessage(message) || this.branchSubmittingMessageId) return false;
    const activeThread = this.getActiveThreadRecord?.();
    const effectiveIds = Array.isArray(activeThread?.pg_effective_message_ids) ? activeThread.pg_effective_message_ids.map(String) : [];
    const parentThreadId = effectiveIds.includes(messageId)
      ? String(activeThread?.pg_thread_id || activeThread?.record_id || '').trim()
      : String(message?.pg_thread_id || '').trim();
    const recipient = this.resolveBranchAgentRecipient(message);
    const requestIds = { ...(this.branchRequestIdsByMessage || {}) };
    const clientRequestId = requestIds[messageId] || `branch:${crypto.randomUUID()}`;
    requestIds[messageId] = clientRequestId;
    this.branchRequestIdsByMessage = requestIds;
    this.branchSubmittingMessageId = messageId;
    this.branchThreadError = '';
    this.closeMessageActionsMenu?.();
    try {
      const thread = await branchTowerPgThreadFromMessage(this, message, {
        clientRequestId,
        recipientNpub: recipient?.npub || '',
        parentThreadId,
      });
      const history = this.getBranchHistoryThrough(message);
      const materialized = {
        ...thread,
        pg_effective_message_ids: history.map((row) => row.record_id).filter(Boolean),
      };
      await upsertMessage(materialized);
      this.patchMessageLocal(materialized);
      const nextRequestIds = { ...(this.branchRequestIdsByMessage || {}) };
      delete nextRequestIds[messageId];
      this.branchRequestIdsByMessage = nextRequestIds;
      this.openThread(materialized.record_id, { scrollToLatest: false });
      void this.requestTowerSyncFamily?.('thread-history', `${materialized.channel_id}:${materialized.pg_thread_id}`, {
        channelId: materialized.channel_id,
        threadId: materialized.pg_thread_id,
        force: true,
      });
      return materialized;
    } catch (error) {
      this.branchThreadError = error instanceof Error ? error.message : String(error);
      this.error = `Branch could not be created: ${this.branchThreadError}`;
      return false;
    } finally {
      this.branchSubmittingMessageId = null;
    }
  },

  async openLinkedThread(reference, deps = {}) {
    const raw = String(reference || '').trim();
    if (!raw) return false;
    const separator = raw.indexOf('#');
    const recordId = separator > 0 ? raw.slice(separator + 1) : raw;
    let channelId = separator > 0 ? raw.slice(0, separator) : '';
    const requestId = Number(this.linkedThreadOpenRequestId || 0) + 1;
    this.linkedThreadOpenRequestId = requestId;
    this.linkedThreadOpenError = '';
    this.linkedThreadOpening = true;
    const context = resolveTowerPgWorkspaceContext(this);
    const workspaceDbKey = getCurrentWorkspaceDbKey();
    const section = this.navSection;
    const sourceThreadId = this.activeThreadId;
    const sourceHistoryGeneration = this.threadHistoryGeneration;
    const sourceChannelId = this.selectedChannelId;
    let selectingChannel = false;
    const isCurrentWorkspace = () => {
      const current = resolveTowerPgWorkspaceContext(this);
      return this.linkedThreadOpenRequestId === requestId
        && deps.isCurrent?.() !== false
        && current.workspaceId === context.workspaceId && current.baseUrl === context.baseUrl
        && current.appNpub === context.appNpub && current.generation === context.generation
        && current.sessionNpub === context.sessionNpub;
    };
    const isCurrent = () => isCurrentWorkspace() && this.navSection === section
      && this.activeThreadId === sourceThreadId && this.threadHistoryGeneration === sourceHistoryGeneration;
    try {
      let message = (this.messages || []).find(row => row.record_id === recordId || row.pg_thread_id === recordId)
        || (this.fileMessages || []).find(row => row.record_id === recordId || row.pg_thread_id === recordId)
        || await (deps.getMessageById || getMessageById)(recordId);
      if (!isCurrent() || this.selectedChannelId !== sourceChannelId) return false;
      if (message && (message.record_state === 'deleted' || message.deleted_at
        || message.can_read === false || message.readable === false
        || (message.pg_workspace_id && message.pg_workspace_id !== context.workspaceId))) {
        throw new Error('This linked message is unavailable in the current workspace.');
      }
      if (channelId && message?.channel_id && channelId !== message.channel_id) {
        throw new Error('This linked message does not belong to the referenced channel.');
      }
      channelId ||= message?.channel_id || '';
      let threadId = message?.pg_thread_id || (message?.pg_backend ? null : recordId);
      // A bare thread ID is valid even outside the rendered channel window.
      // Read only its routing metadata here; existing live queries own content.
      if (!channelId && isTowerPgBackendMode()) {
        let result;
        try {
          result = await (deps.getTowerPgThread || getTowerPgThread)(context.workspaceId, recordId, {
            baseUrl: context.baseUrl, appNpub: context.appNpub,
          });
        } catch (error) {
          if (error?.status !== 404) throw error;
          if (!isCurrent() || this.selectedChannelId !== sourceChannelId) return false;
          const resolved = await (deps.getTowerPgMessage || getTowerPgMessage)(context.workspaceId, recordId, {
            baseUrl: context.baseUrl, appNpub: context.appNpub,
          });
          if (!isCurrent() || this.selectedChannelId !== sourceChannelId) return false;
          const remote = resolved?.message;
          const thread = resolved?.thread;
          if (!remote || remote.id !== recordId || remote.workspace_id !== context.workspaceId
            || remote.deleted_at || remote.record_state === 'deleted'
            || !resolved.channel_id || remote.channel_id !== resolved.channel_id
            || (remote.thread_id || null) !== (resolved.thread_id || null)
            || (thread && (thread.id !== resolved.thread_id || thread.workspace_id !== context.workspaceId
              || thread.channel_id !== resolved.channel_id || thread.deleted_at || thread.record_state === 'deleted'))
            || (resolved.thread_id && !thread)) throw new Error('This linked message is unavailable in the current workspace.');
          message = mapPgMessageToLocal(remote, {
            workspaceOwnerNpub: context.workspaceOwnerNpub,
            threadById: new Map(thread ? [[thread.id, thread]] : []),
          });
          const rows = thread ? [mapPgThreadToLocal(thread, { workspaceOwnerNpub: context.workspaceOwnerNpub }), message] : [message];
          const persist = async () => {
            if (!isCurrent() || this.selectedChannelId !== sourceChannelId) return false;
            for (const row of rows) {
              await (deps.upsertMessage || upsertMessage)(row);
              if (!isCurrent() || this.selectedChannelId !== sourceChannelId) throw new Error('Linked message visit changed.');
            }
            return true;
          };
          const persisted = deps.upsertMessage ? await persist() : await withWorkspaceMessageTransaction(workspaceDbKey, persist);
          if (!persisted || !isCurrent() || this.selectedChannelId !== sourceChannelId) return false;
          channelId = resolved.channel_id;
          threadId = resolved.thread_id || null;
        }
        if (result) {
          if (!isCurrent() || this.selectedChannelId !== sourceChannelId) return false;
          const thread = result?.thread || result;
          if (thread?.id !== recordId || (thread.workspace_id && thread.workspace_id !== context.workspaceId)
            || thread.deleted_at || thread.record_state === 'deleted') throw new Error('This linked thread is unavailable.');
          channelId = thread.channel_id;
          threadId = thread.id;
        }
      }
      if (!channelId || !recordId || message?.record_state === 'deleted') {
        throw new Error('This linked thread is unavailable in the current workspace.');
      }
      if (deps.beforeOpen) {
        if (await deps.beforeOpen() === false) return false;
        if (!isCurrent() || this.selectedChannelId !== sourceChannelId) return false;
      }
      this.error = null;
      this.mobileNavOpen = false;
      const openId = message?.parent_message_id ? (message.pg_thread_id || message.parent_message_id) : recordId;
      if (section === 'status' && threadId) {
        const opened = await this.openDeckThread(channelId, openId, {
          towerThreadId: threadId, captureReturnContext: !sourceThreadId, scrollToLatest: false,
        });
        if (!isCurrentWorkspace()) return false;
        if (opened) this.focusMessageId = recordId;
        return opened;
      }
      selectingChannel = true;
      if (!threadId && this.deckThreadChannelId) this.closeDeckThread?.({ syncRoute: false, fromRoute: true });
      this.navSection = 'chat';
      this.startWorkspaceLiveQueries?.();
      const docGeneration = this.docOpenGeneration;
      const taskGeneration = this.taskDetailOpenGeneration;
      const selectingIsCurrent = () => isCurrentWorkspace() && this.navSection === 'chat'
        && this.docOpenGeneration === docGeneration && this.taskDetailOpenGeneration === taskGeneration;
      await this.selectChannel?.(channelId, { syncRoute: false, isCurrent: selectingIsCurrent });
      if (!selectingIsCurrent() || this.selectedChannelId !== channelId) return false;
      if (threadId) this.openThread(openId, { scrollToLatest: false, syncRoute: false });
      else {
        this.saveChatComposerDraft?.('thread');
        this.activeThreadId = null;
      }
      this.focusMessageId = recordId;
      this.syncRoute?.();
      return true;
    } catch (error) {
      if (isCurrent() || (selectingChannel && isCurrentWorkspace() && this.navSection === 'chat'
        && [sourceChannelId, channelId].includes(this.selectedChannelId)
        && [sourceThreadId, null].includes(this.activeThreadId))) {
        this.error = `Could not open linked thread: ${error?.message || String(error)}`;
        if (this.activeThreadId === sourceThreadId) this.linkedThreadOpenError = this.error;
      }
      return false;
    } finally {
      if (this.linkedThreadOpenRequestId === requestId) this.linkedThreadOpening = false;
    }
  },

  openThread(recordId, options = {}) {
    if (options.saveDraft !== false) this.saveChatComposerDraft?.('thread');
    const message = this.messages.find((item) => item.record_id === recordId) || null;
    if (
      options.preserveChannelContext !== true
      && isTowerPgBackendMode()
      && message?.channel_id
      && message.channel_id !== this.selectedChannelId
    ) {
      this.selectPgChannelContext?.(message.channel_id, { preserveDetail: true });
    }
    this.threadHistoryGeneration = (this.threadHistoryGeneration || 0) + 1;
    this.threadHistoryCursor = null;
    this.threadHistoryError = '';
    this.linkedThreadOpenError = '';
    this.threadHistoryLoading = false;
    this.threadHistoryLoadAll = false;
    this.activeThreadId = recordId;
    if (this.navSection === 'status' && this.deckThreadChannelId) {
      // Retain only this selection. Dexie liveQuery publishes the latest rows;
      // never reuse an unvalidated cross-thread presentation cache.
      const threadId = this.deckThreadTowerId || message?.pg_thread_id || recordId;
      this.messages = this.messages.filter(row => row.channel_id === this.deckThreadChannelId
        && (row.pg_thread_id === threadId || row.record_id === recordId || row.parent_message_id === recordId));
    }
    this.threadMenuOpen = false;
    this.threadTitleEditing = false;
    this.threadTitleError = '';
    this.threadResponseActivities = [];
    if (options.preserveComposer !== true) this.restoreChatComposerDraft?.('thread');
    this.threadVisibleReplyCount = this.THREAD_REPLY_PAGE_SIZE;
    this.pendingThreadScrollToLatest = options.scrollToLatest !== false;
    if (typeof this.startWorkspaceLiveQueries === 'function') this.startWorkspaceLiveQueries();
    void this.startThreadLiveActivity?.();
    if (this.navSection === 'status' && this.deckThreadChannelId) {
      this.threadHistoryCursor = null;
      this.threadHistoryError = '';
      this.threadHistoryLoading = false;
      void this.loadDeckThreadHistoryPage({ initial: true });
    }
    const actualThreadId = String(message?.pg_thread_id
      || (this.navSection === 'status' ? this.deckThreadTowerId : '') || '').trim();
    if (actualThreadId) {
      void this.markTowerPgResourceViewed?.('thread', actualThreadId, message?.pg_thread_activity_version);
    }
    if (this.pendingThreadScrollToLatest) this.scheduleThreadRepliesScrollToBottom();
    if (options.syncRoute !== false) this.syncRoute();
  },

  async loadDeckThreadHistoryPage({ all = false, initial = false } = {}) {
    if (this.threadHistoryLoading || !this.requestTowerSyncFamily) return;
    const rootId = this.activeThreadId;
    const channelId = this.navSection === 'status' ? this.deckThreadChannelId : this.selectedChannelId;
    let threadId = (this.navSection === 'status' ? this.deckThreadTowerId : null) || resolvePgThreadId(this, rootId);
    const workspaceKey = this.currentWorkspaceKey;
    const generation = this.threadHistoryGeneration;
    if (!rootId || !channelId) return;
    const isCurrent = () => this.activeThreadId === rootId
      && (this.navSection === 'status' ? this.deckThreadChannelId : this.selectedChannelId) === channelId
      && this.currentWorkspaceKey === workspaceKey && this.threadHistoryGeneration === generation;
    this.threadHistoryLoading = true;
    this.threadHistoryError = '';
    try {
      if (!threadId) threadId = (await getMessageById(rootId))?.pg_thread_id || rootId;
      if (!isCurrent()) return;
      if (initial) {
        const coverage = await getThreadHistoryCoverage(channelId, threadId, `${towerPgSyncCursorKey(this)}:record-delta-v1`);
        if (!isCurrent()) return;
        this.threadHistoryCursor = coverage?.nextCursor || null;
        if (coverage?.fresh) return;
      }
      const seen = new Set();
      let firstPage = initial;
      do {
        const cursor = firstPage ? null : this.threadHistoryCursor || null;
        firstPage = false;
        seen.add(cursor);
        const result = await this.requestTowerSyncFamily('thread-history-page', `${channelId}:${threadId}:${cursor || 'first'}`, {
          channelId, threadId, cursor, limit: 100, force: all,
        });
        if (!isCurrent()) return;
        if (!result || !Object.hasOwn(result, 'nextCursor')) throw new Error('Unable to load conversation history; retry');
        if (result.nextCursor && seen.has(result.nextCursor)) throw new Error('Conversation history cursor did not advance; retry');
        this.threadHistoryCursor = result.nextCursor || null;
      } while (all && this.threadHistoryCursor);
    } catch (error) {
      if (isCurrent()) this.threadHistoryError = error?.message || 'Unable to load conversation history';
    } finally {
      if (isCurrent()) this.threadHistoryLoading = false;
    }
  },

  cycleThreadSize() {
    this.threadSize = this.threadSize === 'full' ? 'default' : 'full';
  },

  closeThread(options = {}) {
    if (this.messageEdit?.context === 'thread' && this.messageEdit.submitting) return false;
    this.stopReadAloud?.();
    this.stopThreadLiveActivity?.();
    if (this.messageEdit?.context === 'thread') this.cancelMessageEdit();
    if (options.saveDraft !== false) this.saveChatComposerDraft?.('thread');
    this.threadHistoryGeneration = (this.threadHistoryGeneration || 0) + 1;
    this.threadHistoryLoading = false;
    this.threadHistoryLoadAll = false;
    this.activeThreadId = null;
    this.threadMenuOpen = false;
    this.threadTitleEditing = false;
    this.threadTitleDraft = '';
    this.threadTitleError = '';
    this.threadResponseActivities = [];
    this.threadInput = '';
    if (typeof this.clearChatFileDrafts === 'function') this.clearChatFileDrafts('thread');
    else this.threadFileDrafts = [];
    this.threadVisibleReplyCount = this.THREAD_REPLY_PAGE_SIZE;
    this.threadSize = 'default';
    this.pendingThreadScrollToLatest = false;
    this.pendingThreadActivityAutoScroll = null;
    if (typeof this.startWorkspaceLiveQueries === 'function') this.startWorkspaceLiveQueries();
    if (options.syncRoute !== false) this.syncRoute();
    return true;
  },

  async showMoreThreadMessages() {
    if (this.threadHistoryLoading || this.threadHistoryLoadAll) return;
    const generation = this.threadHistoryGeneration;
    const rootId = this.activeThreadId;
    const workspace = this.currentWorkspaceKey;
    const isCurrent = () => this.threadHistoryGeneration === generation
      && this.activeThreadId === rootId && this.currentWorkspaceKey === workspace;
    const anchor = this.captureScrollAnchor({
      containerSelector: '[data-thread-replies]',
      itemSelector: '[data-thread-reply]',
      itemAttribute: 'data-thread-message-id',
    });
    if (anchor) anchor.atBottom = false;
    this.threadHistoryLoadAll = true;
    this.pendingThreadScrollToLatest = false;
    try {
      await this.loadDeckThreadHistoryPage({ all: true });
      if (!isCurrent()) return;
      // Start the expanded Dexie subscription only after the last page commits,
      // so an earlier bounded projection cannot win the final refresh race.
      this.threadVisibleReplyCount = Number.MAX_SAFE_INTEGER;
      this.startWorkspaceLiveQueries?.();
      await this.refreshMessages({ isCurrent, historyComplete: true });
      if (isCurrent()) this.restoreScrollAnchor(anchor);
    } catch (error) {
      if (isCurrent()) this.threadHistoryError = error?.message || 'Unable to load conversation history';
    } finally {
      if (isCurrent()) this.threadHistoryLoadAll = false;
    }
  },

  showMoreMainFeedMessages() {
    const anchor = this.captureScrollAnchor({
      containerSelector: '[data-chat-feed]',
      itemSelector: '[data-message-id]',
      itemAttribute: 'data-message-id',
    });
    this.mainFeedVisibleCount += this.MAIN_FEED_PAGE_SIZE;
    this.startWorkspaceLiveQueries?.();
    this.restoreScrollAnchor(anchor);
    this.updateChatFeedLoadMoreVisibility();
  },

  getThreadParentMessage() {
    if (!this.activeThreadId) return null;
    return this.mainFeedMessages.find(msg => msg.record_id === this.activeThreadId)
      ?? this.messages.find(msg => msg.record_id === this.activeThreadId)
      ?? this.messages.find(msg => !msg.parent_message_id && msg.pg_source_message_id === this.activeThreadId)
      ?? null;
  },

  getActiveThreadRecord() {
    const parent = this.getThreadParentMessage();
    const threadId = String(parent?.pg_thread_id || parent?.thread_id || '').trim();
    if (!threadId) return parent;
    return this.messages.find((item) => item?.pg_record_type === 'thread' && String(item.pg_thread_id || item.record_id) === threadId)
      || parent;
  },

  getActiveThreadTitle() {
    const thread = this.getActiveThreadRecord();
    return String(thread?.title || thread?.body || 'Untitled thread').trim() || 'Untitled thread';
  },

  canRenameThreadTitle(message) {
    return Boolean(
      this.isTowerPgMode
      && message?.pg_backend
      && !message?.parent_message_id
      && (message?.pg_thread_id || message?.thread_id),
    );
  },

  toggleThreadMenu() {
    this.threadMenuOpen = !this.threadMenuOpen;
    if (!this.threadMenuOpen && !this.threadTitleSaving) this.cancelThreadTitleEdit();
  },

  startThreadTitleEdit(recordId = null) {
    if (recordId && recordId !== this.activeThreadId) {
      const message = this.messages.find((item) => item.record_id === recordId) || null;
      if (!this.canRenameThreadTitle(message)) return;
      this.openThread(recordId);
    }
    this.threadTitleDraft = this.getActiveThreadTitle();
    this.threadTitleError = '';
    this.threadTitleEditing = true;
    this.threadMenuOpen = false;
    this.closeMessageActionsMenu?.();
  },

  cancelThreadTitleEdit() {
    if (this.threadTitleSaving) return;
    this.threadTitleEditing = false;
    this.threadTitleDraft = '';
    this.threadTitleError = '';
  },

  async saveThreadTitle() {
    if (this.threadTitleSaving) return;
    const title = String(this.threadTitleDraft || '').replace(/\s+/g, ' ').trim();
    if (!title) {
      this.threadTitleError = 'Enter a thread title.';
      return;
    }
    if (title.length > 120) {
      this.threadTitleError = 'Thread titles can be up to 120 characters.';
      return;
    }
    const thread = this.getActiveThreadRecord();
    if (!thread?.pg_backend) {
      this.threadTitleError = 'Thread titles can only be renamed in a connected Tower workspace.';
      return;
    }
    this.threadTitleSaving = true;
    this.threadTitleError = '';
    try {
      const updated = await updateTowerPgThreadTitleFromLocal(this, thread, title);
      await upsertMessage(updated);
      this.patchMessageLocal(updated);
      this.threadTitleEditing = false;
      this.threadTitleDraft = '';
    } catch (error) {
      this.threadTitleError = error?.message || 'Could not rename the thread.';
    } finally {
      this.threadTitleSaving = false;
    }
  },

  getThreadReplyCount(recordId) {
    return getChatDerivedState(this).threadRepliesByParentId.get(recordId)?.length || 0;
  },

  getThreadReplies(recordId) {
    if (!recordId) return [];
    return getChatDerivedState(this).threadRepliesByParentId.get(recordId) || [];
  },

  getLatestThreadReply(recordId) {
    const replies = this.getThreadReplies(recordId);
    return replies[replies.length - 1] || null;
  },

  getLatestThreadReplyPreview(recordId) {
    const latestReply = this.getLatestThreadReply(recordId);
    if (!latestReply) return '';
    return truncateWords(latestReply.body, THREAD_REPLY_PREVIEW_WORD_LIMIT);
  },

  getThreadMessageCount(recordId) {
    const root = this.messages.find(row => row.record_id === recordId);
    const ids = new Set(this.getThreadReplies(recordId).map(row => row.record_id));
    if (root && root.pg_record_type !== 'thread') ids.add(root.record_id);
    for (const id of root?.pg_effective_message_ids || []) {
      if (this.messages.some(row => row.record_id === id && row.pg_record_type !== 'thread')) ids.add(id);
    }
    return ids.size;
  },

  get threadHasLocalContent() {
    return Boolean(this.getThreadParentMessage()?.pg_record_type !== 'thread' && this.getThreadParentMessage())
      || this.threadMessages.length > 0;
  },

  getThreadCardTitle(message) {
    return String(message?.title || message?.pg_thread_title || normalizePreviewText(message?.body) || 'Untitled thread').trim();
  },

  getThreadReplierAvatars(recordId) {
    const seen = new Set();
    const avatars = [];
    for (const reply of this.getThreadReplies(recordId)) {
      const npub = reply?.sender_npub;
      if (!npub || seen.has(npub)) continue;
      seen.add(npub);
      const name = this.getSenderName?.(npub) || npub;
      avatars.push({
        npub,
        name,
        avatarUrl: this.getSenderAvatar?.(npub) || null,
        initials: this.getInitials?.(name) || '?',
      });
    }
    return avatars;
  },

  // --- chat preview truncation ---

  isChatMessageExpanded(recordId) {
    return hasPreviewId(this.expandedChatMessageIds, recordId);
  },

  isChatMessageTruncated(recordId) {
    return hasPreviewId(this.truncatedChatMessageIds, recordId);
  },

  toggleChatMessageExpanded(recordId) {
    if (!recordId) return;
    this.expandedChatMessageIds = togglePreviewId(this.expandedChatMessageIds, recordId);
    this.scheduleChatPreviewMeasurement();
  },

  syncChatPreviewState() {
    const validIds = new Set(this.visibleMainFeedMessages.map((message) => message.record_id));
    const nextState = prunePreviewState({
      expandedIds: this.expandedChatMessageIds,
      truncatedIds: this.truncatedChatMessageIds,
      validIds,
    });
    this.expandedChatMessageIds = nextState.expandedIds;
    this.truncatedChatMessageIds = nextState.truncatedIds;
  },

  scheduleChatPreviewMeasurement() {
    schedulePreviewMeasurement({
      getFrameId: () => this.chatPreviewMeasureFrame,
      setFrameId: (frameId) => { this.chatPreviewMeasureFrame = frameId; },
      setTruncatedIds: (ids) => { this.truncatedChatMessageIds = ids; },
      selector: '[data-chat-preview-id]',
      idDatasetKey: 'chatPreviewId',
      maxLinesDatasetKey: 'chatPreviewMaxLines',
      defaultMaxLines: this.MESSAGE_PREVIEW_MAX_LINES,
    });
  },

  // --- send / create / delete ---

  async createBotDm(targetNpubInput = null) {
    this.error = null;
    const ownerNpub = this.workspaceOwnerNpub;
    const memberNpub = this.session?.npub;
    const targetNpub = String(targetNpubInput || this.botNpub || '').trim();
    if (!ownerNpub || !memberNpub || !targetNpub) {
      this.error = 'Sign in and set bot npub first';
      return;
    }
    if (!this.backendUrl) {
      this.error = 'Set backend URL first';
      return;
    }
    if (isTowerPgBackendMode()) {
      if (typeof this.ensureTowerPgDmChannel !== 'function') {
        this.error = 'Agent DMs are not available in this workspace view.';
        return;
      }
      try {
        const channel = await this.ensureTowerPgDmChannel(targetNpub);
        if (channel?.record_id) {
          this.channels = [...(this.channels || []).filter((item) => item.record_id !== channel.record_id), channel];
          await this.selectChannel?.(channel.record_id, { syncRoute: false });
          this.scheduleChannelsRefresh?.('PG bot DM open');
        }
      } catch (error) {
        this.error = error?.message || 'Failed to open agent DM';
      }
      return;
    }

    try {
      const existing = findExistingDmChannel(this.channels, [memberNpub, targetNpub]);
      if (existing?.record_id) {
        await this.selectChannel(existing.record_id, { syncRoute: false });
        return;
      }
      const dmScopeId = this.dmScopeId || DM_SCOPE_ID;
      const dmDescription = buildDmChannelDescription([memberNpub, targetNpub]);
      const targetLabel = this.getSenderName?.(targetNpub) || 'bot';
      const name = `DM: ${memberNpub.slice(0, 12)}… + ${targetLabel}`;
      const group = await this.createEncryptedGroup(name, [targetNpub]);
      const groupId = group.group_id;
      await this.rememberPeople([memberNpub, targetNpub], 'chat');

      const channelId = crypto.randomUUID();
      const channelRow = {
        record_id: channelId,
        owner_npub: ownerNpub,
        title: name,
        description: dmDescription,
        group_ids: [groupId],
        participant_npubs: [memberNpub, targetNpub],
        channel_type: 'dm',
        scope_id: dmScopeId,
        scope_l1_id: dmScopeId,
        record_state: 'active',
        version: 1,
        updated_at: new Date().toISOString(),
      };

      await upsertChannel(channelRow);

      const envelope = await outboundChannel({
        record_id: channelId,
        owner_npub: ownerNpub,
        title: name,
        description: dmDescription,
        group_ids: [groupId],
        participant_npubs: [memberNpub, targetNpub],
        channel_type: 'dm',
        scope_id: dmScopeId,
        scope_l1_id: dmScopeId,
        record_state: 'active',
        signature_npub: this.signingNpub,
        write_group_ref: groupId,
      });

      await queueTowerPendingWrite(this, {
        record_id: channelId,
        record_family_hash: recordFamilyHash('channel'),
        envelope,
      });

      await this.flushAndBackgroundSync();
      await this.selectChannel(channelId, { syncRoute: false });
    } catch (e) {
      this.error = e.message;
    }
  },

  async deleteSelectedChannel() {
    this.error = null;
    const settingsChannelId = String(this.channelSettingsChannelId || this.selectedChannelId || '').trim();
    const channel = this.channels.find((candidate) => String(candidate?.record_id || '').trim() === settingsChannelId) ?? null;
    if (!channel) {
      const message = settingsChannelId
        ? 'This channel is no longer available. Close settings and select it again.'
        : 'Select a channel first';
      this.channelSettingsError = message;
      this.error = message;
      return;
    }
    if (isTowerPgBackendMode()) {
      if (!this.canManageChannel(channel)) {
        this.channelSettingsError = 'You need Manage access to delete this channel.';
        return;
      }
      if (this.channelRenameSaving) return;
      if (!this.channelDeleteConfirmArmed) {
        const { workspaceId } = resolveTowerPgWorkspaceContext(this);
        this.channelSettingsChannelId = settingsChannelId;
        this.channelSettingsWorkspaceId = String(workspaceId || '').trim();
        this.channelSettingsError = '';
        this.channelDeleteConfirmArmed = true;
        return;
      }
      if (this.channelDeleteSubmitting) return;
      this.channelDeleteSubmitting = true;
      this.channelSettingsError = '';
      const completePgChannelDelete = async () => {
        const fallbackNextChannelId = this.channels.find((item) => item.record_id !== channel.record_id)?.record_id ?? null;
        await deleteChannelRuntimeState(channel.record_id);
        this.channels = this.channels.filter((item) => item.record_id !== channel.record_id);
        this.selectedChannelId = fallbackNextChannelId;
        this.closeThread();
        this.selectedChannelId = this.selectedChannelId ?? this.channels[0]?.record_id ?? null;
        Promise.resolve()
          .then(() => this.refreshMessages({ scrollToLatest: true }))
          .catch((refreshError) => {
            console.warn('[flightdeck] PG message refresh failed after channel delete', refreshError);
          });
        this.showChannelSettingsModal = false;
        this.channelDeleteConfirmArmed = false;
        this.channelSettingsChannelId = '';
        this.channelSettingsWorkspaceId = '';
        this.openAllScopesOverview?.();
        this.syncRoute?.();
      };
      try {
        const { workspaceId, baseUrl, appNpub } = resolveTowerPgWorkspaceContext(this);
        if (!workspaceId || !baseUrl) throw new Error('Flight Deck PG workspace is not connected');
        const settingsWorkspaceId = String(this.channelSettingsWorkspaceId || '').trim();
        const channelWorkspaceId = String(channel.pg_workspace_id || '').trim();
        if (settingsWorkspaceId && settingsWorkspaceId !== workspaceId) {
          throw new Error('The workspace changed after channel settings opened. Close settings and select the channel again.');
        }
        if (channelWorkspaceId && channelWorkspaceId !== workspaceId) {
          throw new Error('This channel belongs to a different workspace. Close settings and select the current workspace channel again.');
        }
        await deleteTowerPgChannel(this, workspaceId, channel.record_id, { baseUrl, appNpub });
        await completePgChannelDelete();
      } catch (error) {
        const rawMessage = error?.message || 'Failed to delete channel';
        if (/"code"\s*:\s*"resource-not-found"|\bresource-not-found\b/i.test(rawMessage)
          && typeof this.refreshChannels === 'function') {
          try {
            await this.refreshChannels();
            const targetStillVisible = this.channels.some((item) => item.record_id === channel.record_id);
            if (!targetStillVisible) {
              await completePgChannelDelete();
              return;
            }
          } catch {
            // Keep the original delete failure visible and retryable.
          }
        }
        const message = /"code"\s*:\s*"resource-not-found"|\bresource-not-found\b/i.test(rawMessage)
          ? 'Tower could not find this channel in the current workspace. Refresh the workspace, then retry or close settings and select the channel again.'
          : rawMessage;
        this.channelSettingsError = message;
        this.error = message;
      } finally {
        this.channelDeleteSubmitting = false;
      }
      return;
    }

    if (!this.channelDeleteConfirmArmed) {
      this.channelDeleteConfirmArmed = true;
      return;
    }

    try {
      const now = new Date().toISOString();
      const fallbackNextChannelId = this.channels.find((item) => item.record_id !== channel.record_id)?.record_id ?? null;
      const ownerNpub = channel.owner_npub || this.workspaceOwnerNpub;
      let latestTowerVersion = 0;
      this.showChannelSettingsModal = false;

      if (channel.record_id && ownerNpub && this.workspaceOwnerNpub && this.session?.npub && this.backendUrl) {
        const result = await fetchRecordHistory({
          record_id: channel.record_id,
          owner_npub: this.workspaceOwnerNpub,
          viewer_npub: this.session.npub,
        });
        latestTowerVersion = (Array.isArray(result?.versions) ? result.versions : []).reduce((latest, current) => {
          const version = Number(current?.version ?? 0) || 0;
          return version > latest ? version : latest;
        }, 0);
      }

      if (latestTowerVersion > 0) {
        const nextVersion = latestTowerVersion + 1;
        await upsertChannel({
          ...channel,
          record_state: 'deleted',
          version: nextVersion,
          updated_at: now,
        });

        const channelWriteFields = await getRecordWriteFieldsForStore(this, channel, {
          label: 'Channel write',
        });
        const envelope = await outboundChannel({
          record_id: channel.record_id,
          owner_npub: ownerNpub,
          title: channel.title,
          group_ids: channelWriteFields.group_ids,
          participant_npubs: channel.participant_npubs ?? [],
          version: nextVersion,
          previous_version: latestTowerVersion,
          record_state: 'deleted',
          signature_npub: this.signingNpub,
          write_group_ref: channelWriteFields.write_group_ref,
        });

        await queueTowerPendingWrite(this, {
          record_id: channel.record_id,
          record_family_hash: recordFamilyHash('channel'),
          envelope,
        });
      } else {
        await deleteChannelRuntimeState(channel.record_id);
      }

      this.channels = this.channels.filter((item) => item.record_id !== channel.record_id);
      this.selectedChannelId = fallbackNextChannelId;
      this.closeThread();
      await this.refreshMessages({ scrollToLatest: true });

      if (latestTowerVersion > 0) {
        await this.flushAndBackgroundSync();
      }
      await this.refreshChannels();
      this.selectedChannelId = this.selectedChannelId ?? this.channels[0]?.record_id ?? null;
      await this.refreshMessages({ scrollToLatest: true });
      this.channelDeleteConfirmArmed = false;
    } catch (error) {
      this.channelDeleteConfirmArmed = false;
      this.error = error?.message || 'Failed to delete channel';
    }
  },

  async sendMessage(options = {}) {
    const composer = options?.composerContext === 'thread-create' ? 'thread' : 'message';
    if (this.composerSendPending?.[composer]) return false;
    this.commitMentionComposerDraft?.(composer);
    setComposerSendPending(this, composer, true);
    try {
      return await this.sendMessageAttempt(options);
    } finally {
      setComposerSendPending(this, composer, false);
    }
  },

  async sendMessageAttempt(options = {}) {
    if (!options?.body && this.messageEdit?.recordId && this.messageEdit.context === 'message') {
      return this.saveMessageEdit();
    }
    this.error = null;
    const pgMode = isTowerPgBackendMode();
    const isThreadCreate = options?.composerContext === 'thread-create';
    const composer = isThreadCreate ? 'thread' : 'message';
    const input = String(isThreadCreate ? this.threadInput : this.messageInput || '');
    const audioDraftSource = isThreadCreate ? this.threadAudioDrafts : this.messageAudioDrafts;
    const fileDraftSource = isThreadCreate ? this.threadFileDrafts : this.messageFileDrafts;
    const imageUploadCount = isThreadCreate ? this.threadImageUploadCount : this.messageImageUploadCount;
    const retrySourceMessage = options?.retrySourceMessage || null;
    const hasBodyOverride = typeof options?.body === 'string';
    const bodyOverride = typeof options?.body === 'string' ? options.body.trim() : '';
    const drafts = hasBodyOverride ? [] : [...(audioDraftSource || [])];
    const fileDrafts = hasBodyOverride ? [] : [...(fileDraftSource || [])];
    if (fileDrafts.some((draft) => draft.status !== 'ready')) {
      this.error = 'Wait for attachments to finish uploading or remove failed attachments.';
      return;
    }
    if (!hasBodyOverride && (imageUploadCount > 0 || this.containsInlineImageUploadToken(input))) {
      this.error = 'Wait for image upload to finish.';
      return;
    }
    if (!input.trim() && !hasBodyOverride && drafts.length === 0 && fileDrafts.length === 0) return false;
    if (pgMode && !this.canComposeInChatDestination) {
      this.error = this.chatComposerDisabledReason;
      return false;
    }
    if (!this.selectedChannelId) {
      if (pgMode) {
        return this.openWriteContextModal?.('message', { options: {} }) || null;
      }
      this.error = 'Select a channel first';
      return;
    }
    const channel = retrySourceMessage
      ? (this.channels || []).find(row => row.record_id === retrySourceMessage.channel_id)
      : this.selectedChannel;
    if (!channel) {
      this.error = 'Channel not found';
      return;
    }

    const msgId = String(options?.clientRequestId || '').trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    const body = hasBodyOverride ? bodyOverride : input.trim();
    const retryMentions = retrySourceMessage?.pg_metadata?.mentions || retrySourceMessage?.metadata?.mentions;
    const candidateMentions = retrySourceMessage
      ? (Array.isArray(retryMentions) ? retryMentions : [])
      : canonicalAgentMentionsFromSelection(body, this.selectedAgentMentionsByComposer?.[composer]);
    const canonicalMentions = pgMode
      ? filterMentionsToCurrentWorkspaceActors(candidateMentions, this.pgWorkspaceMembers, [
          this.currentPgActorNpub,
          this.session?.npub,
          this.workspaceOwnerNpub,
        ])
      : candidateMentions;
    if (pgMode && canonicalMentions.length !== candidateMentions.length) {
      this.error = 'A selected mention is no longer a current workspace member. Remove it and select the current identity.';
      return false;
    }
    let channelWriteFields = null;
    let attachments = retrySourceMessage
      ? [...(Array.isArray(retrySourceMessage.attachments) ? retrySourceMessage.attachments : [])]
      : mergeChatStorageAttachments(
        body,
        fileDrafts.map(({ file, error, status, draft_id, preview_url, storage_upload, upload_inflight, ...attachment }) => attachment),
      );
    if (!pgMode) {
      channelWriteFields = await getRecordWriteFieldsForStore(this, channel, {
        label: 'Chat message write',
      });
      const audioResult = await this.materializeAudioDrafts({
        drafts,
        target_record_id: msgId,
        target_record_family_hash: recordFamilyHash('chat_message'),
        target_group_ids: channelWriteFields.group_ids,
        write_group_ref: channelWriteFields.write_group_ref,
      });
      attachments = [...attachments, ...audioResult.attachments];
    }
    const localRow = {
      record_id: msgId,
      channel_id: channel.record_id,
      parent_message_id: null,
      body,
      attachments,
      sender_npub: this.session?.npub,
      sync_status: 'pending',
      record_state: 'active',
      version: 1,
      updated_at: now,
      ...(pgMode ? { pg_backend: true } : {}),
      ...(pgMode ? {
        pg_workspace_id: this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id || this.currentWorkspaceKey || null,
        pg_scope_id: channel.scope_id || channel.scope_l1_id || this.pgContextScopeId || this.pgContextScope?.record_id || null,
        pg_thread_id: null,
        pg_client_request_id: msgId,
      } : {}),
      ...(pgMode && (isThreadCreate || retrySourceMessage?.pg_thread_title) ? {
        pg_thread_title: String(options.threadTitle || retrySourceMessage?.pg_thread_title || '').trim() || undefined,
      } : {}),
      ...(pgMode && canonicalMentions.length > 0 ? { pg_metadata: { mentions: canonicalMentions } } : {}),
    };

    if (pgMode && retrySourceMessage?.pg_metadata) localRow.pg_metadata = { ...retrySourceMessage.pg_metadata };
    const replacedRecordId = String(options?.replaceRecordId || '').trim();
    if (replacedRecordId) await replaceMessageRecord(replacedRecordId, localRow);
    else await upsertMessage(localRow);
    if (replacedRecordId && replacedRecordId !== localRow.record_id) {
      this.messages = this.messages.filter((message) => message.record_id !== replacedRecordId);
    }
    this.patchMessageLocal(localRow);
    this.scheduleChatFeedScrollToBottom();
    const clearComposer = () => {
      if (hasBodyOverride) return;
      if (isThreadCreate) this.threadInput = '';
      else this.messageInput = '';
      this.selectedAgentMentionsByComposer = {
        ...(this.selectedAgentMentionsByComposer || {}),
        [composer]: [],
      };
      if (isThreadCreate) this.threadAudioDrafts = [];
      else this.messageAudioDrafts = [];
      if (typeof this.clearChatFileDrafts === 'function') this.clearChatFileDrafts(composer);
      else if (isThreadCreate) this.threadFileDrafts = [];
      else this.messageFileDrafts = [];
      this.scheduleComposerAutosize(composer, { resetManualSize: true });
      this.clearCurrentChatComposerDraft(composer);
    };
    if (!isThreadCreate || !pgMode) clearComposer();

    if (pgMode) {
      let accepted = null;
      try {
        accepted = {
          ...localRow,
          ...await createTowerPgMessageWithLazyDmRepair(this, localRow, channel),
          pg_client_record_id: localRow.record_id,
          pg_reconciliation_pending: true,
        };
        await replaceMessageRecord(localRow.record_id, accepted);
        accepted = await getMessageById(accepted.record_id) || accepted;
        this.messages = this.messages.filter((message) => message.record_id !== localRow.record_id);
        this.patchMessageLocal(accepted);
        if (drafts.length > 0) {
          try {
            const { attachments: pgAudioAttachments } = await this.materializeAudioDrafts({
              drafts,
              target_record_id: accepted.record_id,
              target_record_family_hash: recordFamilyHash('chat_message'),
              scopeId: accepted.pg_scope_id,
              channelId: accepted.channel_id,
              threadId: accepted.pg_thread_id,
            });
            if (pgAudioAttachments.length > 0) {
              const existingAttachments = Array.isArray(accepted.attachments) ? accepted.attachments : [];
              const acceptedWithAudio = {
                ...accepted,
                attachments: [...existingAttachments, ...pgAudioAttachments],
              };
              await upsertMessage(acceptedWithAudio);
              this.messages = this.messages.filter((message) => message.record_id !== accepted.record_id);
              this.patchMessageLocal(acceptedWithAudio);
              accepted = acceptedWithAudio;
            }
          } catch (audioError) {
            if (isThreadCreate) this.threadAudioDrafts = drafts;
            else this.messageAudioDrafts = drafts;
            this.error = `Message sent, but failed to attach voice note: ${audioError?.message || 'Failed to sync PG audio note'}`;
          }
        }
        if (isThreadCreate) clearComposer();
        this.scheduleChatFeedScrollToBottom();
        Promise.resolve()
          .then(() => this.refreshMessages({ scrollToLatest: true }))
          .catch((refreshError) => {
            console.warn('[flightdeck] PG message refresh failed after send', refreshError);
          });
      } catch (error) {
        if (isThreadCreate) {
          await deleteMessageRuntimeState(msgId);
          this.messages = this.messages.filter((message) => message.record_id !== msgId);
          this.syncChatPreviewState?.();
        } else {
          await this.setMessageSyncStatus(msgId, 'failed');
        }
        this.markTowerReachabilityOperationFailed?.('chat-message-send-failed');
        this.error = error?.message || 'Failed to sync PG message';
        return false;
      }
      return options.returnMessage === true ? accepted : true;
    }

    try {
      const envelope = await outboundChatMessage({
        record_id: msgId,
        owner_npub: channel.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
        channel_id: this.selectedChannelId,
        parent_message_id: null,
        body,
        attachments,
        channel_group_ids: channelWriteFields.group_ids,
        write_group_ref: channelWriteFields.write_group_ref,
        signature_npub: this.signingNpub,
      });

      await queueTowerPendingWrite(this, {
        record_id: msgId,
        record_family_hash: recordFamilyHash('chat_message'),
        envelope,
      });

      await this.flushAndBackgroundSync();
    } catch (error) {
      await this.setMessageSyncStatus(msgId, 'failed');
      this.error = error?.message || 'Failed to sync message';
      return false;
    }
    return options.returnMessage === true ? localRow : true;
  },

  async sendThreadReply(options = {}) {
    if (this.composerSendPending?.thread) return false;
    this.commitMentionComposerDraft?.('thread');
    setComposerSendPending(this, 'thread', true);
    try {
      return await this.sendThreadReplyAttempt(options);
    } finally {
      setComposerSendPending(this, 'thread', false);
    }
  },

  async sendThreadReplyAttempt(options = {}) {
    if (!options?.body && this.messageEdit?.recordId && this.messageEdit.context === 'thread') {
      return this.saveMessageEdit();
    }
    this.error = null;
    const pgMode = isTowerPgBackendMode();
    const retrySourceMessage = options?.retrySourceMessage || null;
    const hasBodyOverride = typeof options?.body === 'string';
    const bodyOverride = typeof options?.body === 'string' ? options.body.trim() : '';
    const drafts = hasBodyOverride ? [] : [...this.threadAudioDrafts];
    const fileDrafts = hasBodyOverride ? [] : [...(this.threadFileDrafts || [])];
    if (fileDrafts.some((draft) => draft.status !== 'ready')) {
      this.error = 'Wait for attachments to finish uploading or remove failed attachments.';
      return;
    }
    if (!hasBodyOverride && (this.threadImageUploadCount > 0 || this.containsInlineImageUploadToken(this.threadInput))) {
      this.error = 'Wait for image upload to finish.';
      return;
    }
    if (!this.threadInput.trim() && !hasBodyOverride && drafts.length === 0 && fileDrafts.length === 0) return false;
    const threadChannelId = retrySourceMessage?.channel_id || this.activeThreadChannelId;
    if ((!retrySourceMessage?.parent_message_id && !this.activeThreadId) || !threadChannelId) {
      this.error = 'Open a thread first';
      return;
    }
    const channel = retrySourceMessage
      ? (this.channels || []).find(row => row.record_id === threadChannelId)
      : this.activeThreadChannel;
    if (!channel) {
      this.error = 'Channel not found';
      return;
    }

    const msgId = String(options?.clientRequestId || '').trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    const body = hasBodyOverride ? bodyOverride : this.threadInput.trim();
    const retryMentions = retrySourceMessage?.pg_metadata?.mentions || retrySourceMessage?.metadata?.mentions;
    const candidateMentions = retrySourceMessage
      ? (Array.isArray(retryMentions) ? retryMentions : [])
      : canonicalAgentMentionsFromSelection(body, this.selectedAgentMentionsByComposer?.thread);
    const canonicalMentions = pgMode
      ? filterMentionsToCurrentWorkspaceActors(candidateMentions, this.pgWorkspaceMembers, [
          this.currentPgActorNpub,
          this.session?.npub,
          this.workspaceOwnerNpub,
        ])
      : candidateMentions;
    if (pgMode && canonicalMentions.length !== candidateMentions.length) {
      this.error = 'A selected mention is no longer a current workspace member. Remove it and select the current identity.';
      return false;
    }
    const branchAgentDirectRecipientNpub = canonicalMentions.length === 0
      ? String(this.getActiveThreadRecord?.()?.pg_metadata?.inherited_agent_recipient_npub || '').trim()
      : '';
    let pgParentMessage = null;
    let pgParentThreadId = null;
    if (pgMode) {
      pgParentMessage = retrySourceMessage
        ? { record_id: retrySourceMessage.parent_message_id, pg_thread_id: retrySourceMessage.pg_thread_id }
        : this.getThreadParentMessage();
      pgParentThreadId = pgParentMessage?.pg_thread_id || pgParentMessage?.thread_id || null;
      if (!pgParentMessage?.record_id || !pgParentThreadId) {
        this.error = 'Thread is still loading. Try again in a moment.';
        return;
      }
    }

    const sendThreadId = retrySourceMessage?.parent_message_id || this.activeThreadId;
    const sendWorkspace = this.currentWorkspaceKey;
    const sendDbKey = getCurrentWorkspaceDbKey();
    const persistReply = operation => withWorkspaceMessageTransaction(sendDbKey, operation);
    const sendBackendUrl = this.backendUrl;
    const sendWorkspaceId = this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id;
    const sendGeneration = this.autopilotOverviewThreadOpenRequestId;
    const sendSelection = this.channelSelectionGeneration;
    const isSendWorkspaceCurrent = () => this.currentWorkspaceKey === sendWorkspace
      && this.backendUrl === sendBackendUrl
      && (this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id) === sendWorkspaceId;
    const isSendCurrent = () => isSendWorkspaceCurrent() && this.activeThreadId === sendThreadId
      && this.activeThreadChannelId === threadChannelId
      && this.currentWorkspaceKey === sendWorkspace
      && (this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id) === sendWorkspaceId
      && this.autopilotOverviewThreadOpenRequestId === sendGeneration
      && this.channelSelectionGeneration === sendSelection;
    const patchReply = (row, replacedId) => {
      if (!isSendCurrent()) return;
      if (replacedId) this.messages = this.messages.filter(message => message.record_id !== replacedId);
      this.patchMessageLocal(row);
    };
    let channelWriteFields = null;
    let attachments = retrySourceMessage
      ? [...(Array.isArray(retrySourceMessage.attachments) ? retrySourceMessage.attachments : [])]
      : mergeChatStorageAttachments(
        body,
        fileDrafts.map(({ file, error, status, draft_id, preview_url, storage_upload, upload_inflight, ...attachment }) => attachment),
      );
    if (!pgMode) {
      channelWriteFields = await getRecordWriteFieldsForStore(this, channel, {
        label: 'Chat reply write',
      });
      const audioResult = await this.materializeAudioDrafts({
        drafts,
        target_record_id: msgId,
        target_record_family_hash: recordFamilyHash('chat_message'),
        target_group_ids: channelWriteFields.group_ids,
        write_group_ref: channelWriteFields.write_group_ref,
      });
      attachments = [...attachments, ...audioResult.attachments];
    }
    const localRow = {
      record_id: msgId,
      channel_id: threadChannelId,
      parent_message_id: sendThreadId,
      body,
      attachments,
      sender_npub: this.session?.npub,
      sync_status: 'pending',
      record_state: 'active',
      version: 1,
      updated_at: now,
      ...(pgMode ? { pg_backend: true } : {}),
      ...(pgMode ? {
        pg_workspace_id: this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id || this.currentWorkspaceKey || null,
        pg_scope_id: channel.scope_id || channel.scope_l1_id || this.pgContextScopeId || this.pgContextScope?.record_id || null,
        pg_client_request_id: msgId,
      } : {}),
      ...(pgMode && (canonicalMentions.length > 0 || branchAgentDirectRecipientNpub) ? {
        pg_metadata: canonicalMentions.length > 0
          ? { mentions: canonicalMentions }
          : { agent_direct_recipient_npub: branchAgentDirectRecipientNpub },
      } : {}),
      ...(pgParentThreadId ? { pg_thread_id: pgParentThreadId } : {}),
    };
    if (pgMode && retrySourceMessage?.pg_metadata) localRow.pg_metadata = { ...retrySourceMessage.pg_metadata };
    const replacedRecordId = String(options?.replaceRecordId || '').trim();
    await persistReply(() => replacedRecordId
      ? replaceMessageRecord(replacedRecordId, localRow) : upsertMessage(localRow));
    patchReply(localRow, replacedRecordId);
    if (isSendCurrent()) this.scheduleThreadRepliesScrollToBottom();
    if (!hasBodyOverride && isSendCurrent()) {
      this.threadInput = '';
      this.selectedAgentMentionsByComposer = {
        ...(this.selectedAgentMentionsByComposer || {}),
        thread: [],
      };
      this.threadAudioDrafts = [];
      if (typeof this.clearChatFileDrafts === 'function') this.clearChatFileDrafts('thread');
      else this.threadFileDrafts = [];
      this.scheduleComposerAutosize('thread', { resetManualSize: true });
      this.clearCurrentChatComposerDraft('thread');
    }

    if (pgMode) {
      try {
        if (!isSendWorkspaceCurrent()) throw new Error('Workspace changed before reply could be sent');
        const parentMessage = pgParentMessage || this.getThreadParentMessage();
        let accepted = {
          ...localRow,
          ...await createTowerPgMessageWithLazyDmRepair(this, localRow, channel, { parentMessage }),
          pg_client_record_id: localRow.record_id,
          pg_reconciliation_pending: true,
        };
        accepted = await persistReply(async () => {
          await replaceMessageRecord(localRow.record_id, accepted);
          return await getMessageById(accepted.record_id) || accepted;
        });
        patchReply(accepted, localRow.record_id);
        if (isSendCurrent()) this.armThreadActivityAutoScroll(accepted);
        if (drafts.length > 0 && isSendWorkspaceCurrent()) {
          try {
            const { attachments: pgAudioAttachments } = await this.materializeAudioDrafts({
              drafts,
              target_record_id: accepted.record_id,
              target_record_family_hash: recordFamilyHash('chat_message'),
              scopeId: accepted.pg_scope_id,
              channelId: accepted.channel_id,
              threadId: accepted.pg_thread_id,
            });
            if (pgAudioAttachments.length > 0) {
              const existingAttachments = Array.isArray(accepted.attachments) ? accepted.attachments : [];
              const acceptedWithAudio = {
                ...accepted,
                attachments: [...existingAttachments, ...pgAudioAttachments],
              };
              await persistReply(() => upsertMessage(acceptedWithAudio));
              patchReply(acceptedWithAudio, accepted.record_id);
            }
          } catch (audioError) {
            if (!isSendCurrent()) return true;
            this.threadAudioDrafts = drafts;
            this.error = `Reply sent, but failed to attach voice note: ${audioError?.message || 'Failed to sync PG audio note'}`;
          }
        }
        if (isSendCurrent()) this.scheduleThreadRepliesScrollToBottom();
        if (isSendCurrent() && !(this.navSection === 'status' && this.deckThreadChannelId)) {
          Promise.resolve()
            .then(() => isSendCurrent() && this.refreshMessages({ scrollThreadToLatest: true }))
            .catch((refreshError) => {
              console.warn('[flightdeck] PG reply refresh failed after send', refreshError);
            });
        }
      } catch (error) {
        const failed = await persistReply(() => updateExistingMessageSyncStatus(msgId, 'failed'));
        if (failed) patchReply(failed);
        this.markTowerReachabilityOperationFailed?.('chat-reply-send-failed');
        if (isSendCurrent()) this.error = error?.message || 'Failed to sync PG reply';
        return false;
      }
      return true;
    }

    try {
      const envelope = await outboundChatMessage({
        record_id: msgId,
        owner_npub: channel.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
        channel_id: threadChannelId,
        parent_message_id: sendThreadId,
        body,
        attachments,
        channel_group_ids: channelWriteFields.group_ids,
        write_group_ref: channelWriteFields.write_group_ref,
        signature_npub: this.signingNpub,
      });

      await queueTowerPendingWrite(this, {
        record_id: msgId,
        record_family_hash: recordFamilyHash('chat_message'),
        envelope,
      });

      await this.flushAndBackgroundSync();
    } catch (error) {
      await this.setMessageSyncStatus(msgId, 'failed');
      this.error = error?.message || 'Failed to sync reply';
      return false;
    }
    return true;
  },

  isHangCallInvitation(message) {
    return Boolean(parseHangCallInvitation(message?.body));
  },

  standaloneChatFileAttachments(message) {
    return standaloneChatFileAttachments(message);
  },

  hangCallInvitationCard(message) {
    return parseHangCallInvitation(message?.body) || { roomUrl: '' };
  },

  async startChannelHangCall(roomUrl = '') {
    if (this.channelHangCallSending) return false;
    if (!this.selectedChannelId) {
      this.channelHangCallError = 'Select a channel before starting a Hang call.';
      return false;
    }
    this.channelHangCallSending = true;
    this.channelHangCallError = '';
    try {
      const targetUrl = roomUrl || createHangRoomUrl();
      this.channelHangCallRetryUrl = targetUrl;
      const sent = await this.sendMessage({ body: buildHangCallInvitation(targetUrl) });
      if (!sent) {
        this.channelHangCallError = this.error || 'The Hang invitation could not be posted. Try again.';
        return false;
      }
      this.channelHangCallRetryUrl = '';
      return true;
    } catch (error) {
      this.channelHangCallError = error?.message || 'The Hang invitation could not be created. Try again.';
      return false;
    } finally {
      this.channelHangCallSending = false;
    }
  },

  retryChannelHangCall() {
    return this.startChannelHangCall(this.channelHangCallRetryUrl);
  },

  async startThreadHangCall(roomUrl = '') {
    if (this.threadHangCallSending) return false;
    if (!this.activeThreadId || !this.selectedChannelId) {
      this.threadHangCallError = 'Open a thread before starting a Hang call.';
      return false;
    }
    this.threadHangCallSending = true;
    this.threadHangCallError = '';
    try {
      const targetUrl = roomUrl || createHangRoomUrl();
      this.threadHangCallRetryUrl = targetUrl;
      const sent = await this.sendThreadReply({ body: buildHangCallInvitation(targetUrl) });
      if (!sent) {
        this.threadHangCallError = this.error || 'The Hang invitation could not be posted. Try again.';
        return false;
      }
      this.threadHangCallRetryUrl = '';
      return true;
    } catch (error) {
      this.threadHangCallError = error?.message || 'The Hang invitation could not be created. Try again.';
      return false;
    } finally {
      this.threadHangCallSending = false;
    }
  },

  retryThreadHangCall() {
    return this.startThreadHangCall(this.threadHangCallRetryUrl);
  },

  // --- message actions menu ---

  canEditMessage(message) {
    const senderNpub = String(message?.sender_npub || message?.pg_created_by_actor_npub || '').trim();
    const viewerNpub = String(this.session?.npub || '').trim();
    return Boolean(
      isTowerPgBackendMode()
      && message?.pg_backend === true
      && message?.read_only !== true
      && message?.record_state !== 'deleted'
      && message?.sync_status === 'synced'
      && senderNpub
      && viewerNpub
      && senderNpub === viewerNpub
    );
  },

  canResendMessage(message) {
    const recordId = String(message?.record_id || '').trim();
    const senderNpub = String(message?.sender_npub || '').trim();
    const viewerNpub = String(this.session?.npub || '').trim();
    return Boolean(
      isTowerPgBackendMode()
      && message?.pg_backend === true
      && message?.read_only !== true
      && message?.record_state !== 'deleted'
      && message?.sync_status === 'failed'
      && recordId
      && String(message?.pg_client_request_id || '').trim() === recordId
      && !message?.pg_record_type
      && senderNpub
      && viewerNpub
      && senderNpub === viewerNpub
      && !this.isMessageResendPending(recordId)
    );
  },

  isMessageResendPending(recordId) {
    return (this.messageResendPendingIds || []).includes(String(recordId || '').trim());
  },

  async resendFailedMessage(recordId) {
    const message = this.getChatMessageById(recordId) || await getMessageById(recordId);
    if (!this.canResendMessage(message)) return false;
    const normalizedId = String(recordId).trim();
    this.messageResendPendingIds = [...(this.messageResendPendingIds || []), normalizedId];
    this.closeMessageActionsMenu();
    try {
      // A failed transport can mean Tower committed but its response was lost.
      // Reuse the exact command identity, routing, body and attachment IDs.
      const options = {
        body: message.body,
        clientRequestId: message.pg_client_request_id,
        retrySourceMessage: message,
        replaceRecordId: normalizedId,
        threadTitle: message.pg_thread_title,
      };
      return message.parent_message_id
        ? await this.sendThreadReply(options)
        : await this.sendMessage(options);
    } finally {
      this.messageResendPendingIds = (this.messageResendPendingIds || [])
        .filter((id) => id !== normalizedId);
    }
  },

  async retryUnsyncedOutgoingMessages(options = {}) {
    if (!isTowerPgBackendMode() || this.offlineMessageResyncInFlight) return { attempted: 0, sent: 0, failed: 0 };
    const viewerNpub = String(this.session?.npub || '').trim();
    if (!viewerNpub) return { attempted: 0, sent: 0, failed: 0 };

    this.offlineMessageResyncInFlight = true;
    try {
      const db = getWorkspaceDb();
      const rows = await db.chat_messages
        .where('sync_status')
        .equals('failed')
        .toArray();
      const candidates = rows
        .filter((message) => this.canResendMessage(message))
        .sort((left, right) => String(left.updated_at || '').localeCompare(String(right.updated_at || '')));

      let sent = 0;
      let failed = 0;
      for (const message of candidates) {
        const recordId = String(message?.record_id || '').trim();
        if (!recordId || this.isMessageResendPending(recordId)) continue;
        const ok = await this.resendFailedMessage(recordId);
        if (ok) sent += 1;
        else failed += 1;
      }

      if (options.refresh !== false && (sent > 0 || failed > 0)) {
        await this.refreshMessages?.({ scrollToLatest: sent > 0 }).catch(() => {});
      }
      return { attempted: sent + failed, sent, failed };
    } finally {
      this.offlineMessageResyncInFlight = false;
    }
  },

  isEditingMessage(context = '') {
    if (!this.messageEdit?.recordId) return false;
    return !context || this.messageEdit.context === context;
  },

  startMessageEdit(recordId) {
    const message = this.getChatMessageById(recordId);
    if (!this.canEditMessage(message) || this.messageEdit?.submitting) return;
    if (this.messageEdit?.recordId) this.cancelMessageEdit();

    const context = 'thread';
    const modelKey = 'threadInput';
    const existingMentions = message?.pg_metadata?.mentions || message?.metadata?.mentions;
    const mentions = (Array.isArray(existingMentions) ? existingMentions : [])
      .filter((mention) => ['agent', 'person'].includes(mention?.type) && mention?.npub)
      .map((mention) => ({ type: mention.type, npub: mention.npub, label: mention.label || mention.npub }));

    const threadRootId = message.parent_message_id || message.record_id;
    if (this.activeThreadId !== threadRootId) {
      this.openThread(threadRootId, { preserveComposer: true });
    }
    this.messageEdit = {
      recordId: message.record_id,
      context,
      channelId: message.channel_id,
      threadRootId,
      originalBody: message.body || '',
      draftBeforeEdit: this[modelKey] || '',
      mentionsBeforeEdit: [...(this.selectedAgentMentionsByComposer?.[context] || [])],
      submitting: false,
      error: '',
    };
    this[modelKey] = message.body || '';
    this.selectedAgentMentionsByComposer = {
      ...(this.selectedAgentMentionsByComposer || {}),
      [context]: mentions,
    };
    this.closeMessageActionsMenu();
    this.scheduleComposerAutosize(context);
    scheduleUiNextTick(() => {
      const composer = typeof document !== 'undefined'
        ? document.querySelector(`[data-chat-composer="${context}"]`)
        : null;
      composer?.focus?.();
    });
  },

  cancelMessageEdit(options = {}) {
    const edit = this.messageEdit;
    if (!edit?.recordId || edit.submitting) return false;
    const restoreDraft = options.restoreDraft !== false;
    const modelKey = edit.context === 'thread' ? 'threadInput' : 'messageInput';
    if (restoreDraft) {
      this[modelKey] = edit.draftBeforeEdit || '';
      this.selectedAgentMentionsByComposer = {
        ...(this.selectedAgentMentionsByComposer || {}),
        [edit.context]: [...(edit.mentionsBeforeEdit || [])],
      };
    }
    this.messageEdit = {
      recordId: '', context: '', channelId: '', threadRootId: '', originalBody: '',
      draftBeforeEdit: '', mentionsBeforeEdit: [], submitting: false, error: '',
    };
    this.closeMentionPopover?.();
    this.scheduleComposerAutosize(edit.context);
    return true;
  },

  async saveMessageEdit() {
    const edit = this.messageEdit;
    if (!edit?.recordId || edit.submitting) return;
    const message = this.getChatMessageById(edit.recordId);
    if (!this.canEditMessage(message)) {
      this.messageEdit = { ...edit, error: 'This message can no longer be edited.' };
      return;
    }
    if (message.channel_id !== this.selectedChannelId
      || (edit.context === 'thread' && (message.parent_message_id || message.record_id) !== this.activeThreadId)) {
      this.messageEdit = { ...edit, error: 'The chat context changed. Cancel and reopen the message to edit it.' };
      return;
    }
    const modelKey = edit.context === 'thread' ? 'threadInput' : 'messageInput';
    const body = String(this[modelKey] || '').trim();
    if (!body) {
      this.messageEdit = { ...edit, error: 'A message cannot be empty.' };
      return;
    }
    const candidateMentions = canonicalAgentMentionsFromSelection(
      body,
      this.selectedAgentMentionsByComposer?.[edit.context],
    );
    const mentions = filterMentionsToCurrentWorkspaceActors(
      candidateMentions,
      this.pgWorkspaceMembers,
      [this.currentPgActorNpub, this.session?.npub, this.workspaceOwnerNpub],
    );
    if (mentions.length !== candidateMentions.length) {
      this.messageEdit = {
        ...edit,
        error: 'A selected mention is no longer a current workspace member. Remove it and select the current identity.',
      };
      return;
    }
    this.messageEdit = { ...edit, submitting: true, error: '' };
    this.error = null;
    await this.setMessageSyncStatus(message.record_id, 'pending');
    try {
      const accepted = await updateTowerPgMessageFromLocal(this, message, { body, mentions });
      await upsertMessage(accepted);
      this.patchMessageLocal(accepted);
      const draftBeforeEdit = edit.draftBeforeEdit || '';
      const mentionsBeforeEdit = [...(edit.mentionsBeforeEdit || [])];
      this.messageEdit = { ...this.messageEdit, submitting: false };
      this.cancelMessageEdit({ restoreDraft: false });
      this[modelKey] = draftBeforeEdit;
      this.selectedAgentMentionsByComposer = {
        ...(this.selectedAgentMentionsByComposer || {}),
        [edit.context]: mentionsBeforeEdit,
      };
      this.scheduleComposerAutosize(edit.context);
    } catch (error) {
      await this.setMessageSyncStatus(message.record_id, 'synced');
      const conflict = error?.status === 409 || error?.code === 'stale_row_version';
      this.messageEdit = {
        ...this.messageEdit,
        submitting: false,
        error: conflict
          ? 'This message changed elsewhere. Cancel, review the latest version, and try again.'
          : (error?.message || 'Failed to save message edit.'),
      };
      if (conflict) {
        Promise.resolve(this.refreshMessages?.()).catch(() => {});
      }
    }
  },

  isMessageEdited(message) {
    if (!message?.created_at || !message?.updated_at) return false;
    return Date.parse(message.updated_at) > Date.parse(message.created_at) + 1000;
  },

  openMessageActionsMenu(recordId) {
    this.messageActionsMenuId = recordId;
  },

  closeMessageActionsMenu() {
    this.messageActionsMenuId = null;
  },

  isMessageActionsMenuOpen(recordId) {
    return this.messageActionsMenuId === recordId;
  },

  toggleMessageActionsMenu(recordId) {
    if (this.messageActionsMenuId === recordId) {
      this.messageActionsMenuId = null;
    } else {
      this.messageActionsMenuId = recordId;
    }
  },

  isChatThreadArchived(recordId) {
    const message = this.getChatMessageById(recordId);
    return String(message?.record_state || 'active') === 'archived';
  },

  toggleShowArchivedChatThreads() {
    this.showArchivedChatThreads = !this.showArchivedChatThreads;
    this.scheduleChatPreviewMeasurement();
  },

  isChatThreadArchiveSubmitting(recordId, action = '') {
    const id = String(recordId || '').trim();
    if (!id || this.chatThreadArchiveSubmittingId !== id) return false;
    return !action || this.chatThreadArchiveSubmittingAction === action;
  },

  getChatMessageById(recordId) {
    const id = String(recordId || '').trim();
    if (!id) return null;
    return this.messages.find((message) => message.record_id === id) || null;
  },

  getAutopilotSessionId(message) {
    const metadata = message?.pg_metadata && typeof message.pg_metadata === 'object' && !Array.isArray(message.pg_metadata)
      ? message.pg_metadata
      : message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? message.metadata
        : {};
    if (String(metadata.source || '').trim() !== 'autopilot_session') return '';
    const sessionId = String(metadata.session_id || '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
      ? sessionId
      : '';
  },

  getAutopilotLiveSessionUrl(sessionId) {
    const id = String(sessionId || '').trim();
    const baseUrl = String(this.workspaceHarnessUrl || '').trim();
    if (!id || !baseUrl) return '';
    try {
      const parsedBaseUrl = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) return '';
      return new URL(`/live/${encodeURIComponent(id)}`, parsedBaseUrl).toString();
    } catch {
      return '';
    }
  },

  hasAutopilotSessionLink(message) {
    return Boolean(this.getAutopilotLiveSessionUrl(this.getAutopilotSessionId(message)));
  },

  openMessageAutopilotSession(message) {
    const sessionId = this.getAutopilotSessionId(message);
    const target = this.getAutopilotLiveSessionUrl(sessionId);
    if (!target || typeof window === 'undefined') return;
    window.open(target, '_blank', 'noopener,noreferrer');
    this.closeMessageActionsMenu();
  },

  getThreadAutopilotSessionId(message = null) {
    const contextMessage = message || this.getThreadParentMessage();
    const threadRootId = String(
      contextMessage?.parent_message_id
      || contextMessage?.record_id
      || this.activeThreadId
      || '',
    ).trim();
    if (!threadRootId) return '';

    const loadedMessages = Array.isArray(this.messages) ? this.messages : [];
    const candidates = loadedMessages.filter((candidate) => (
      String(candidate?.record_state || 'active') !== 'deleted'
      && (candidate?.record_id === threadRootId || candidate?.parent_message_id === threadRootId)
    ));
    if (contextMessage?.record_id && !candidates.some((candidate) => candidate.record_id === contextMessage.record_id)) {
      candidates.push(contextMessage);
    }

    const latestTrustedMessage = sortMessagesByUpdatedAt(candidates)
      .filter((candidate) => this.getAutopilotSessionId(candidate))
      .at(-1);
    return this.getAutopilotSessionId(latestTrustedMessage);
  },

  hasThreadAutopilotSessionLink(message = null) {
    return Boolean(this.getAutopilotLiveSessionUrl(this.getThreadAutopilotSessionId(message)));
  },

  openThreadAutopilotSession(message = null) {
    const target = this.getAutopilotLiveSessionUrl(this.getThreadAutopilotSessionId(message));
    if (!target || typeof window === 'undefined') return;
    window.open(target, '_blank', 'noopener,noreferrer');
    this.closeMessageActionsMenu();
    this.threadMenuOpen = false;
  },

  resolveFlightDeckReferenceLabel(type, recordId, fallback = '') {
    const linkType = normalizeRecordLinkType(type);
    const id = String(recordId || '').trim();
    const directLabel = String(fallback || '').trim();
    if (directLabel) return directLabel;
    if (!id) return 'Record';
    if (linkType === 'doc') {
      const doc = (this.documents || []).find((item) => item?.record_id === id);
      return doc?.title || this.docEditorTitle || 'Untitled document';
    }
    if (linkType === 'directory') {
      const directory = (this.directories || []).find((item) => item?.record_id === id);
      return directory?.title || 'Untitled folder';
    }
    if (linkType === 'task') {
      const task = (this.tasks || []).find((item) => item?.record_id === id);
      return task?.title || this.editingTask?.title || 'Untitled task';
    }
    if (linkType === 'scope') {
      const scope = this.scopesMap?.get?.(id) || (this.scopes || []).find((item) => item?.record_id === id);
      return scope?.title || 'Untitled scope';
    }
    if (linkType === 'channel') {
      const channel = (this.channels || []).find((item) => item?.record_id === id);
      return (channel && this.getChannelLabel?.(channel)) || channel?.title || channel?.name || 'Channel';
    }
    if (linkType === 'report') {
      const report = (this.reports || []).find((item) => item?.record_id === id)
        || (this.reportModalReport?.record_id === id ? this.reportModalReport : null)
        || (this.selectedReport?.record_id === id ? this.selectedReport : null);
      return report?.title || 'Untitled report';
    }
    if (linkType === 'flow') {
      const flow = (this.flows || []).find((item) => item?.record_id === id);
      return flow?.title || 'Untitled flow';
    }
    if (linkType === 'opportunity') {
      const opportunity = (this.opportunities || []).find((item) => item?.record_id === id);
      return opportunity?.title || 'Untitled opportunity';
    }
    if (linkType === 'person') return this.getSenderName?.(id) || id;
    if (linkType === 'chat') {
      const messageId = id.includes('#') ? id.slice(id.indexOf('#') + 1) : id;
      const message = this.getChatMessageById?.(messageId);
      const firstLine = String(message?.body || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (firstLine) return firstLine.slice(0, 80);
      const channelId = id.includes('#') ? id.slice(0, id.indexOf('#')) : message?.channel_id;
      const channel = (this.channels || []).find((item) => item?.record_id === channelId);
      const channelLabel = channel ? this.getChannelLabel?.(channel) || channel.title || channel.name : '';
      return channelLabel ? `${channelLabel} message` : 'Chat message';
    }
    return id.slice(0, 8);
  },

  buildFlightDeckReference(type, recordId, label = '') {
    return buildFlightDeckReference({
      type,
      id: recordId,
      label: this.resolveFlightDeckReferenceLabel(type, recordId, label),
    });
  },

  async copyFlightDeckReference(type, recordId, label = '') {
    this.error = null;
    this.threadMenuOpen = false;
    const reference = this.buildFlightDeckReference(type, recordId, label);
    if (!reference) {
      this.error = 'Could not build Flight Deck reference.';
      return;
    }
    try {
      await this.copyTextToClipboard(reference);
      const key = `${normalizeRecordLinkType(type)}:${String(recordId || '').trim()}`;
      this.copiedFlightDeckRefKey = key;
      if (typeof window !== 'undefined') {
        window.setTimeout(() => {
          if (this.copiedFlightDeckRefKey === key) this.copiedFlightDeckRefKey = null;
        }, 1800);
      }
    } catch (error) {
      this.error = error?.message || 'Failed to copy Flight Deck reference.';
    }
  },

  buildChatMessageFlightDeckReferenceId(recordId) {
    const message = this.getChatMessageById(recordId);
    const messageId = String(message?.record_id || recordId || '').trim();
    const channelId = String(message?.channel_id || this.selectedChannelId || '').trim();
    return channelId && messageId ? `${channelId}#${messageId}` : messageId;
  },

  async copyTextToClipboard(text) {
    const value = String(text ?? '');
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    if (typeof document === 'undefined') return;
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand?.('copy');
    textarea.remove();
  },

  async copyMessageRawText(recordId) {
    this.error = null;
    this.threadMenuOpen = false;
    const message = this.getChatMessageById(recordId);
    if (!message) {
      this.error = 'Message not found';
      return;
    }
    try {
      await this.copyTextToClipboard(message.body || '');
      this.closeMessageActionsMenu();
    } catch (error) {
      this.error = error?.message || 'Failed to copy message text.';
    }
  },

  buildThreadRawText(recordId) {
    const parent = this.getChatMessageById(recordId);
    if (!parent) return '';
    const messages = [parent, ...this.getThreadReplies(parent.record_id)]
      .filter((message) => String(message?.record_state || 'active') !== 'deleted');
    return messages.map((message) => {
      const sender = this.getSenderName?.(message.sender_npub) || message.sender_npub || 'Unknown';
      const timestamp = message.updated_at || message.created_at || '';
      const body = message.body || '';
      return `[${timestamp}] ${sender}\n${body}`;
    }).join('\n\n');
  },

  async copyThreadRawText(recordId) {
    this.error = null;
    const raw = this.buildThreadRawText(recordId);
    if (!raw) {
      this.error = 'Thread not found';
      return;
    }
    try {
      await this.copyTextToClipboard(raw);
      this.closeMessageActionsMenu();
    } catch (error) {
      this.error = error?.message || 'Failed to copy thread text.';
    }
  },

  openChatDeleteConfirm(mode, recordId) {
    const targetMode = mode === 'thread' ? 'thread' : 'message';
    this.threadMenuOpen = false;
    const message = this.getChatMessageById(recordId);
    if (!message) {
      this.error = targetMode === 'thread' ? 'Thread not found' : 'Message not found';
      return;
    }
    this.closeMessageActionsMenu();
    this.chatDeleteConfirm = {
      open: true,
      mode: targetMode,
      recordId: message.record_id,
      title: targetMode === 'thread' ? 'Delete Thread' : 'Delete Message',
      message: targetMode === 'thread'
        ? 'Delete this thread and all replies? This cannot be undone.'
        : 'Delete this message? This cannot be undone.',
      submitting: false,
      error: '',
    };
  },

  closeChatDeleteConfirm() {
    this.chatDeleteConfirm = {
      open: false,
      mode: '',
      recordId: '',
      title: '',
      message: '',
      submitting: false,
      error: '',
    };
  },

  async confirmChatDelete() {
    const state = this.chatDeleteConfirm || {};
    if (!state.open || !state.recordId) return;
    this.chatDeleteConfirm = { ...state, submitting: true, error: '' };
    try {
      if (state.mode === 'thread') {
        await this.deleteChatThreadByParentId(state.recordId);
      } else {
        await this.deleteChatMessageById(state.recordId);
      }
      this.closeChatDeleteConfirm();
    } catch (error) {
      this.chatDeleteConfirm = {
        ...this.chatDeleteConfirm,
        submitting: false,
        error: error?.message || 'Delete failed.',
      };
      this.error = this.chatDeleteConfirm.error;
    }
  },

  async openChatThreadFlowDispatch(recordId, sourceSurface = 'main_feed') {
    this.error = null;
    console.info('Chat thread flow dispatch requested:', {
      recordId,
      sourceSurface,
      selectedChannelId: this.selectedChannelId,
    });
    this.closeMessageActionsMenu();
    Object.assign(this, createChatThreadFlowDispatchState());
    this.showChatThreadFlowDispatchModal = true;
    this.chatThreadFlowDispatchOpenedAt = Date.now();
    this.chatThreadFlowDispatchLoading = true;

    try {
      const resolved = this.resolveDispatchThread(recordId);
      if (!resolved) {
        throw new Error('Unable to resolve the selected chat thread.');
      }
      const sourceChannel = resolved.sourceChannel || this.selectedChannel;
      if (!sourceChannel?.record_id) {
        throw new Error('Unable to resolve the source channel for this thread.');
      }

      this.chatThreadFlowDispatchSource = {
        channelId: sourceChannel.record_id,
        clickedMessageId: resolved.clickedMessage.record_id,
        threadRootMessageId: resolved.threadRootMessage.record_id,
        sourceSurface,
        dispatchedAt: new Date().toISOString(),
      };
      this.chatThreadFlowDispatchMessages = resolved.threadMessages;
      this.chatThreadFlowDispatchError = null;
      this.syncChatThreadFlowDispatchScopeResolution();
    } catch (error) {
      console.error('Chat thread flow dispatch init failed:', {
        error,
        recordId,
        sourceSurface,
        selectedChannelId: this.selectedChannelId,
      });
      this.chatThreadFlowDispatchError = error?.message || 'Unable to prepare chat thread dispatch.';
      this.error = this.chatThreadFlowDispatchError;
    } finally {
      this.chatThreadFlowDispatchLoading = false;
    }
  },

  resolveChatGetItDoneDefaultScope(resolved = null) {
    const channelScopeId = resolved?.sourceChannel?.scope_id
      || this.selectedChannel?.scope_id
      || null;
    if (channelScopeId) return channelScopeId;
    const selectedBoardId = String(this.selectedBoardId || '').trim();
    if (selectedBoardId && selectedBoardId !== UNSCOPED_TASK_BOARD_ID && selectedBoardId !== '__all__') {
      return selectedBoardId;
    }
    return null;
  },

  resolveChatGetItDoneDefaultAssignee(resolved = null) {
    const viewer = String(this.session?.npub || '').trim();
    const channel = resolved?.sourceChannel || this.selectedChannel || null;
    const participants = (Array.isArray(channel?.participant_npubs) ? channel.participant_npubs : [])
      .map((npub) => String(npub || '').trim())
      .filter(Boolean);
    const otherParticipants = participants.filter((npub) => npub !== viewer);
    if (otherParticipants.length === 1) return otherParticipants[0];

    const threadMessages = Array.isArray(resolved?.threadMessages) ? resolved.threadMessages : [];
    const latestOtherSender = [...threadMessages]
      .reverse()
      .map((message) => String(message?.sender_npub || '').trim())
      .find((npub) => npub && npub !== viewer);
    if (latestOtherSender) return latestOtherSender;

    return String(this.defaultAgentNpub || this.botNpub || '').trim() || null;
  },

  buildChatGetItDoneSourceUrl(source = this.chatGetItDoneSource) {
    if (!source?.channelId) return '';
    const currentRoute = typeof window !== 'undefined'
      ? parseRouteLocation(window.location.href)
      : { workspaceSlug: this.currentWorkspaceSlug || null, params: {} };
    return buildSectionUrl({
      workspaceSlug: this.currentWorkspaceSlug || currentRoute.workspaceSlug || null,
      section: 'chat',
      scopeid: this.selectedBoardId || null,
      params: {
        workspacekey: this.currentWorkspaceKey || currentRoute.params?.workspacekey || null,
        channelid: source.channelId,
        threadid: source.threadRootMessageId,
      },
    });
  },

  async openChatGetItDone(recordId, sourceSurface = 'main_feed') {
    this.error = null;
    this.threadMenuOpen = false;
    this.closeMessageActionsMenu();
    Object.assign(this, createChatGetItDoneState());
    this.showChatGetItDoneModal = true;
    this.chatGetItDoneOpenedAt = Date.now();

    try {
      const resolved = this.resolveDispatchThread(recordId);
      if (!resolved) {
        throw new Error('Unable to resolve the selected chat thread.');
      }
      const sourceChannel = resolved.sourceChannel || this.selectedChannel;
      if (!sourceChannel?.record_id) {
        throw new Error('Unable to resolve the source channel for this thread.');
      }

      this.chatGetItDoneSource = {
        channelId: sourceChannel.record_id,
        clickedMessageId: resolved.clickedMessage.record_id,
        threadRootMessageId: resolved.threadRootMessage.record_id,
        pgThreadId: resolved.threadRootMessage.pg_thread_id || resolved.clickedMessage.pg_thread_id || null,
        sourceSurface,
        createdAt: new Date().toISOString(),
      };
      this.chatGetItDoneMessages = resolved.threadMessages;
      this.chatGetItDoneScopeId = this.resolveChatGetItDoneDefaultScope(resolved);
      this.chatGetItDoneAssigneeNpub = this.resolveChatGetItDoneDefaultAssignee(resolved);
      this.chatGetItDoneTitle = '';
      this.chatGetItDoneOutputType = 'chat_response';
      this.chatGetItDoneInstructions = '';
      this.chatGetItDoneError = null;
    } catch (error) {
      this.chatGetItDoneError = error?.message || 'Unable to prepare this chat thread.';
      this.error = this.chatGetItDoneError;
    }
  },

  closeChatGetItDone() {
    Object.assign(this, createChatGetItDoneState());
  },

  handleChatGetItDoneOverlayClick() {
    const openedAt = Number(this.chatGetItDoneOpenedAt || 0);
    if (openedAt > 0 && (Date.now() - openedAt) < 250) return;
    this.closeChatGetItDone();
  },

  openChatGetItDoneAssigneePicker() {
    this.showChatGetItDoneAssigneePicker = true;
  },

  closeChatGetItDoneAssigneePicker() {
    this.showChatGetItDoneAssigneePicker = false;
    this.chatGetItDoneAssigneeQuery = '';
  },

  handleChatGetItDoneAssigneeInput(value) {
    this.chatGetItDoneAssigneeQuery = value;
    this.showChatGetItDoneAssigneePicker = true;
    if (String(value || '').startsWith('npub1') && String(value || '').length >= 20) {
      this.resolveChatProfile?.(value);
    }
  },

  async selectChatGetItDoneAssignee(npub) {
    const nextNpub = String(npub || '').trim();
    this.chatGetItDoneAssigneeNpub = nextNpub || null;
    this.chatGetItDoneAssigneeQuery = '';
    this.showChatGetItDoneAssigneePicker = false;
    if (nextNpub) {
      await this.rememberPeople?.([nextNpub], 'task-assignee');
    }
  },

  async clearChatGetItDoneAssignee() {
    await this.selectChatGetItDoneAssignee(null);
  },

  openChatGetItDoneScopePicker() {
    this.showChatGetItDoneScopePicker = true;
  },

  closeChatGetItDoneScopePicker() {
    this.showChatGetItDoneScopePicker = false;
    this.chatGetItDoneScopeQuery = '';
  },

  handleChatGetItDoneScopeInput(value) {
    this.chatGetItDoneScopeQuery = value;
    this.showChatGetItDoneScopePicker = true;
  },

  selectChatGetItDoneScope(scopeId) {
    const nextScopeId = String(scopeId || '').trim();
    this.chatGetItDoneScopeId = nextScopeId || null;
    this.chatGetItDoneScopeQuery = '';
    this.showChatGetItDoneScopePicker = false;
  },

  clearChatGetItDoneScope() {
    this.selectChatGetItDoneScope(null);
  },

  async submitChatGetItDone() {
    this.error = null;
    this.chatGetItDoneError = null;
    if (!this.chatGetItDoneCanSubmit) {
      this.chatGetItDoneError = 'Add a short task title before creating the task.';
      this.error = this.chatGetItDoneError;
      return null;
    }

    const source = this.chatGetItDoneSource;
    const sourceLink = { type: 'chat', id: `${source.channelId}#${source.threadRootMessageId}` };
    const sourceLinks = [sourceLink];
    const deliverableLinks = [];
    const selectedScopeId = this.chatGetItDoneScopeId || this.resolveChatGetItDoneDefaultScope();
    const taskScopeId = selectedScopeId || UNSCOPED_TASK_BOARD_ID;
    const hasScopedDocTarget = Boolean(selectedScopeId && this.scopesMap?.has?.(selectedScopeId));
    const pgThreadId = isTowerPgBackendMode()
      ? (source.pgThreadId || resolvePgThreadId(this, source.threadRootMessageId))
      : null;
    this.chatGetItDoneSubmitting = true;
    try {
      if (this.chatGetItDoneOutputType === 'doc' && hasScopedDocTarget && typeof this.createDocument === 'function') {
        const doc = await this.createDocument(this.chatGetItDoneTitle, {
          scopeId: selectedScopeId,
          sourceLinks,
          ...(isTowerPgBackendMode() ? { channelId: source.channelId, threadId: pgThreadId } : {}),
        });
        if (doc?.record_id) deliverableLinks.push({ type: 'doc', id: doc.record_id, order: 1 });
      }

      const description = buildChatGetItDoneTaskDescription({
        prompt: this.chatGetItDoneTitle,
        outputType: this.chatGetItDoneOutputType,
        extraInstructions: this.chatGetItDoneInstructions,
        sourceUrl: this.buildChatGetItDoneSourceUrl(source),
        messages: this.chatGetItDoneMessages,
        senderLabelResolver: (message) => this.getSenderName?.(message?.sender_npub) || message?.sender_npub || 'Unknown sender',
      });

      this.newTaskTitle = String(this.chatGetItDoneTitle || '').trim();
      const createdTask = await this.addTask?.({
        description,
        state: 'ready',
        scopeId: taskScopeId,
        ...(isTowerPgBackendMode() ? { channelId: source.channelId, threadId: pgThreadId } : {}),
        assignedToNpub: this.chatGetItDoneAssigneeNpub || null,
        sourceLinks,
        deliverableLinks,
      });
      if (!createdTask?.record_id) {
        throw new Error(this.error || 'Failed to create the ready task from this chat thread.');
      }
      this.closeChatGetItDone();
      this.navigateTo?.('tasks', { syncRoute: false });
      this.openTaskDetail?.(createdTask.record_id);
      this.syncRoute?.();
      return createdTask;
    } catch (error) {
      this.chatGetItDoneError = error?.message || 'Failed to create the ready task from this chat thread.';
      this.error = this.chatGetItDoneError;
      return null;
    } finally {
      this.chatGetItDoneSubmitting = false;
    }
  },

  closeChatThreadFlowDispatch() {
    Object.assign(this, createChatThreadFlowDispatchState());
  },

  handleChatThreadFlowDispatchOverlayClick() {
    const openedAt = Number(this.chatThreadFlowDispatchOpenedAt || 0);
    if (openedAt > 0 && (Date.now() - openedAt) < 250) {
      return;
    }
    this.closeChatThreadFlowDispatch();
  },

  resolveDispatchThread(recordId) {
    const resolved = resolveChatThreadFlowDispatchThread(this.messages, recordId);
    if (!resolved) return null;
    return {
      ...resolved,
      sourceChannel: this.channels.find((channel) => channel.record_id === resolved.clickedMessage.channel_id) || this.selectedChannel || null,
    };
  },

  syncChatThreadFlowDispatchScopeResolution() {
    const flow = this.chatThreadFlowDispatchSelectedFlow;
    const sourceChannel = this.chatThreadFlowDispatchSourceChannel;
    const flowScopeId = flow?.scope_id ?? null;
    const channelScopeId = sourceChannel?.scope_id ?? null;
    const { resolvedScopeId, scopeSource } = resolveChatThreadFlowDispatchScope({
      manualScopeId: this.chatThreadFlowDispatchManualScopeId,
      flowScopeId,
      channelScopeId,
    });

    let assignment = null;
    if (scopeSource === 'flow') {
      assignment = buildStoredFlowKickoffScopeAssignment(flow);
    } else if (scopeSource === 'override' || scopeSource === 'channel') {
      assignment = normalizeChatThreadFlowDispatchScopeAssignment(
        this.buildTaskBoardAssignment(resolvedScopeId, null),
      );
    } else {
      assignment = normalizeChatThreadFlowDispatchScopeAssignment(
        this.buildTaskBoardAssignment(UNSCOPED_TASK_BOARD_ID, null),
      );
    }

    this.chatThreadFlowDispatchResolvedScopeId = resolvedScopeId;
    this.chatThreadFlowDispatchScopeSource = scopeSource;
    this.chatThreadFlowDispatchResolvedScopeAssignment = assignment;
    return assignment;
  },

  handleChatThreadFlowDispatchInputsChanged() {
    this.syncChatThreadFlowDispatchScopeResolution();
    if (this.chatThreadFlowDispatchDirty) {
      this.chatThreadFlowDispatchPreviewStale = true;
      return;
    }
    this.regenerateChatThreadFlowDispatchPreview();
  },

  regenerateChatThreadFlowDispatchPreview() {
    const source = this.chatThreadFlowDispatchSource;
    const flow = this.chatThreadFlowDispatchSelectedFlow;
    this.syncChatThreadFlowDispatchScopeResolution();

    if (!source?.channelId || !flow?.record_id || this.chatThreadFlowDispatchMessages.length === 0) {
      this.chatThreadFlowDispatchPreview = '';
      this.chatThreadFlowDispatchDirty = false;
      this.chatThreadFlowDispatchPreviewStale = false;
      return '';
    }

    const preview = buildChatThreadFlowDispatchPreview({
      channelId: source.channelId,
      channelScopeId: this.chatThreadFlowDispatchSourceChannel?.scope_id ?? null,
      clickedMessageId: source.clickedMessageId,
      dispatchedAt: source.dispatchedAt || new Date().toISOString(),
      flowId: flow.record_id,
      flowScopeId: flow.scope_id ?? null,
      flowTitle: flow.title || 'Untitled flow',
      launchNotes: this.chatThreadFlowDispatchLaunchNotes,
      messages: this.chatThreadFlowDispatchMessages,
      resolvedScopeId: this.chatThreadFlowDispatchResolvedScopeId,
      scopeSource: this.chatThreadFlowDispatchScopeSource,
      senderLabelResolver: (message) => this.getSenderName?.(message?.sender_npub) || message?.sender_npub || 'Unknown sender',
      sourceSurface: source.sourceSurface || 'main_feed',
      threadRootMessageId: source.threadRootMessageId,
      workspaceOwnerNpub: this.workspaceOwnerNpub,
    }).description;

    this.chatThreadFlowDispatchPreview = preview;
    this.chatThreadFlowDispatchDirty = false;
    this.chatThreadFlowDispatchPreviewStale = false;
    return preview;
  },

  markChatThreadFlowDispatchPreviewEdited() {
    this.chatThreadFlowDispatchDirty = true;
  },

  async submitChatThreadFlowDispatch() {
    this.error = null;
    this.chatThreadFlowDispatchError = null;
    if (!this.chatThreadFlowDispatchCanSubmit) {
      this.chatThreadFlowDispatchError = 'Select a flow and confirm the preview before dispatching.';
      this.error = this.chatThreadFlowDispatchError;
      return null;
    }

    const source = this.chatThreadFlowDispatchSource;
    this.chatThreadFlowDispatchSubmitting = true;
    try {
      // Flow dispatch was removed from Flight Deck (flows feature removal).
      const result = null;
      if (!result) {
        throw new Error('Flow dispatch is no longer available.');
      }
      this.closeChatThreadFlowDispatch();
      return result;
    } catch (error) {
      console.error('Chat thread flow dispatch submit failed:', {
        error,
        flowId: this.chatThreadFlowDispatchSelectedFlowId,
        source,
      });
      this.chatThreadFlowDispatchError = error?.message || 'Failed to create the kickoff task for this flow dispatch.';
      this.error = this.chatThreadFlowDispatchError;
      return null;
    } finally {
      this.chatThreadFlowDispatchSubmitting = false;
    }
  },

  inspectMessageSyncStatus(recordId) {
    const message = this.messages.find((m) => m.record_id === recordId);
    const body = message?.body || '';
    const label = body.length > 50 ? body.slice(0, 50) + '...' : (body || 'Chat message');
    this.messageActionsMenuId = null;
    this.openRecordStatusModal({
      familyId: 'chat_message',
      recordId,
      label,
    });
  },

  async deleteActiveThread() {
    this.error = null;
    const parent = this.getThreadParentMessage();
    if (!parent || !this.selectedChannelId) {
      this.error = 'Open a thread first';
      return;
    }
    this.openChatDeleteConfirm('thread', parent.record_id);
  },

  async deleteChatMessageById(recordId) {
    this.error = null;
    const message = this.getChatMessageById(recordId);
    if (!message) throw new Error('Message not found');
    if (isTowerPgBackendMode() && message.pg_backend) {
      const accepted = await deleteTowerPgMessageFromLocal(this, message);
      await upsertMessage(accepted);
      this.messages = this.messages
        .filter((candidate) => candidate.record_id !== message.record_id && candidate.record_id !== accepted.record_id)
        .concat(accepted);
      if (this.activeThreadId === message.record_id) this.closeThread({ syncRoute: false });
      return;
    }
    await this.softDeleteChatMessages([message], 'Chat message delete');
    if (this.activeThreadId === message.record_id) this.closeThread({ syncRoute: false });
  },

  async deleteChatThreadByParentId(recordId) {
    this.error = null;
    const parent = this.getChatMessageById(recordId);
    if (!parent) throw new Error('Thread not found');
    const threadMessages = [parent, ...this.getThreadReplies(parent.record_id)];
    if (isTowerPgBackendMode() && parent.pg_backend) {
      await deleteTowerPgThreadFromLocal(this, parent);
      const now = new Date().toISOString();
      for (const message of threadMessages) {
        await upsertMessage({
          ...message,
          record_state: 'deleted',
          sync_status: 'synced',
          version: (message.version ?? 1) + 1,
          updated_at: now,
        });
      }
      this.messages = this.messages.map((message) => (
        threadMessages.some((deleted) => deleted.record_id === message.record_id)
          ? { ...message, record_state: 'deleted', sync_status: 'synced', updated_at: now }
          : message
      ));
      if (this.activeThreadId === parent.record_id) this.closeThread({ syncRoute: false });
      return;
    }
    await this.softDeleteChatMessages(threadMessages, 'Chat thread delete');
    if (this.activeThreadId === parent.record_id) this.closeThread({ syncRoute: false });
  },

  async archiveChatThreadByParentId(recordId, archived = true) {
    this.error = null;
    this.threadMenuOpen = false;
    const parent = this.getChatMessageById(recordId);
    if (!parent) throw new Error('Thread not found');
    if (this.isChatThreadArchiveSubmitting(parent.record_id)) return null;
    const nextState = archived ? 'archived' : 'active';
    const now = new Date().toISOString();
    this.chatThreadArchiveSubmittingId = parent.record_id;
    this.chatThreadArchiveSubmittingAction = archived ? 'archive' : 'unarchive';
    try {
      if (!isTowerPgBackendMode() || !parent.pg_backend) throw new Error('Thread archive requires Tower PG mode');
      const accepted = await archiveTowerPgThreadFromLocal(this, parent, archived);
      const updatedParent = {
        ...parent,
        record_state: accepted?.record_state || nextState,
        version: accepted?.row_version || accepted?.version || ((parent.version ?? 1) + 1),
        updated_at: accepted?.updated_at || now,
        pg_archived_at: accepted?.archived_at || null,
      };
      await upsertMessage(updatedParent);
      this.messages = this.messages.map((message) => (
        message.record_id === parent.record_id ? updatedParent : message
      ));
      this.closeMessageActionsMenu();
      this.scheduleChatPreviewMeasurement();
      return updatedParent;
    } catch (error) {
      this.error = error?.message || (archived ? 'Failed to archive thread.' : 'Failed to unarchive thread.');
      return null;
    } finally {
      if (this.chatThreadArchiveSubmittingId === parent.record_id) {
        this.chatThreadArchiveSubmittingId = '';
        this.chatThreadArchiveSubmittingAction = '';
      }
    }
  },

  async softDeleteChatMessages(messagesToDelete, label = 'Chat message delete') {
    const messages = Array.isArray(messagesToDelete) ? messagesToDelete.filter(Boolean) : [];
    if (messages.length === 0) return;
    const channel = this.selectedChannel
      || this.channels.find((candidate) => candidate.record_id === messages[0]?.channel_id)
      || null;
    const channelWriteFields = await getRecordWriteFieldsForStore(this, channel, {
      label,
    });

    for (const message of messages) {
      const nextVersion = (message.version ?? 1) + 1;
      await upsertMessage({
        ...message,
        record_state: 'deleted',
        sync_status: 'pending',
        version: nextVersion,
        updated_at: new Date().toISOString(),
      });

      const envelope = await outboundChatMessage({
        record_id: message.record_id,
        owner_npub: channel?.owner_npub || this.workspaceOwnerNpub || message.sender_npub,
        channel_id: message.channel_id,
        parent_message_id: message.parent_message_id,
        body: message.body,
        channel_group_ids: channelWriteFields.group_ids,
        write_group_ref: channelWriteFields.write_group_ref,
        version: nextVersion,
        previous_version: message.version ?? 1,
        signature_npub: this.signingNpub,
        record_state: 'deleted',
      });

      await queueTowerPendingWrite(this, {
        record_id: message.record_id,
        record_family_hash: recordFamilyHash('chat_message'),
        envelope,
      });
    }

    this.messages = this.messages.map((message) => (
      messages.some((deleted) => deleted.record_id === message.record_id)
        ? { ...message, record_state: 'deleted', sync_status: 'pending' }
        : message
    ));
    await this.flushAndBackgroundSync();
  },
};
