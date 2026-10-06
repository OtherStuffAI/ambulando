import { visibleWikiIntegrityText } from './docs/editor/wiki-visible-text.js';
import { bindWikiState } from './docs/wiki-links.js';
import { prosemirrorToFlightDeckContentModel } from './docs/editor/prosemirror-to-flightdeck.js';
import { wikiManagerMixin } from './docs/wiki-manager.js';
/**
 * Document management methods extracted from app.js.
 *
 * Pure utility functions are exported individually for direct testing.
 * The docsManagerMixin object contains methods that use `this` (the Alpine store)
 * and should be spread into the store definition.
 */

import { commentBelongsToDocBlock } from './doc-comment-anchors.js';
import {
  sameListBySignature,
  parseMarkdownBlocks,
  assembleMarkdownBlocks,
  createDocumentBlock,
  normalizeDocumentBlocks,
} from './utils/state-helpers.js';
import {
  upsertDocument,
  replaceDocumentRecord,
  upsertDirectory,
  upsertComment,
  replaceCommentRecord,
  getCommentsByTarget,
  getAudioNoteById,
  getDocumentDraft,
  upsertDocumentDraft,
  deleteDocumentDraft,
} from './db.js';
import { recordFamilyHash } from './translators/chat.js';
import {
  DOCUMENT_CONTENT_STORAGE_FORMAT,
  DOCUMENT_CONTENT_STORAGE_MIME,
  outboundDocument,
  outboundDirectory,
} from './translators/docs.js';
import { outboundComment } from './translators/comments.js';
import { toRaw } from './utils/state-helpers.js';
import {
  acquireRecordCheckout,
  completeStorageObject,
  fetchRecordHistory,
  getTowerPgDocRecoveries,
  getTowerPgDocRecovery,
  getTowerPgDocRecoveryBody,
  getTowerPgDocVersions,
  promoteTowerPgDocRecovery,
  discardTowerPgDocRecovery,
  prepareStorageObject,
  prepareTowerPgStorageObject,
  releaseRecordCheckout,
  uploadStorageObject,
} from './api.js';
import {
  createTowerPgDocCommentFromLocal,
  createTowerPgDocFromLocal,
  deleteTowerPgDocCommentFromLocal,
  deleteTowerPgDocFromLocal,
  updateTowerPgDocFromLocal,
  updateTowerPgDocCommentFromLocal,
  queueTowerPendingWrite,
} from './tower-command-intents.js';
import { inboundDocument } from './translators/docs.js';
import { renderMarkdownToHtml, hydrateStorageImageMarkup } from './markdown.js';
import { normalizeGroupIds } from './scope-delivery.js';
import { buildStoragePrepareBody } from './storage-payloads.js';
import {
  buildRecordLinkPayload,
  mergeRecordLinkLists,
  normalizeRecordLinkList,
  parseRecordReferencesFromText,
  recordLinkKey,
} from './record-links.js';
import { hasGroupKey } from './crypto/group-keys.js';
import {
  getEncryptableRecordGroupRefsForStore,
  getMissingRecordGroupRefsForStore,
  getRecordGroupKeyState,
  selectPreferredRecordWriteGroupRef,
  getStoreActorWritableGroupRefs,
} from './preferred-write-group.js';
import { requireFlightDeckIdentityContext } from './superbased/identity-context.js';
import {
  checkoutErrorMessage,
  describeCheckoutHolder,
  formatLeaseRemaining,
  isCheckoutHeld,
  lockManagedRecordKey,
} from './lock-managed-records.js';
import { resolveFlightDeckRecordCheckoutPolicy } from './record-checkout-policy.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import { mapPgDocToLocal, resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';
import { getPgChannelScopeId } from './pg-record-context.js';
import {
  acquirePgEditLeaseForRecord,
  clearPgEditLeaseSession,
  getPgEditLeaseSession,
  inspectPgEditLeaseForRecord,
  isOnlineForPgEdit,
  isSyncedPgRecord,
  isUnsyncedLocalPgRecord,
  releasePgEditLeaseForRecord,
  startPgEditLeaseRenewal,
  stopPgEditLeaseRenewal,
} from './pg-edit-session.js';
import { diffLines } from 'diff';
import { loadTiptapEditorAdapter } from './docs/editor/lazy-tiptap-editor.js';
import {
  createDocumentEditorState,
  shouldUseRichDocumentEditor,
} from './docs/editor/document-editor-store.js';
import { validateDocumentContentModelRoundTrip } from './docs/editor/document-content-integrity.js';
import { FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT } from './docs/editor/prosemirror-constants.js';
import {
  captureRichEditorSelectionAnchor,
  resolveRichEditorSelectionAnchor,
  revealRichEditorSelectionAnchor,
} from './docs/editor/comment-selection-anchor.js';

// ---------------------------------------------------------------------------
// Pure utility functions (no `this` dependency)
// ---------------------------------------------------------------------------

const DOCUMENT_INLINE_PREVIEW_CHARS = 8_192;
export const DOCUMENT_LOCAL_DRAFT_DELAY_MS = 200;
export const DOCUMENT_REMOTE_AUTOSAVE_DELAY_MS = 15_000;
const DOCUMENT_BODY_RETRY_DELAYS_MS = [0, 1_000, 3_000, 7_000];

function waitForDocumentRetry(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer?.unref?.();
  });
}

function isPgStaleRowVersionError(error) {
  if (!error) return false;
  if (error.code === 'stale_row_version') return true;
  const text = String(error.responseText || error.message || '');
  return text.includes('"code":"stale_row_version"') || text.includes('stale_row_version');
}

function isPgDocumentRecoveryCreatedError(error) {
  return error?.code === 'document_recovery_created'
    || String(error?.responseText || '').includes('document_recovery_created');
}

function canonicalDocVersionId(item = {}) {
  const explicit = String(item?.pg_canonical_version_id || '').trim();
  if (explicit) return explicit;
  const recordId = String(item?.record_id || '').trim();
  const rowVersion = Number(item?.version || item?.row_version || 0);
  return recordId && rowVersion > 0 ? `${recordId}:${rowVersion}` : null;
}

export function documentEditorBaseIdentity(item = {}) {
  const bodySha256Hex = String(item?.pg_canonical_body_sha256_hex || item?.content_sha256_hex || '').trim() || null;
  const storageObjectId = String(item?.pg_canonical_storage_object_id || item?.content_storage_object_id || '').trim() || null;
  const rowVersion = Number(item?.version || item?.row_version || 0);
  const baseAvailable = isDocumentContentReadyForEditor(item)
    && rowVersion > 0
    && Boolean(bodySha256Hex);
  return {
    base_available: baseAvailable,
    base_row_version: rowVersion || null,
    base_version_id: canonicalDocVersionId(item),
    base_body_sha256_hex: bodySha256Hex,
    base_storage_object_id: storageObjectId,
  };
}

function normalizedOptionalIdentity(value, { lowerCase = false } = {}) {
  const normalized = String(value || '').trim();
  return normalized ? (lowerCase ? normalized.toLowerCase() : normalized) : null;
}

function optionalIdentityMatches(left, right, options = {}) {
  const normalizedLeft = normalizedOptionalIdentity(left, options);
  const normalizedRight = normalizedOptionalIdentity(right, options);
  return !normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight;
}

export function draftBaseMatchesHead(draft = {}, head = {}) {
  const draftRowVersion = Number(draft.base_row_version || draft.row_version || 0);
  const headRowVersion = Number(head.base_row_version || head.row_version || 0);
  if (draft.base_available !== true || draftRowVersion <= 0 || headRowVersion <= 0) return false;
  if (draftRowVersion !== headRowVersion) return false;
  return optionalIdentityMatches(draft.base_version_id || draft.version_id, head.base_version_id || head.version_id)
    && optionalIdentityMatches(
      draft.base_body_sha256_hex || draft.body_sha256_hex,
      head.base_body_sha256_hex || head.body_sha256_hex,
      { lowerCase: true },
    )
    && optionalIdentityMatches(
      draft.base_storage_object_id || draft.storage_object_id,
      head.base_storage_object_id || head.storage_object_id,
    );
}

function decodeStoredRecoveryContent(bodyResult = {}) {
  const encoded = String(bodyResult?.body?.base64_data || '').trim();
  if (!encoded) return null;
  const binary = globalThis.atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const raw = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(raw);
  return parsed?.content_model && typeof parsed.content_model === 'object'
    ? parsed.content_model
    : parsed;
}

export function isDocumentContentReadyForEditor(item = {}) {
  if (!item?.content_storage_object_id) return true;
  if (item.content_storage_status === 'loaded') return true;
  // Storage-backed collection rows may carry only the inline preview in
  // `content`. A local editor model is the explicit signal that a fresh local
  // submission still owns the complete body while its storage status is remote.
  if (Array.isArray(item.content_blocks) && item.content_blocks.length > 0) return true;
  return item.editor_state?.type === 'doc';
}

async function sha256HexForBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function buildStoredDocumentContent(contentModel) {
  return {
    format: DOCUMENT_CONTENT_STORAGE_FORMAT,
    content_model: contentModel,
  };
}

function hasProseMirrorContentModel(contentModel = {}) {
  return contentModel?.content_format === FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT
    && contentModel?.editor_state?.type === 'doc';
}

function normalizedDocumentPlainText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function proseMirrorPlainText(node = null) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return String(node.text || '');
  if (node.type === 'fdWikiLink') return String(node.attrs?.title || '');
  if (node.type === 'hardBreak') return '\n';
  const children = Array.isArray(node.content) ? node.content : [];
  const content = children.map(proseMirrorPlainText).join('');
  return ['paragraph', 'heading', 'blockquote', 'listItem', 'taskItem'].includes(node.type)
    ? `${content}\n`
    : content;
}

const PG_DOCUMENT_ACCEPTED_CONTENT_FIELDS = [
  'content',
  'content_format',
  'content_blocks',
  'editor_state',
  'editor_state_format',
  'editor_state_version',
  'content_storage_object_id',
  'content_storage_format',
  'content_storage_content_type',
  'content_size_bytes',
  'content_sha256_hex',
  'references',
];

export function mergeDocumentSaveReferences(record = {}, parsedReferences = []) {
  const links = buildRecordLinkPayload(record || {});
  const highSignalKeys = new Set([
    ...links.source_links.map(recordLinkKey),
    ...links.deliverable_links.map(recordLinkKey),
  ].filter(Boolean));
  return mergeRecordLinkLists(links.references, parsedReferences)
    .filter((link) => !highSignalKeys.has(recordLinkKey(link)));
}

function buildDocumentStorageFileName(title, recordId) {
  const safeTitle = String(title || 'document')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'document';
  const safeRecordId = String(recordId || '').trim().slice(0, 36) || 'record';
  return `${safeTitle}-${safeRecordId}.document.json`;
}

function buildStoredDocumentContentPayload(contentModel, storage) {
  const preview = String(contentModel.content || '').slice(0, DOCUMENT_INLINE_PREVIEW_CHARS);
  return {
    content: preview,
    content_format: contentModel.content_format,
    content_blocks: [],
    content_storage_object_id: storage.objectId,
    content_storage_format: DOCUMENT_CONTENT_STORAGE_FORMAT,
    content_storage_content_type: DOCUMENT_CONTENT_STORAGE_MIME,
    content_size_bytes: storage.sizeBytes,
    content_sha256_hex: storage.sha256Hex,
  };
}

export function normalizeDocShare(share, inheritedFromDirectoryId = null) {
  if (!share) return null;
  const type = share.type === 'person' ? 'person' : 'group';
  const personNpub = String(share.person_npub || '').trim() || null;
  const groupNpub = String(share.group_npub || '').trim() || null;
  const viaGroupNpub = String(share.via_group_npub || '').trim() || null;
  const groupId = String(share.group_id || '').trim() || groupNpub || null;
  const viaGroupId = String(share.via_group_id || '').trim() || viaGroupNpub || null;
  const key = type === 'person'
    ? (personNpub ? `person:${personNpub}` : null)
    : `group:${groupId || viaGroupId || groupNpub || viaGroupNpub}`;
  if (!key) return null;

  const sourceDirectoryId = inheritedFromDirectoryId || share.inherited_from_directory_id || null;
  return {
    ...share,
    type,
    key,
    access: share.access === 'write' ? 'write' : 'read',
    person_npub: personNpub,
    group_id: groupId,
    group_npub: groupNpub,
    via_group_id: viaGroupId,
    via_group_npub: viaGroupNpub,
    inherited: Boolean(sourceDirectoryId || share.inherited),
    inherited_from_directory_id: sourceDirectoryId,
  };
}

export function serializeDocShares(shares) {
  return JSON.stringify((shares || [])
    .map((share) => ({
      type: share.type,
      key: share.key,
      access: share.access,
      person_npub: share.person_npub || null,
      group_id: share.group_id || null,
      group_npub: share.group_npub || null,
      via_group_id: share.via_group_id || null,
      via_group_npub: share.via_group_npub || null,
      inherited: share.inherited === true,
      inherited_from_directory_id: share.inherited_from_directory_id || null,
    }))
    .sort((a, b) => String(a.key || '').localeCompare(String(b.key || ''))));
}

export function mergeDocShareLists(primaryShares = [], inheritedShares = []) {
  const merged = new Map();
  for (const share of primaryShares) {
    const normalized = normalizeDocShare(share);
    if (!normalized?.key) continue;
    merged.set(normalized.key, normalized);
  }

  for (const share of inheritedShares) {
    const normalized = normalizeDocShare(
      share,
      share.inherited_from_directory_id || share.source_directory_id || null,
    );
    if (!normalized?.key) continue;
    const existing = merged.get(normalized.key);
    if (!existing) {
      merged.set(normalized.key, normalized);
      continue;
    }
    merged.set(normalized.key, {
      ...existing,
      access: existing.access === 'write' || normalized.access === 'write' ? 'write' : 'read',
      inherited: existing.inherited || normalized.inherited,
      inherited_from_directory_id: existing.inherited_from_directory_id || normalized.inherited_from_directory_id || null,
    });
  }

  return [...merged.values()].sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')));
}

export function getStoredDocShares(item) {
  return Array.isArray(item?.shares)
    ? item.shares.map((share) => normalizeDocShare(share)).filter(Boolean)
    : [];
}

export function getExplicitDocShares(item) {
  return getStoredDocShares(item).filter((share) => !share.inherited && !share.inherited_from_directory_id);
}

export function getShareGroupIds(shares = []) {
  return [...new Set((shares || []).map((share) => share.type === 'person'
    ? (share.via_group_id || share.group_id || share.via_group_npub || share.group_npub)
    : (share.group_id || share.group_npub)).filter(Boolean))];
}

export function getWriteableShareGroupIds(shares = []) {
  return [...new Set((shares || [])
    .filter((share) => share?.access === 'write')
    .map((share) => share.type === 'person'
      ? (share.via_group_id || share.group_id || share.via_group_npub || share.group_npub)
      : (share.group_id || share.group_npub))
    .filter(Boolean))];
}

export function getPreferredDocWriteGroupRef(item = null, options = {}) {
  const hasKey = typeof options?.hasKey === 'function'
    ? options.hasKey
    : hasGroupKey;
  const allowedGroupIds = normalizeGroupIds(options?.allowedGroupIds || []);
  const shares = getStoredDocShares(item);
  const groupIds = normalizeGroupIds(
    Array.isArray(item?.group_ids) && item.group_ids.length > 0
      ? item.group_ids
      : getShareGroupIds(shares),
  );
  return selectPreferredRecordWriteGroupRef({
    ...item,
    group_ids: groupIds,
    shares,
  }, {
    hasKey,
    allowedGroupIds,
  });
}

export function normalizeDocAccessRow(item, resolverFn = (value) => String(value || '').trim() || null, options = {}) {
  if (!item || typeof item !== 'object') return item;

  const allowedGroupIds = normalizeGroupIds((options.allowedGroupIds || [])
    .map((value) => resolverFn(value))
    .filter(Boolean));
  const hasAllowedFilter = allowedGroupIds.length > 0;
  const allowedSet = new Set(allowedGroupIds);
  const isAllowedGroupRef = (groupRef) => {
    if (!hasAllowedFilter) return true;
    const resolved = resolverFn(groupRef);
    return Boolean(resolved && allowedSet.has(resolved));
  };

  const nextShares = getStoredDocShares(item)
    .map((share) => normalizeDocShare({
      ...share,
      group_id: resolverFn(share.group_id || share.group_npub),
      via_group_id: resolverFn(share.via_group_id || share.via_group_npub),
    }))
    .filter(Boolean)
    .filter((share) => {
      const groupRef = share.type === 'person'
        ? (share.via_group_id || share.group_id || share.via_group_npub || share.group_npub || null)
        : (share.group_id || share.group_npub || null);
      if (!groupRef) return true;
      return isAllowedGroupRef(groupRef);
    });
  const nextScopePolicyGroupIds = item.scope_policy_group_ids == null
    ? null
    : normalizeGroupIds((item.scope_policy_group_ids || [])
      .map((value) => resolverFn(value))
      .filter((value) => Boolean(value) && isAllowedGroupRef(value)));
  const shareGroupIds = getShareGroupIds(nextShares).map((value) => resolverFn(value)).filter(Boolean);
  const providedGroupIds = Array.isArray(item.group_ids) && item.group_ids.length > 0
    ? item.group_ids
      .map((value) => resolverFn(value))
      .filter((value) => Boolean(value) && isAllowedGroupRef(value))
    : [];
  const nextGroupIds = normalizeGroupIds([
    ...(nextScopePolicyGroupIds || []),
    ...providedGroupIds,
    ...shareGroupIds,
  ]);
  const nextWriteGroupId = resolverFn(
    getPreferredDocWriteGroupRef({
      ...item,
      shares: nextShares,
      group_ids: nextGroupIds,
      scope_policy_group_ids: nextScopePolicyGroupIds,
    }, options),
  );

  const sharesChanged = serializeDocShares(item.shares || []) !== serializeDocShares(nextShares);
  const groupIdsChanged = JSON.stringify(item.group_ids || []) !== JSON.stringify(nextGroupIds);
  const scopePolicyChanged = JSON.stringify(item.scope_policy_group_ids || null) !== JSON.stringify(nextScopePolicyGroupIds);
  const writeGroupChanged = (item.write_group_id || null) !== (nextWriteGroupId || null);

  if (!sharesChanged && !groupIdsChanged && !scopePolicyChanged && !writeGroupChanged) {
    return item;
  }

  return {
    ...item,
    shares: nextShares,
    group_ids: nextGroupIds,
    scope_policy_group_ids: nextScopePolicyGroupIds,
    write_group_id: nextWriteGroupId,
  };
}

export function getDocCommentSummary(comment) {
  const words = String(comment?.body || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 7) return words.join(' ');
  return `${words.slice(0, 7).join(' ')}…`;
}

/**
 * Convert a Blob into a data: URL string.
 *
 * Data URLs are self-contained and work across browsing contexts, unlike
 * blob: URLs which are tied to the document that created them.
 */
export async function blobToDataUrl(blob) {
  // Use FileReader in browser environments, fall back to arrayBuffer for
  // Node/Bun where FileReader may not exist.
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
}

/**
 * Build the full HTML document string used for the print/PDF export window.
 */
export function buildDocPrintHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #222; line-height: 1.6; }
  h1 { font-size: 1.8rem; border-bottom: 1px solid #ddd; padding-bottom: 0.5rem; }
  h2 { font-size: 1.4rem; margin-top: 1.5rem; }
  h3 { font-size: 1.2rem; margin-top: 1.2rem; }
  pre { background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow-x: auto; }
  code { background: #f0f0f0; padding: 0.15rem 0.3rem; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
  th { background: #f5f5f5; }
  blockquote { border-left: 3px solid #ddd; margin-left: 0; padding-left: 1rem; color: #555; }
  img { max-width: 100%; }
  .md-storage-image-error { opacity: 0.3; min-height: 2rem; background: #f0f0f0; }
  @media print { body { margin: 0; } }
</style>
</head><body><h1>${title}</h1>${bodyHtml}</body></html>`;
}

// ---------------------------------------------------------------------------
// Mixin methods — use `this` (the Alpine store). Spread into the store.
// ---------------------------------------------------------------------------

export const docsManagerMixin = {
  getRecordCheckoutPolicyConfig(options = {}) {
    return options.checkoutPolicyConfig || this.recordCheckoutPolicyConfig || null;
  },

  resolveRecordCheckoutPolicy(recordFamilyHash, record = null, options = {}) {
    return resolveFlightDeckRecordCheckoutPolicy(
      recordFamilyHash,
      this.getRecordCheckoutPolicyConfig(options),
      { recordId: record?.record_id },
    );
  },

  isCheckoutRequiredRecordFamily(recordFamilyHash, record = null, options = {}) {
    return this.resolveRecordCheckoutPolicy(recordFamilyHash, record, options) === 'checkout_required';
  },

  getLockManagedCheckoutSession(recordId, recordFamilyHash) {
    const key = lockManagedRecordKey(recordId, recordFamilyHash);
    if (!key) return null;
    return this.lockManagedCheckoutSessions?.[key] || null;
  },

  setLockManagedCheckoutSession(recordId, recordFamilyHash, patch = {}) {
    const key = lockManagedRecordKey(recordId, recordFamilyHash);
    if (!key) return null;
    const current = this.lockManagedCheckoutSessions?.[key] || {};
    const next = {
      ...current,
      ...patch,
      recordId: String(recordId || '').trim(),
      recordFamilyHash: String(recordFamilyHash || '').trim(),
      updatedAt: new Date().toISOString(),
    };
    this.lockManagedCheckoutSessions = {
      ...(this.lockManagedCheckoutSessions || {}),
      [key]: next,
    };
    return next;
  },

  clearLockManagedCheckoutSession(recordId, recordFamilyHash) {
    const key = lockManagedRecordKey(recordId, recordFamilyHash);
    if (!key || !this.lockManagedCheckoutSessions?.[key]) return;
    const next = { ...(this.lockManagedCheckoutSessions || {}) };
    delete next[key];
    this.lockManagedCheckoutSessions = next;
  },

  buildLockManagedCheckoutIdentityContext() {
    try {
      return requireFlightDeckIdentityContext(this);
    } catch (error) {
      const classification = Array.isArray(error?.missing) && error.missing.includes('workspaceUserKeyNpub')
        ? 'workspace_key_missing'
        : 'identity_alias_mismatch';
      const wrapped = new Error(checkoutErrorMessage(classification));
      wrapped.classification = classification;
      wrapped.cause = error;
      throw wrapped;
    }
  },

  canCurrentActorAcquireCheckoutRequiredRecord() {
    try {
      this.buildLockManagedCheckoutIdentityContext();
      return true;
    } catch {
      return false;
    }
  },

  canCurrentActorEditOwnerOnlyLockManagedRecord() {
    return this.canCurrentActorAcquireCheckoutRequiredRecord();
  },

  normalizeLockManagedCheckoutFailure(error) {
    const classification = String(error?.classification || error?.towerCode || error?.code || '').trim() || 'unknown';
    const checkout = error?.response?.checkout || error?.checkout || null;
    return {
      classification,
      checkout,
      message: error?.userMessage || checkoutErrorMessage(classification, checkout),
    };
  },

  assertCanMutateLockManagedRecord(record, recordFamilyHash, options = {}) {
    const familyHash = String(recordFamilyHash || '').trim();
    if (!record?.record_id || !familyHash || !this.isCheckoutRequiredRecordFamily(familyHash, record, options)) return true;
    try {
      this.buildLockManagedCheckoutIdentityContext();
      return true;
    } catch (error) {
      const normalized = this.normalizeLockManagedCheckoutFailure(error);
      if (options.autosave === true) this.docAutosaveState = 'error';
      if (options.reportError !== false) this.error = normalized.message;
      error.userMessage = normalized.message;
      throw error;
    }
  },

  async ensureLockManagedCheckout(record, recordFamilyHash, options = {}) {
    const recordId = String(record?.record_id || '').trim();
    const familyHash = String(recordFamilyHash || '').trim();
    if (!recordId || !familyHash || !this.isCheckoutRequiredRecordFamily(familyHash, record, options)) return null;

    let existingSession = this.getLockManagedCheckoutSession(recordId, familyHash);
    const submittedVersion = Number(existingSession?.submittedVersion ?? 0) || 0;
    const localVersion = Number(record?.version ?? 0) || 0;
    if (
      isCheckoutHeld(existingSession?.checkout)
      && submittedVersion > 0
      && String(record?.sync_status || '').trim() === 'synced'
      && localVersion >= submittedVersion
    ) {
      this.clearLockManagedCheckoutSession(recordId, familyHash);
      existingSession = null;
    }
    if (isCheckoutHeld(existingSession?.checkout)) {
      return existingSession.checkout;
    }

    let identityContext;
    try {
      identityContext = this.buildLockManagedCheckoutIdentityContext();
    } catch (error) {
      const normalized = this.normalizeLockManagedCheckoutFailure(error);
      if (options.autosave === true) this.docAutosaveState = 'error';
      if (options.reportError !== false) this.error = normalized.message;
      this.setLockManagedCheckoutSession(recordId, familyHash, {
        acquireState: 'blocked',
        checkout: existingSession?.checkout || null,
        classification: normalized.classification,
        message: normalized.message,
      });
      error.checkout = existingSession?.checkout || null;
      error.userMessage = normalized.message;
      throw error;
    }

    const idempotencyKey = existingSession?.idempotencyKey || crypto.randomUUID();
    this.setLockManagedCheckoutSession(recordId, familyHash, {
      acquireState: 'acquiring',
      idempotencyKey,
      intent: String(options.intent || 'edit').trim() || 'edit',
      classification: '',
      message: '',
    });

    try {
      const checkout = await acquireRecordCheckout({
        recordId,
        recordFamilyHash: familyHash,
        identityContext,
        leaseSeconds: Number.isInteger(options.leaseSeconds) ? options.leaseSeconds : undefined,
        idempotencyKey,
      });
      this.setLockManagedCheckoutSession(recordId, familyHash, {
        acquireState: 'held',
        checkout: checkout?.checkout || null,
        classification: '',
        message: '',
      });
      return checkout?.checkout || null;
    } catch (error) {
      const normalized = this.normalizeLockManagedCheckoutFailure(error);
      this.setLockManagedCheckoutSession(recordId, familyHash, {
        acquireState: normalized.classification === 'unknown' ? 'error' : 'blocked',
        checkout: normalized.checkout,
        classification: normalized.classification,
        message: normalized.message,
      });
      if (options.reportError !== false) this.error = normalized.message;
      error.userMessage = normalized.message;
      throw error;
    }
  },

  async releaseLockManagedCheckout(record, recordFamilyHash, options = {}) {
    const recordId = String(record?.record_id || '').trim();
    const familyHash = String(recordFamilyHash || '').trim();
    if (!recordId || !familyHash || !this.isCheckoutRequiredRecordFamily(familyHash, record, options)) return false;
    const session = this.getLockManagedCheckoutSession(recordId, familyHash);
    if (!isCheckoutHeld(session?.checkout)) return false;
    if (options.force !== true && String(record?.sync_status || '').trim() === 'pending') {
      return false;
    }

    try {
      await releaseRecordCheckout({
        recordId,
        recordFamilyHash: familyHash,
        checkoutId: session.checkout.checkout_id,
        identityContext: this.buildLockManagedCheckoutIdentityContext(),
      });
      this.clearLockManagedCheckoutSession(recordId, familyHash);
      return true;
    } catch (error) {
      const normalized = this.normalizeLockManagedCheckoutFailure(error);
      this.setLockManagedCheckoutSession(recordId, familyHash, {
        acquireState: normalized.classification === 'unknown' ? 'error' : 'blocked',
        checkout: normalized.checkout || session.checkout,
        classification: normalized.classification,
        message: normalized.message,
      });
      if (options.reportError === true) this.error = normalized.message;
      return false;
    }
  },

  async attachCheckoutRequiredCheckoutToEnvelope(record, envelope, options = {}) {
    const familyHash = String(envelope?.record_family_hash || '').trim();
    if (!record?.record_id || !familyHash || !this.isCheckoutRequiredRecordFamily(familyHash, record, options)) return envelope;
    const checkout = await this.ensureLockManagedCheckout(record, familyHash, options);
    if (!checkout?.checkout_id) return envelope;
    this.setLockManagedCheckoutSession(record.record_id, familyHash, {
      acquireState: 'held',
      checkout,
      submittedVersion: Number(envelope?.version ?? 0) || 0,
    });
    return {
      ...envelope,
      checkout: {
        checkout_id: checkout.checkout_id,
        consume_on_success: true,
      },
    };
  },

  async attachLockManagedCheckoutToEnvelope(record, envelope, options = {}) {
    return this.attachCheckoutRequiredCheckoutToEnvelope(record, envelope, options);
  },

  async buildManagedDocumentEnvelope(payload, record = null, options = {}) {
    const payloadBlocks = payload?.content_blocks && Array.isArray(payload.content_blocks)
      ? payload.content_blocks
      : parseMarkdownBlocks(payload?.content || record?.content || '');
    const payloadContent = payload?.content || record?.content || assembleMarkdownBlocks(payloadBlocks);
    const editorState = createDocumentEditorState({
      ...(record || {}),
      content: payloadContent,
      content_blocks: payloadBlocks,
      editor_state: payload?.editor_state || record?.editor_state || null,
    });
    const contentModel = editorState.contentModel;
    const encryptableGroupIds = await getEncryptableRecordGroupRefsForStore(this, payload, {
      label: 'Document write',
      resolveGroupId: (value) => this._resolveDocGroupRef(value),
    });
    const contentPayload = await this.prepareDocumentContentForEnvelope(
      payload,
      contentModel,
      encryptableGroupIds,
      record,
    );
    const recordLinks = buildRecordLinkPayload({
      ...(record || {}),
      ...(payload || {}),
    });
    const envelope = await outboundDocument({
      ...payload,
      ...contentPayload,
      ...recordLinks,
      group_ids: encryptableGroupIds,
    });
    return this.attachLockManagedCheckoutToEnvelope(record, envelope, options);
  },

  async prepareDocumentContentForEnvelope(payload, contentModel, encryptableGroupIds = [], record = null, options = {}) {
    const existingObjectId = String(record?.content_storage_object_id || payload?.content_storage_object_id || '').trim();
    const storagePayload = buildStoredDocumentContent(contentModel);
    const bytes = new TextEncoder().encode(JSON.stringify(storagePayload));
    const sha256Hex = await sha256HexForBytes(bytes);
    if (existingObjectId && String(record?.content_sha256_hex || payload?.content_sha256_hex || '').trim() === sha256Hex) {
      return buildStoredDocumentContentPayload(contentModel, {
        objectId: existingObjectId,
        sizeBytes: bytes.byteLength,
        sha256Hex,
      });
    }

    const ownerNpub = String(payload?.owner_npub || this.workspaceOwnerNpub || '').trim();
    if (!ownerNpub) throw new Error('Document storage upload is missing workspace owner.');

    const ownerGroupId = this._resolveDocGroupRef(
      payload?.write_group_ref
      || record?.write_group_id
      || payload?.write_group_id
      || encryptableGroupIds[0]
      || null,
    );
    const accessGroupIds = normalizeGroupIds(
      (encryptableGroupIds || [])
        .map((value) => this._resolveDocGroupRef(value))
        .filter(Boolean),
    );

    const prepareBody = buildStoragePrepareBody({
      ownerNpub,
      ownerGroupId,
      accessGroupIds,
      contentType: DOCUMENT_CONTENT_STORAGE_MIME,
      sizeBytes: bytes.byteLength,
      fileName: buildDocumentStorageFileName(payload?.title, payload?.record_id),
    });
    const pgStorageContext = options.pgStorageContext || null;
    const prepared = pgStorageContext?.workspaceId
      ? await prepareTowerPgStorageObject(pgStorageContext.workspaceId, prepareBody, {
        baseUrl: pgStorageContext.baseUrl,
        appNpub: pgStorageContext.appNpub,
      })
      : await prepareStorageObject(prepareBody);
    await uploadStorageObject(prepared, bytes, DOCUMENT_CONTENT_STORAGE_MIME);
    await completeStorageObject(prepared.object_id, {
      size_bytes: bytes.byteLength,
      sha256_hex: sha256Hex,
    });

    return buildStoredDocumentContentPayload(contentModel, {
      objectId: prepared.object_id,
      sizeBytes: bytes.byteLength,
      sha256Hex,
    });
  },

  async buildManagedDirectoryEnvelope(payload, record = null, options = {}) {
    const encryptableGroupIds = await getEncryptableRecordGroupRefsForStore(this, payload, {
      label: 'Folder write',
      resolveGroupId: (value) => this._resolveDocGroupRef(value),
    });
    const envelope = await outboundDirectory({
      ...payload,
      group_ids: encryptableGroupIds,
    });
    return this.attachLockManagedCheckoutToEnvelope(record, envelope, options);
  },

  openDoc(recordId, options = {}) {
    this.commentVisibleCount = this.commentPageSize || 80;
    const nextRecordId = String(recordId || '').trim();
    const visit = Number(this.docOpenGeneration || 0) + 1;
    this.docOpenGeneration = visit;
    const workspace = this.currentWorkspace;
    const isCurrent = () => this.docOpenGeneration === visit
      && this.currentWorkspace === workspace
      && this.selectedDocType === 'document' && this.selectedDocId === nextRecordId;
    const isNewDetailEntry = this.selectedDocType !== 'document' || !this.selectedDocId;
    if (isNewDetailEntry || options.captureOrigin === false) {
      const browserRoute = typeof window === 'undefined'
        ? ''
        : `${window.location.pathname}${window.location.search}`;
      const effectiveRoute = options.captureOrigin === false
        ? String(options.originRoute || '').trim()
        : String(this.buildRouteUrl?.() || browserRoute).trim();
      this.docDetailOriginRoute = effectiveRoute;
      if (
        effectiveRoute
        && effectiveRoute !== browserRoute
        && typeof window !== 'undefined'
        && typeof window.history?.replaceState === 'function'
      ) {
        window.history.replaceState(
          { ...(window.history.state || {}), section: this.navSection },
          '',
          effectiveRoute,
        );
      }
    }
    this.chatDocModalOpen = false;
    this.chatDocModalTitle = '';
    this.chatDocModalFullScreen = false;
    const previousRecord = this.selectedDocType === 'document' ? this.selectedDocument : null;
    const previousRecordId = String(previousRecord?.record_id || this.selectedDocId || '').trim();
    let draftPromise = null;
    if (previousRecordId && previousRecordId !== nextRecordId) {
      if (this.docEditDraftDirty && !options.draftPreserved) draftPromise = this.persistSelectedDocDraft({ immediate: true });
      this.cancelDocLocalDraftPersistence();
      this.cancelDocAutosave();
    }
    if (previousRecord?.record_id && previousRecord.record_id !== nextRecordId) {
      void this.releaseSelectedDocLeaseWhenSafe(previousRecord, { draftPromise, reportError: false });
    }
    if (previousRecordId && previousRecordId !== nextRecordId) {
      this.stopDocCommentsLiveQuery?.();
      this.docComments = [];
      this.docCommentAudioDrafts = [];
      this.docCommentReplyAudioDrafts = [];
      this.clearDocCommentConnector?.();
    }
    this.selectedDocType = 'document';
    this.selectedDocId = recordId;
    if (Object.prototype.hasOwnProperty.call(options, 'commentId')) {
      this.selectedDocCommentId = options.commentId || null;
    } else {
      this.selectedDocCommentId = null;
    }
    this.docCommentsVisible = Boolean(this.selectedDocCommentId || options.showComments);
    this.docMobilePane = this.docCommentsVisible ? 'comments' : 'document';
    this.navSection = 'docs';
    this.mobileNavOpen = false;
    const document = this.documents.find((item) => item.record_id === recordId);
    if (isTowerPgBackendMode() && document?.pg_channel_id && document.pg_channel_id !== this.selectedChannelId) {
      this.selectPgChannelContext?.(document.pg_channel_id);
    }
    this.currentFolderId = document?.parent_directory_id || null;
    this.docCommentBackfillAttemptsByDocId = {
      ...this.docCommentBackfillAttemptsByDocId,
      [recordId]: false,
    };
    this.loadDocEditorFromSelection();
    const openedTitle = this.docEditorTitle;
    const openedContent = this.docEditorContent;
    const draftRestore = this.docDraftRestorePromise;
    if (options.syncRoute !== false) this.syncRoute();
    // Yield through Alpine's editor mount and a paint before preparing network
    // reads/signatures. Local content never waits for lease, body or comments.
    const reconcile = async () => {
      if (!isCurrent()) return;
      if (isTowerPgBackendMode() && document) void this.inspectSelectedDocEditLease(document);
      if (isTowerPgBackendMode()) {
        void this.hydrateSelectedDocWithRetry(recordId, { isCurrent })
          .then(async (fresh) => {
            await draftRestore;
            if (!fresh || fresh.record_id !== recordId || !isCurrent()) return;
            if (!this.docEditDraftDirty
              && this.docEditorTitle === openedTitle && this.docEditorContent === openedContent
              && !this.docLocalDraft
              && this.docEditAccessState !== 'acquiring'
              && this.docEditAccessState !== 'editing'
              && this.docEditAccessState !== 'recovery'
              && this.docAutosaveState !== 'saving'
              && isDocumentContentReadyForEditor(fresh)) {
              // Update the mounted editor in place. A cached prefetch response
              // must not destroy and lazily remount the editor we just opened.
              this.applySelectedDocAuthoritativeContent(fresh, { preserveSelection: true });
            }
            void this.loadSelectedDocRecoveries?.();
            this.markDocRead?.(recordId);
          })
          .catch((error) => console.warn('[flightdeck] PG document refresh failed after open', error));
      }
      void this.loadDocComments(recordId, {
        allowBackfill: options.allowCommentBackfill !== false,
        force: true,
      });
      if (!isTowerPgBackendMode() && document) this.markDocRead?.(recordId);
      if (options.ensureSync !== false) this.ensureBackgroundSync(true);
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      void Promise.resolve(window.Alpine?.nextTick?.()).then(() => {
        window.requestAnimationFrame(() => { setTimeout(() => { void reconcile(); }, 0); });
      });
    } else {
      void reconcile();
    }
  },

  async openAllDocuments() {
    this.closeDocEditor({ syncRoute: false });
    this.currentFolderId = null;
    this.docFilter = '';
    await this.selectBoard('__all__');
    this.navigateTo('docs');
  },

  async releaseSelectedDocLeaseWhenSafe(record, options = {}) {
    if (!record?.record_id) return false;
    if (options.draftPromise) await Promise.resolve(options.draftPromise).catch((error) => {
      this.docEditAccessMessage = `Local draft could not be saved: ${error?.message || error}`;
    });
    // A PG save owns the lease until Tower has accepted or rejected it. Wait for
    // the final save chained for this record before releasing the token.
    let pendingSave = this.pgDocSavePromises?.[record.record_id] || null;
    while (pendingSave) {
      await pendingSave.catch(() => {});
      const nextSave = this.pgDocSavePromises?.[record.record_id] || null;
      if (!nextSave || nextSave === pendingSave) break;
      pendingSave = nextSave;
    }
    if (isTowerPgBackendMode()) {
      return releasePgEditLeaseForRecord(this, record, 'document', {
        reportError: options.reportError === true,
      });
    }
    return this.releaseLockManagedCheckout(record, recordFamilyHash('document'), {
      reportError: options.reportError === true,
    });
  },

  handleDocEditLeaseLifecycleExit() {
    const record = this.selectedDocument;
    if (!record?.record_id) return false;
    const draftPromise = this.docEditDraftDirty
      ? this.persistSelectedDocDraft({ immediate: true })
      : null;
    this.cancelDocAutosave();
    this.cancelDocLocalDraftPersistence();
    if (isTowerPgBackendMode()) {
      // Stop renewal synchronously. If the authenticated request cannot finish
      // during a hard exit, Tower will expire the last 120-second lease.
      stopPgEditLeaseRenewal(this, record, 'document');
      this.docEditAccessState = 'ready';
      this.docRichEditorAdapter?.setEditable?.(false);
    }
    void this.releaseSelectedDocLeaseWhenSafe(record, { draftPromise, reportError: false });
    return true;
  },

  initDocEditLeaseLifecycle() {
    if (typeof window === 'undefined' || typeof document === 'undefined' || this.docEditLeaseLifecycleHandler) return;
    this.docEditLeaseLifecycleHandler = (event) => {
      if (event?.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
      this.handleDocEditLeaseLifecycleExit();
    };
    window.addEventListener('pagehide', this.docEditLeaseLifecycleHandler);
    document.addEventListener('visibilitychange', this.docEditLeaseLifecycleHandler, { passive: true });
  },

  closeDocEditor(options = {}) {
    const selectedRecord = this.selectedDocument;
    const draftPromise = this.docEditDraftDirty
      ? this.persistSelectedDocDraft({ immediate: true })
      : null;
    if (selectedRecord?.record_id) {
      void this.releaseSelectedDocLeaseWhenSafe(selectedRecord, { draftPromise, reportError: false });
    }
    this.stopDocCommentsLiveQuery();
    this.cancelDocAutosave();
    this.cancelDocLocalDraftPersistence();
    this.selectedDocType = null;
    this.selectedDocId = null;
    this.selectedDocCommentId = null;
    this.docComments = [];
    this.docCommentsVisible = false;
    this.docMobilePane = 'document';
    this.showDocCommentModal = false;
    this.docSelectedBlockId = null;
    this.clearPendingDocCommentAnchor();
    this.docCommentAnchorRevealState = null;
    this.newDocCommentBody = '';
    this.newDocCommentReplyBody = '';
    this.showDocShareModal = false;
    this.docVersioningOpen = false;
    this.docVersionHistory = [];
    this.docVersioningSelectedIndex = -1;
    this.docVersioningPreviewHtml = '';
    this.docVersioningError = null;
    this.docDiffMode = false;
    this.docDiffHunks = [];
    this.docDiffCompareIndex = -1;
    this.docDiffFromIndex = -1;
    this.docDiffToIndex = -1;
    this.docCommentBackfillAttemptsByDocId = {};
    this.clearDocCommentConnector();
    this.closeDocScopeModal?.();
    this.closeDocMoveModal?.();
    this.closeDocMoveScopePrompt?.();
    this.loadDocEditorFromSelection();
    if (options.preserveOrigin !== true) this.docDetailOriginRoute = '';
    if (options.syncRoute !== false) this.syncRoute();
  },

  async returnFromDoc() {
    const originRoute = String(this.docDetailOriginRoute || '').trim();
    const historyOrigin = typeof window !== 'undefined'
      ? String(window.history.state?.docDetailOriginRoute || '').trim()
      : '';
    this.closeDocEditor({ syncRoute: false, preserveOrigin: true });
    this.docDetailOriginRoute = '';
    if (originRoute && historyOrigin === originRoute && typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
      return;
    }
    if (typeof this.navigateTo === 'function') this.navigateTo('docs', { syncRoute: false });
    else this.navSection = 'docs';
    this.syncRoute?.(true);
  },

  loadDocEditorFromSelection(selectedItem = undefined) {
    const item = selectedItem === undefined ? this.selectedDocument : selectedItem;
    this.docShareQuery = '';
    this.docBacklinksOpen = false;
    this.destroyDocRichEditor?.();
    if (!item) {
      this.docEditorTitle = '';
      this.docEditorContent = '';
      this.docEditorShares = [];
      this.docEditorMode = 'preview';
      this.docEditAccessGeneration = Number(this.docEditAccessGeneration || 0) + 1;
      this.docEditAccessState = 'ready';
      this.docEditAccessMessage = '';
      this.docEditDraftDirty = false;
      this.docEditBaseRecordId = null;
      this.docEditBaseRowVersion = 0;
      this.docEditBaseVersionId = null;
      this.docEditBaseBodySha256Hex = null;
      this.docEditBaseStorageObjectId = null;
      this.docEditBaseAvailable = false;
      this.docEditConflict = null;
      this.docRecovery = null;
      this.docRecoveryActionState = '';
      this.docLocalDraft = null;
      this.docEditLeaseInfo = null;
      this.docEditorSharesDirty = false;
      this.docEditorBlocks = [];
      this.docEditingBlockIndex = -1;
      this.docBlockBuffer = '';
      this.docBlockEditorMinHeightPx = 0;
      this.docEditingTitle = false;
      this.docComments = [];
      this.docCommentsVisible = false;
      this.showDocCommentModal = false;
      this.docSelectedBlockId = null;
      this.clearPendingDocCommentAnchor();
      this.docCommentAnchorRevealState = null;
      this.newDocCommentBody = '';
      this.newDocCommentReplyBody = '';
      this.docAutosaveState = 'saved';
      this.showDocShareModal = false;
      this.docShareTargetType = '';
      this.docShareTargetId = '';
      this.docEditorProseMirrorState = null;
      this.docEditorContentModel = null;
      return;
    }

    this.docEditorTitle = item.title ?? '';
    this.docEditorContent = this.selectedDocType === 'document' ? (item.content ?? '') : '';
    const contentBlocks = this.selectedDocType === 'document'
      ? normalizeDocumentBlocks(item.content_blocks, this.docEditorContent)
      : [];
    this.docEditorShares = this.getEffectiveDocShares(item)
      .map((share) => ({ ...share }));
    this.docEditorMode = this.selectedDocType === 'document' && this.isTiptapDocsEditorEnabled()
      ? 'rich'
      : 'preview';
    this.docEditAccessGeneration = Number(this.docEditAccessGeneration || 0) + 1;
    this.docEditAccessState = isTowerPgBackendMode() && isUnsyncedLocalPgRecord(item)
      ? 'editing'
      : 'ready';
    this.docEditAccessMessage = '';
    this.docEditDraftDirty = false;
    const baseIdentity = documentEditorBaseIdentity(item);
    this.docEditBaseRecordId = item.record_id || null;
    this.docEditBaseRowVersion = Number(baseIdentity.base_row_version || 0);
    this.docEditBaseVersionId = baseIdentity.base_version_id;
    this.docEditBaseBodySha256Hex = baseIdentity.base_body_sha256_hex;
    this.docEditBaseStorageObjectId = baseIdentity.base_storage_object_id;
    this.docEditBaseAvailable = baseIdentity.base_available;
    this.docEditConflict = null;
    this.docRecovery = null;
    this.docRecoveryActionState = '';
    this.docLocalDraft = null;
    this.docEditLeaseInfo = null;
    this.docEditorSharesDirty = false;
    this.docEditorBlocks = contentBlocks;
    this.docEditorContent = assembleMarkdownBlocks(contentBlocks);
    if (this.selectedDocType === 'document') {
      const editorState = createDocumentEditorState(item);
      this.docEditorProseMirrorState = editorState.editorState;
      this.docEditorContentModel = editorState.contentModel;
    } else {
      this.docEditorProseMirrorState = null;
      this.docEditorContentModel = null;
    }
    this.docEditingBlockIndex = -1;
    this.docBlockBuffer = '';
    this.docBlockEditorMinHeightPx = 0;
    this.docEditingTitle = false;
    this.docSelectedBlockId = null;
    this.showDocCommentModal = false;
    this.clearPendingDocCommentAnchor();
    this.docCommentAnchorRevealState = null;
    this.newDocCommentBody = '';
    this.newDocCommentReplyBody = '';
    this.docAutosaveState = 'saved';
    this.showDocShareModal = false;
    this.docShareTargetType = '';
    this.docShareTargetId = '';
    this.scheduleDocCommentConnectorUpdate();
    this.scheduleStorageImageHydration();
    const restoreGeneration = Number(this.docEditAccessGeneration || 0);
    this.docDraftRestorePromise = this.restoreSelectedDocDraft(item, { generation: restoreGeneration });
    void this.docDraftRestorePromise.catch((error) => {
      if (this.selectedDocId === item.record_id && this.docEditAccessGeneration === restoreGeneration) {
        this.error = `Local draft could not be restored: ${error?.message || error}`;
      }
    });
  },

  async hydrateSelectedDocWithRetry(recordId, options = {}) {
    const targetId = String(recordId || '').trim();
    if (!targetId || !isTowerPgBackendMode()) return null;
    const delays = Array.isArray(options.delays) ? options.delays : DOCUMENT_BODY_RETRY_DELAYS_MS;
    const isCurrent = options.isCurrent || (() => this.selectedDocType === 'document' && this.selectedDocId === targetId);
    let latest = null;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      const delay = Number(delays[attempt]) || 0;
      if (delay > 0) await waitForDocumentRetry(delay);
      if (!isCurrent()) return null;
      try {
        latest = typeof this.prefetchFlightDeckDoc === 'function'
          ? await (attempt > 0
              ? this.prefetchFlightDeckDoc(targetId, { force: true })
              : this.prefetchFlightDeckDoc(targetId))
          : await this.requestTowerSyncFamily?.('document', targetId, { force: true });
      } catch (error) {
        latest = null;
        if (attempt === delays.length - 1) {
          console.warn('[flightdeck] PG document body hydration exhausted retries', error);
        }
      }
      if (!isCurrent()) return null;
      const row = latest || this.documents.find((candidate) => candidate.record_id === targetId) || null;
      if (isDocumentContentReadyForEditor(row)) return row;
    }
    let stalled = this.documents.find((candidate) => candidate.record_id === targetId) || latest;
    if (stalled && isCurrent()) {
      const failed = {
        ...stalled,
        content_storage_status: 'error',
        content_storage_error: stalled.content_storage_error || 'Complete document body did not load after retrying.',
      };
      await upsertDocument(failed);
      if (!isCurrent()) return null;
      this.patchDocumentLocal?.(failed);
      this.docEditAccessMessage = 'The complete Tower body could not be loaded. Edits can still be saved safely as a recovery draft.';
      stalled = failed;
    }
    return stalled || null;
  },

  getSelectedDocWorkspaceId(item = this.selectedDocument) {
    return String(
      item?.pg_workspace_id
      || resolveTowerPgWorkspaceContext(this)?.workspaceId
      || this.workspaceOwnerNpub
      || '',
    ).trim();
  },

  setSelectedDocBaseIdentity(identity = {}) {
    this.docEditBaseRowVersion = Number(identity.row_version ?? identity.base_row_version ?? 0) || 0;
    this.docEditBaseVersionId = String(identity.version_id ?? identity.base_version_id ?? '').trim() || null;
    this.docEditBaseBodySha256Hex = String(identity.body_sha256_hex ?? identity.base_body_sha256_hex ?? '').trim() || null;
    this.docEditBaseStorageObjectId = String(identity.storage_object_id ?? identity.base_storage_object_id ?? '').trim() || null;
    this.docEditBaseAvailable = identity.base_available !== false
      && this.docEditBaseRowVersion > 0
      && Boolean(this.docEditBaseBodySha256Hex);
  },

  buildSelectedDocDraftRow(options = {}) {
    const item = this.selectedDocument;
    const workspaceId = this.getSelectedDocWorkspaceId(item);
    if (!item?.record_id || !workspaceId) return null;
    // Source and block edits must rebuild from their current input. A retained
    // rich model belongs to the previous editor mode and can be stale.
    const contentModel = this.docEditorMode === 'rich'
      ? (this.docRichEditorAdapter?.getContentModel?.() || this.docEditorContentModel || this.buildSelectedDocContentModel())
      : this.buildSelectedDocContentModel();
    const dirtyAt = this.docLocalDraft?.dirty_at || new Date().toISOString();
    return {
      ...(this.docLocalDraft || {}),
      workspace_id: workspaceId,
      document_id: item.record_id,
      editor_mode: this.docEditorMode,
      title: this.docEditorTitle,
      content: contentModel?.content ?? this.docEditorContent ?? '',
      content_format: contentModel?.content_format ?? null,
      content_blocks: Array.isArray(contentModel?.content_blocks) ? contentModel.content_blocks : [],
      editor_state: contentModel?.editor_state || this.docEditorProseMirrorState || null,
      editor_state_format: contentModel?.editor_state_format ?? null,
      editor_state_version: contentModel?.editor_state_version ?? null,
      base_available: this.docEditBaseAvailable === true,
      base_row_version: Number(this.docEditBaseRowVersion || 0) || null,
      base_version_id: this.docEditBaseVersionId || null,
      base_body_sha256_hex: this.docEditBaseBodySha256Hex || null,
      base_storage_object_id: this.docEditBaseStorageObjectId || null,
      dirty_at: dirtyAt,
      draft_status: options.status || (this.docEditDraftDirty ? 'dirty' : (this.docRecovery ? 'recovery' : 'dirty')),
      recovery_id: this.docRecovery?.id || this.docLocalDraft?.recovery_id || null,
      recovery: this.docRecovery || this.docLocalDraft?.recovery || null,
      current_head: this.docEditConflict?.currentHead || this.docLocalDraft?.current_head || null,
      last_remote_save_outcome: options.remoteOutcome || this.docLocalDraft?.last_remote_save_outcome || null,
      submitted_storage_object_id: options.submittedStorageObjectId || this.docLocalDraft?.submitted_storage_object_id || null,
      submitted_body_sha256_hex: options.submittedBodySha256Hex || this.docLocalDraft?.submitted_body_sha256_hex || null,
      integrity_error: options.integrityError || null,
      updated_at: new Date().toISOString(),
    };
  },

  async persistSelectedDocDraft(options = {}) {
    const row = this.buildSelectedDocDraftRow(options);
    if (!row) return null;
    const persisted = await upsertDocumentDraft(row);
    if (this.selectedDocId === row.document_id && this.getSelectedDocWorkspaceId() === row.workspace_id) {
      this.docLocalDraft = persisted;
    }
    return persisted;
  },

  scheduleDocLocalDraftPersistence() {
    if (!this.selectedDocument?.record_id) return;
    if (this.docLocalDraftTimer) clearTimeout(this.docLocalDraftTimer);
    this.docLocalDraftTimer = setTimeout(async () => {
      this.docLocalDraftTimer = null;
      await this.persistSelectedDocDraft().catch((error) => {
        this.docEditAccessMessage = `Local draft could not be saved: ${error?.message || error}`;
      });
    }, DOCUMENT_LOCAL_DRAFT_DELAY_MS);
  },

  cancelDocLocalDraftPersistence() {
    if (this.docLocalDraftTimer) clearTimeout(this.docLocalDraftTimer);
    this.docLocalDraftTimer = null;
  },

  async clearSelectedDocDraft(item = this.selectedDocument) {
    const workspaceId = this.getSelectedDocWorkspaceId(item);
    if (!workspaceId || !item?.record_id) return false;
    this.cancelDocLocalDraftPersistence();
    await deleteDocumentDraft(workspaceId, item.record_id);
    if (this.selectedDocId === item.record_id) this.docLocalDraft = null;
    return true;
  },

  async restoreSelectedDocDraft(item = this.selectedDocument, options = {}) {
    if (!item?.record_id) return null;
    const workspaceId = this.getSelectedDocWorkspaceId(item);
    if (!workspaceId) return null;
    if (this.docEditDraftDirty) return null;
    const title = this.docEditorTitle;
    const content = this.docEditorContent;
    const draft = await getDocumentDraft(workspaceId, item.record_id);
    if (!draft) return null;
    if (Number(options.generation || 0) !== Number(this.docEditAccessGeneration || 0)) return null;
    if (this.selectedDocId !== item.record_id || draft.workspace_id !== workspaceId || draft.document_id !== item.record_id) return null;
    if (workspaceId !== this.getSelectedDocWorkspaceId() || this.docEditDraftDirty
      || title !== this.docEditorTitle || content !== this.docEditorContent) return null;

    const head = documentEditorBaseIdentity(item);
    const sameBase = draftBaseMatchesHead(draft, head);
    const draftAlreadyCanonical = sameBase
      && !draft.recovery_id
      && isDocumentContentReadyForEditor(item)
      && String(draft.title || item.title || 'Untitled document') === String(item.title || 'Untitled document')
      && String(draft.content || '') === String(item.content || '')
      && (!draft.editor_state || JSON.stringify(draft.editor_state) === JSON.stringify(item.editor_state));
    if (draftAlreadyCanonical) {
      this.docEditDraftDirty = false;
      this.docAutosaveState = 'saved';
      this.docEditConflict = null;
      this.docRecovery = null;
      this.docEditAccessMessage = '';
      await this.clearSelectedDocDraft(item);
      return null;
    }
    const contentModel = {
      content: String(draft.content || ''),
      content_format: draft.content_format || null,
      content_blocks: Array.isArray(draft.content_blocks) ? draft.content_blocks : [],
      editor_state: draft.editor_state || null,
      editor_state_format: draft.editor_state_format || null,
      editor_state_version: draft.editor_state_version || null,
    };
    const editorState = createDocumentEditorState(contentModel);
    this.docEditorTitle = draft.title || item.title || 'Untitled document';
    this.docEditorContent = contentModel.content;
    this.docEditorBlocks = normalizeDocumentBlocks(contentModel.content_blocks, contentModel.content);
    this.docEditorProseMirrorState = editorState.editorState;
    this.docEditorContentModel = editorState.contentModel;
    this.docRichEditorAdapter?.setContent?.(editorState.editorState, { emitUpdate: false, preserveSelection: false });
    this.docLocalDraft = draft;
    this.docRecovery = draft.recovery || null;
    this.setSelectedDocBaseIdentity({
      base_available: draft.base_available,
      base_row_version: draft.base_row_version,
      base_version_id: draft.base_version_id,
      base_body_sha256_hex: draft.base_body_sha256_hex,
      base_storage_object_id: draft.base_storage_object_id,
    });
    this.docEditDraftDirty = draft.draft_status !== 'recovery';
    this.docAutosaveState = this.docEditDraftDirty ? 'pending' : 'saved';
    if (!sameBase || draft.recovery_id) {
      this.docEditConflict = {
        baseVersion: Number(draft.base_row_version || 0),
        currentVersion: Number(head.base_row_version || 0),
        currentHead: head,
      };
      this.docEditAccessState = 'recovery';
      this.docEditAccessMessage = draft.recovery_id
        ? 'A recovery version is preserved in Tower. Continue editing it, promote it optimistically, or discard it.'
        : 'Tower advanced from this draft’s base. The draft is preserved locally and will save only as a recovery version.';
      this.docRichEditorAdapter?.setEditable?.(true);
    } else if (this.docEditDraftDirty) {
      this.docEditAccessMessage = '';
      if (isSyncedPgRecord(item)) void this.beginSelectedDocLeaseAcquisition();
    }
    if (this.docEditDraftDirty) this.scheduleDocAutosave();
    return draft;
  },

  isTiptapDocsEditorEnabled() {
    return shouldUseRichDocumentEditor(this.selectedDocument || {}, {
      enabled: this.docEditorRichFeatureEnabled === true,
    });
  },

  destroyDocRichEditor() {
    this.docRichEditorMountGeneration = Number(this.docRichEditorMountGeneration || 0) + 1;
    this.docRichEditorAdapter?.destroy?.();
    this.docRichEditorAdapter = null;
    this.docRichEditorMountEl = null;
  },

  getVisibleDocRichEditorText() {
    const editors = [...(this.docRichEditorMountEl?.querySelectorAll?.('.ProseMirror') || [])];
    return editors
      .map(visibleWikiIntegrityText)
      .sort((left, right) => right.length - left.length)[0] || '';
  },

  syncDocRichEditorContentModel(contentModel = null) {
    const model = contentModel || this.docRichEditorAdapter?.getContentModel?.() || null;
    if (!hasProseMirrorContentModel(model)) return null;
    this.docEditorContentModel = model;
    this.docEditorProseMirrorState = model.editor_state;
    this.docEditorContent = model.content || '';
    this.docEditorBlocks = normalizeDocumentBlocks(model.content_blocks, model.content);
    return model;
  },

  applySelectedDocAuthoritativeContent(item = null, options = {}) {
    if (!item || item.record_id !== this.selectedDocId) return false;
    const contentBlocks = normalizeDocumentBlocks(item.content_blocks, item.content);
    const editorState = createDocumentEditorState(item);
    this.docEditorTitle = item.title ?? '';
    this.docEditorShares = this.getEffectiveDocShares(item).map((share) => ({ ...share }));
    this.docEditorSharesDirty = false;
    this.docEditorBlocks = contentBlocks;
    this.docEditorContent = assembleMarkdownBlocks(contentBlocks);
    this.docRichEditorAdapter?.setContent?.(editorState.editorState, {
      emitUpdate: false,
      preserveSelection: options.preserveSelection !== false,
    });
    this.docEditorProseMirrorState = editorState.editorState;
    this.docEditorContentModel = editorState.contentModel;
    this.docEditingBlockIndex = -1;
    this.docSelectedBlockId = null;
    this.docBlockBuffer = '';
    this.docBlockEditorMinHeightPx = 0;
    this.docEditingTitle = false;
    this.docEditDraftDirty = false;
    this.docEditBaseRecordId = item.record_id;
    this.setSelectedDocBaseIdentity(documentEditorBaseIdentity(item));
    this.docEditConflict = null;
    this.docRecovery = null;
    this.docAutosaveState = 'saved';
    this.scheduleDocCommentConnectorUpdate();
    this.scheduleStorageImageHydration();
    return true;
  },

  buildSelectedDocContentModel() {
    if (this.docEditorMode === 'rich') {
      const synced = this.syncDocRichEditorContentModel();
      if (synced) {
        const bound = bindWikiState(synced.editor_state, this.documents, this.selectedDocument?.pg_channel_id);
        return bound === synced.editor_state ? synced : prosemirrorToFlightDeckContentModel(bound);
      }
    }
    const editorBlocks = this.docEditorBlocks?.length > 0
      ? this.docEditorBlocks
      : normalizeDocumentBlocks(this.selectedDocument?.content_blocks, this.selectedDocument?.content);
    const blockContent = assembleMarkdownBlocks(editorBlocks);
    const editorContent = this.docEditorMode === 'source'
      ? (this.docEditorContent ?? '')
      : (blockContent || this.docEditorContent || this.selectedDocument?.content || '');
    const editorState = createDocumentEditorState({
      ...(this.selectedDocument || {}),
      content: editorContent,
      content_blocks: editorBlocks,
      editor_state: null,
    });
    const bound = bindWikiState(editorState.editorState, this.documents, this.selectedDocument?.pg_channel_id);
    const boundModel = bound === editorState.editorState ? editorState.contentModel : prosemirrorToFlightDeckContentModel(bound);
    this.docEditorProseMirrorState = boundModel.editor_state;
    this.docEditorContentModel = boundModel;
    return boundModel;
  },

  refreshProseMirrorStateFromCompatibility() {
    if (this.selectedDocument?.content_format !== FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT) return null;
    const editorState = createDocumentEditorState({
      ...(this.selectedDocument || {}),
      content: this.docEditorContent,
      content_blocks: this.docEditorBlocks,
      editor_state: null,
    });
    const bound = bindWikiState(editorState.editorState, this.documents, this.selectedDocument?.pg_channel_id);
    const boundModel = bound === editorState.editorState ? editorState.contentModel : prosemirrorToFlightDeckContentModel(bound);
    this.docEditorProseMirrorState = boundModel.editor_state;
    this.docEditorContentModel = boundModel;
    return boundModel;
  },

  async mountDocRichEditor(element = null) {
    if (!element || this.docEditorMode !== 'rich') return;
    if (this.docRichEditorAdapter && this.docRichEditorMountEl === element) return;
    if (this.docRichEditorMountPromise && this.docRichEditorMountEl === element) {
      return this.docRichEditorMountPromise;
    }
    this.destroyDocRichEditor();
    const sourceDoc = {
      ...(this.selectedDocument || {}),
      content: this.docEditorContent,
      content_blocks: this.docEditorBlocks,
      editor_state: this.docEditorProseMirrorState,
    };
    this.docRichEditorMountEl = element;
    const mountGeneration = this.docRichEditorMountGeneration;
    const mountPromise = (async () => {
      const { createTiptapEditorAdapter } = await loadTiptapEditorAdapter();
      if (this.docRichEditorMountGeneration !== mountGeneration
        || this.docRichEditorMountEl !== element
        || this.docEditorMode !== 'rich') return;
      this.docRichEditorAdapter = createTiptapEditorAdapter({
        element,
        document: sourceDoc,
        editorState: this.docEditorProseMirrorState,
        editable: this.isSelectedDocRichEditorEditable(),
        wiki: {
          pages: () => this.wikiPages,
          isBusy: () => this.wikiCreateBusy,
          isEditing: () => ['ready', 'acquiring', 'editing', 'recovery'].includes(this.docEditAccessState),
          resolve: (attrs) => this.resolveDocWikiLink(attrs),
          open: (id) => { void this.followDocWikiLink(id); },
          create: (title, range, editor) => this.createDocWikiPage(title, range, editor),
          error: (message) => { this.error = message; },
        },
        onEditIntent: (intent) => intent === 'input' && this.handleDocRichEditIntent(),
        onPaste: (event, editor) => this.handleDocRichPaste?.(event, editor) === true,
        onUpdate: (contentModel) => {
          this.syncDocRichEditorContentModel(contentModel);
          this.handleDocRichEditorUpdate();
        },
      });
      this.syncDocRichEditorContentModel();
      this.scheduleStorageImageHydration?.();
    })();
    this.docRichEditorMountPromise = mountPromise;
    try {
      return await mountPromise;
    } finally {
      if (this.docRichEditorMountPromise === mountPromise) this.docRichEditorMountPromise = null;
    }
  },

  isSelectedDocRichEditorEditable() {
    const item = this.selectedDocument;
    if (!item) return false;
    if (!isTowerPgBackendMode()) {
      return isCheckoutHeld(this.getSelectedDocCheckoutSession()?.checkout);
    }
    if (!isSyncedPgRecord(item)) return true;
    if (!isDocumentContentReadyForEditor(item)
      && !['error'].includes(String(item.content_storage_status || ''))
      && !this.docLocalDraft) return false;
    return ['ready', 'acquiring', 'editing', 'recovery'].includes(String(this.docEditAccessState || 'ready'));
  },

  isSelectedDocContentReadyForEditor() {
    const item = this.selectedDocument;
    return Boolean(item && isDocumentContentReadyForEditor(item));
  },

  isSelectedDocDraftReadyForPersistence() {
    const item = this.selectedDocument;
    if (!item) return false;
    if (isDocumentContentReadyForEditor(item)) return true;
    if (this.docLocalDraft) return true;
    return item.content_storage_status === 'error';
  },

  handleDocRichEditorUpdate() {
    this.docEditDraftDirty = true;
    this.scheduleDocLocalDraftPersistence();
    if (this.docEditAccessState === 'recovery') {
      this.scheduleDocAutosave();
      return;
    }
    if (this.docEditAccessState === 'ready') void this.handleDocRichEditIntent();
    if (this.docEditAccessState === 'editing') this.scheduleDocAutosave();
  },

  handleDocRichEditIntent() {
    const item = this.selectedDocument;
    if (!item || this.docEditorMode !== 'rich') return false;
    if (!isTowerPgBackendMode()) {
      if (!isCheckoutHeld(this.getSelectedDocCheckoutSession()?.checkout)) {
        void this.enterSelectedDocEditMode('rich');
      }
      return true;
    }
    if (!isSyncedPgRecord(item)) {
      this.docEditAccessState = 'editing';
      return true;
    }
    if (this.docEditAccessState === 'recovery') return true;
    if (!isDocumentContentReadyForEditor(item) && item.content_storage_status !== 'error') return false;
    if (this.docEditAccessState === 'editing' || this.docEditAccessState === 'acquiring') return true;
    if (this.docEditAccessState === 'blocked' || this.docEditAccessState === 'conflict') return false;
    void this.beginSelectedDocLeaseAcquisition();
    return true;
  },

  async inspectSelectedDocEditLease(record = this.selectedDocument) {
    if (!isTowerPgBackendMode() || !isSyncedPgRecord(record)) return null;
    const recordId = String(record?.record_id || '').trim();
    const generation = Number(this.docEditAccessGeneration || 0);
    const session = await inspectPgEditLeaseForRecord(this, record, 'document');
    if (this.selectedDocId !== recordId || Number(this.docEditAccessGeneration || 0) !== generation) return null;
    this.docEditLeaseInfo = session?.inspectedLease || null;
    if (session?.inspectionState === 'offline' && this.docEditAccessState === 'ready') {
      this.docEditAccessMessage = 'Drafts need a connection before edit access can be acquired.';
    }
    return session;
  },

  async beginSelectedDocLeaseAcquisition(options = {}) {
    const item = this.selectedDocument;
    if (!item) return false;
    if (!isTowerPgBackendMode() || !isSyncedPgRecord(item)) {
      return this.enterSelectedDocEditMode(options.mode || 'rich');
    }
    if (!isDocumentContentReadyForEditor(item) && item.content_storage_status === 'error') {
      this.docEditBaseAvailable = false;
      this.docEditAccessState = 'recovery';
      this.docEditAccessMessage = 'The complete base is unavailable. Edits stay local and save to Tower only as a non-head recovery version.';
      this.docRichEditorAdapter?.setEditable?.(true);
      this.scheduleDocLocalDraftPersistence();
      return true;
    }
    if (!isDocumentContentReadyForEditor(item)) {
      this.docEditAccessMessage = 'Loading the complete document before editing…';
      this.docRichEditorAdapter?.setEditable?.(false);
      return false;
    }
    if (this.docEditAccessState === 'editing') return true;
    const recordId = String(item.record_id || '');
    if (this.docEditAcquirePromise && this.docEditAcquirePromiseRecordId === recordId) {
      return this.docEditAcquirePromise;
    }
    const generation = Number(this.docEditAccessGeneration || 0);
    this.docEditAccessState = 'acquiring';
    this.docEditAccessMessage = 'Acquiring edit access…';
    this.error = null;
    this.docRichEditorAdapter?.setEditable?.(true);
    const promise = (async () => {
      const acquired = await this.acquireSelectedDocCheckout({ reportError: false });
      const stillSelected = this.selectedDocId === recordId
        && Number(this.docEditAccessGeneration || 0) === generation;
      if (!stillSelected) {
        if (acquired) await releasePgEditLeaseForRecord(this, item, 'document', { reportError: false });
        return false;
      }
      if (!acquired) {
        const session = getPgEditLeaseSession(this, 'document', recordId);
        this.docEditAccessState = 'blocked';
        this.docEditAccessMessage = session?.message || 'Draft preserved — edit access unavailable';
        this.docEditLeaseInfo = session?.blockedLease || session?.inspectedLease || null;
        this.docRichEditorAdapter?.setEditable?.(false);
        this.cancelDocAutosave();
        return false;
      }
      this.docEditAccessState = 'editing';
      this.docEditAccessMessage = '';
      this.docEditLeaseInfo = getPgEditLeaseSession(this, 'document', recordId)?.lease || null;
      this.docRichEditorAdapter?.setEditable?.(true);
      startPgEditLeaseRenewal(this, item, 'document');
      if (this.docEditDraftDirty) this.scheduleDocAutosave();
      return true;
    })();
    this.docEditAcquirePromise = promise;
    this.docEditAcquirePromiseRecordId = recordId;
    try {
      return await promise;
    } finally {
      if (this.docEditAcquirePromise === promise) {
        this.docEditAcquirePromise = null;
        this.docEditAcquirePromiseRecordId = null;
      }
    }
  },

  retrySelectedDocEditAccess() {
    if (this.docEditAccessState === 'conflict' || this.docEditAccessState === 'recovery') return false;
    this.docEditAccessState = 'ready';
    this.docEditAccessMessage = '';
    this.docRichEditorAdapter?.setEditable?.(true);
    void this.beginSelectedDocLeaseAcquisition();
    return true;
  },

  async copySelectedDocDraft() {
    const content = this.docRichEditorAdapter?.getContentModel?.()?.content || this.docEditorContent || '';
    try {
      await globalThis.navigator?.clipboard?.writeText?.(content);
      this.docEditAccessMessage = 'Draft copied to clipboard.';
      return true;
    } catch {
      this.docEditAccessMessage = 'Could not copy automatically. Select the draft and copy it manually.';
      return false;
    }
  },

  async discardSelectedDocDraft() {
    const item = this.selectedDocument;
    if (!item) return false;
    this.cancelDocAutosave();
    this.cancelDocLocalDraftPersistence();
    try {
      const deleted = await this.clearSelectedDocDraft(item);
      if (!deleted) throw new Error('local recovery storage is unavailable');
    } catch (error) {
      this.docEditAccessMessage = `Local draft could not be discarded: ${error?.message || error}`;
      return false;
    }
    if (this.selectedDocId !== item.record_id) return false;

    let authoritative = item;
    if (isTowerPgBackendMode() && isSyncedPgRecord(item)) {
      authoritative = await this.hydrateSelectedDocWithRetry(item.record_id, { delays: [0] }) || this.selectedDocument || item;
    }
    if (this.selectedDocId !== item.record_id) return false;

    this.applySelectedDocAuthoritativeContent(authoritative, { preserveSelection: false });
    this.docLocalDraft = null;
    this.docEditAccessState = 'ready';
    this.docEditAccessMessage = '';

    if (isTowerPgBackendMode() && isSyncedPgRecord(authoritative)) {
      clearPgEditLeaseSession(this, 'document', item.record_id);
      const session = await this.inspectSelectedDocEditLease(authoritative);
      if (this.selectedDocId !== item.record_id) return false;
      if (session?.inspectedLease) {
        this.docEditAccessState = 'blocked';
        // Let the derived status render the freshly inspected owner and expiry.
        this.docEditAccessMessage = '';
      }
    }
    this.docRichEditorAdapter?.setEditable?.(this.isSelectedDocRichEditorEditable());
    return true;
  },

  observeSelectedDocAuthoritativeVersion() {
    const item = this.selectedDocument;
    if (!item || item.record_id !== this.docEditBaseRecordId) return false;
    const currentVersion = Number(item.version || 0);
    const baseVersion = Number(this.docEditBaseRowVersion || 0);
    if (currentVersion <= baseVersion) return false;
    if (!this.docEditDraftDirty) {
      if (!isDocumentContentReadyForEditor(item)) return false;
      return this.applySelectedDocAuthoritativeContent(item, { preserveSelection: true });
    }
    if (!['conflict', 'recovery'].includes(this.docEditAccessState)) {
      this.docEditConflict = {
        baseVersion,
        currentVersion,
        currentHead: documentEditorBaseIdentity(item),
      };
      this.docEditAccessState = 'recovery';
      this.docEditAccessMessage = 'Tower has a newer head. Your editor remains available and the next save will preserve this draft as a recovery version.';
      this.docRichEditorAdapter?.setEditable?.(true);
      this.scheduleDocLocalDraftPersistence();
      this.scheduleDocAutosave();
      void releasePgEditLeaseForRecord(this, item, 'document', { reportError: false });
      return true;
    }
    return false;
  },

  acceptSelectedPgDocSaveCanonical(accepted, submittedDocument = null) {
    if (!accepted?.record_id) return accepted;
    const canonical = PG_DOCUMENT_ACCEPTED_CONTENT_FIELDS.reduce((row, field) => {
      if (submittedDocument && Object.prototype.hasOwnProperty.call(submittedDocument, field)) {
        row[field] = submittedDocument[field];
      }
      return row;
    }, { ...accepted });
    canonical.sync_status = 'synced';
    canonical.content_storage_status = canonical.content_storage_object_id ? 'remote' : null;
    canonical.content_storage_error = null;
    const canonicalIdentity = {
      row_version: canonical.version || canonical.row_version,
      version_id: canonical.pg_canonical_version_id,
      storage_object_id: canonical.pg_canonical_storage_object_id || canonical.content_storage_object_id,
      body_sha256_hex: canonical.pg_canonical_body_sha256_hex || canonical.content_sha256_hex,
    };

    const acceptedVersion = Number(canonical.version || canonical.row_version || 0);
    const selected = this.selectedDocument;
    const isSelectedSave = String(this.selectedDocId || '') === String(canonical.record_id)
      && String(this.docEditBaseRecordId || '') === String(canonical.record_id);
    const selectedVersion = Number(selected?.version || selected?.row_version || 0);

    // This hook runs synchronously after PATCH resolves and before the workspace
    // command reconciles its acknowledgement into Dexie. Advance the editor base
    // first so Alpine cannot classify our own N+1 acknowledgement as external.
    if (isSelectedSave && selectedVersion <= acceptedVersion) {
      const submittedTitle = submittedDocument?.title || canonical.title || 'Untitled document';
      const submittedContent = submittedDocument?.content || canonical.content || '';
      const currentTitle = this.docEditorTitle.trim() || 'Untitled document';
      const currentContentModel = this.buildSelectedDocContentModel();
      const hasFollowupChanges = currentTitle !== submittedTitle
        || (currentContentModel.content || '') !== submittedContent;
      this.setSelectedDocBaseIdentity(canonicalIdentity);
      this.docEditConflict = null;
      this.docRecovery = null;
      this.docEditDraftDirty = hasFollowupChanges;
    }

    this.patchDocumentLocal?.(canonical);
    return canonical;
  },

  async loadDocComments(docId, options = {}) {
    if (!docId) {
      this.applyDocComments([]);
      return;
    }
    if (isTowerPgBackendMode()) {
      this.startDocCommentsLiveQuery(docId);
      try {
        await this.requestTowerSyncFamily?.('document-comments', docId, {
          force: options.force === true,
        });
      } catch (error) {
        this.error = error?.message || 'Failed to load PG document comments.';
      }
      return;
    }
    this.startDocCommentsLiveQuery(docId);
    const documentFamilyHash = recordFamilyHash('document');
    let comments = (await getCommentsByTarget(docId))
      .filter((comment) => comment.target_record_family_hash === documentFamilyHash);

    if (
      options.allowBackfill !== false
      && (comments.length === 0 || await this.hasMissingDocCommentAudio(comments))
      && !this.docCommentBackfillAttemptsByDocId[docId]
    ) {
      this.docCommentBackfillAttemptsByDocId = {
        ...this.docCommentBackfillAttemptsByDocId,
        [docId]: true,
      };
      comments = await this.backfillDocCommentsFromBackend(docId, documentFamilyHash);
    }

    await this.applyDocComments(comments);
  },

  async applyDocComments(comments = [], options = {}) {
    const nextComments = Array.isArray(comments) ? comments : [];
    if (!sameListBySignature(this.docComments, nextComments, (comment) => [
      String(comment?.record_id || ''),
      String(comment?.updated_at || ''),
      String(comment?.version ?? ''),
      String(comment?.record_state || ''),
    ].join('|'))) {
      this.docComments = nextComments;
    }

    for (const comment of nextComments) {
      await this.rememberPeople([comment.sender_npub], 'doc-comment');
    }

    if (
      options.allowBackfill
      && this.selectedDocType === 'document'
      && this.selectedDocId
      && !this.docCommentBackfillAttemptsByDocId[this.selectedDocId]
      && (nextComments.length === 0 || await this.hasMissingDocCommentAudio(nextComments))
    ) {
      this.docCommentBackfillAttemptsByDocId = {
        ...this.docCommentBackfillAttemptsByDocId,
        [this.selectedDocId]: true,
      };
      const backfilled = await this.backfillDocCommentsFromBackend(this.selectedDocId, recordFamilyHash('document'));
      if (backfilled.length > 0) {
        await this.applyDocComments(backfilled);
        return;
      }
    }

    if (this.selectedDocCommentId) {
      const rootId = this.getDocCommentThreadId(this.selectedDocCommentId);
      this.selectedDocCommentId = nextComments.some((comment) => comment.record_id === rootId) ? rootId : null;
    }
    this.scheduleDocCommentConnectorUpdate();
    this.scheduleStorageImageHydration();
    if (typeof this.refreshReactionsForVisibleTargets === 'function') {
      this.refreshReactionsForVisibleTargets().catch(() => {});
    }
  },

  async hasMissingDocCommentAudio(comments = []) {
    for (const comment of comments) {
      for (const attachment of comment.attachments || []) {
        if (attachment?.kind !== 'audio' || !attachment?.audio_note_record_id) continue;
        const note = await getAudioNoteById(attachment.audio_note_record_id);
        if (!note || note.record_state === 'deleted') return true;
      }
    }
    return false;
  },

  async backfillDocCommentsFromBackend(docId, documentFamilyHash) {
    if (!this.backendUrl || !this.workspaceOwnerNpub || !this.session?.npub) return [];

    try {
      const result = await this.pullFamiliesFromBackend(['comment', 'audio_note'], { forceFull: true });
      const comments = (await getCommentsByTarget(docId))
        .filter((comment) => comment.target_record_family_hash === documentFamilyHash);
      if (comments.length === 0 && Number(result?.quarantined || 0) > 0) {
        this.error = `${result.quarantined} comment/audio record${result.quarantined === 1 ? '' : 's'} could not be restored locally. Open sync repair for quarantined records.`;
        if (typeof this.refreshSyncQuarantine === 'function') {
          await this.refreshSyncQuarantine();
        }
        await this.refreshSyncStatus?.();
      }
      return comments;
    } catch (error) {
      const message = error?.message || String(error);
      this.error = `Doc comment backfill failed: ${message}`;
      console.debug('Doc comment backfill failed:', message);
      return [];
    }
  },

  getDocCommentById(commentId) {
    if (!commentId) return null;
    return this.docComments.find((comment) => comment.record_id === commentId) ?? null;
  },

  getDocCommentThreadId(commentId) {
    let current = this.getDocCommentById(commentId);
    while (current?.parent_comment_id) {
      const parent = this.getDocCommentById(current.parent_comment_id);
      if (!parent) break;
      current = parent;
    }
    return current?.record_id || commentId || null;
  },

  getRootDocComments() {
    return this.docComments
      .filter((comment) => !comment.parent_comment_id && comment.record_state !== 'deleted')
      .sort((a, b) => this.compareDocCommentsByAnchor(a, b));
  },

  getDocCommentReplies(commentId) {
    const rootId = String(commentId || '').trim();
    if (!rootId) return [];
    const childrenByParentId = new Map();
    for (const comment of this.docComments) {
      const parentId = String(comment?.parent_comment_id || '').trim();
      if (!parentId || comment.record_state === 'deleted') continue;
      const children = childrenByParentId.get(parentId) || [];
      children.push(comment);
      childrenByParentId.set(parentId, children);
    }
    for (const children of childrenByParentId.values()) {
      children.sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
    }

    const replies = [];
    const visited = new Set([rootId]);
    const appendChildren = (parentId) => {
      for (const child of childrenByParentId.get(parentId) || []) {
        if (visited.has(child.record_id)) continue;
        visited.add(child.record_id);
        replies.push(child);
        appendChildren(child.record_id);
      }
    };
    appendChildren(rootId);
    return replies;
  },

  getDocCommentReplyDepth(commentId, rootId) {
    const targetId = String(commentId || '').trim();
    const threadRootId = String(rootId || '').trim();
    if (!targetId || !threadRootId) return 0;
    let current = this.getDocCommentById(targetId);
    let depth = 0;
    const visited = new Set([targetId]);
    while (current?.parent_comment_id) {
      const parentId = String(current.parent_comment_id).trim();
      depth += 1;
      if (parentId === threadRootId) return depth;
      if (visited.has(parentId)) return 0;
      visited.add(parentId);
      current = this.getDocCommentById(parentId);
    }
    return 0;
  },

  getDocCommentAnchorLabel(comment = null) {
    const line = Number(comment?.anchor_line_number);
    const endLine = Number(comment?.anchor_end_line_number ?? comment?.pg_metadata?.anchor_end_line_number);
    if (!Number.isFinite(line) || line <= 0) return 'General';
    return Number.isFinite(endLine) && endLine > line ? `Lines ${line}–${endLine}` : `Line ${line}`;
  },

  getDocCommentAnchorQuote(comment = null) {
    return String(comment?.anchor_quote ?? comment?.pg_metadata?.anchor_quote ?? '');
  },

  clearPendingDocCommentAnchor() {
    this.docCommentAnchorLine = null;
    this.docCommentAnchorEndLine = null;
    this.docCommentAnchorBlockId = null;
    this.docCommentAnchorQuote = '';
    this.docCommentAnchorStartOffset = null;
    this.docCommentAnchorEndOffset = null;
  },

  applyPendingRichDocCommentAnchor(anchor = null) {
    if (!anchor?.anchor_quote) return false;
    this.docCommentAnchorLine = anchor.anchor_line_number || 1;
    this.docCommentAnchorEndLine = anchor.anchor_end_line_number || this.docCommentAnchorLine;
    this.docCommentAnchorBlockId = null;
    this.docCommentAnchorQuote = anchor.anchor_quote;
    this.docCommentAnchorStartOffset = anchor.anchor_start_offset;
    this.docCommentAnchorEndOffset = anchor.anchor_end_offset;
    return true;
  },

  capturePendingRichDocCommentAnchor() {
    if (this.docEditorMode !== 'rich') return false;
    return this.applyPendingRichDocCommentAnchor(
      captureRichEditorSelectionAnchor(this.docRichEditorAdapter?.editor),
    );
  },

  getPendingDocCommentAnchorFields() {
    return {
      anchor_block_id: this.docCommentAnchorBlockId || null,
      anchor_line_number: this.docCommentAnchorLine || null,
      anchor_end_line_number: this.docCommentAnchorEndLine || null,
      anchor_quote: this.docCommentAnchorQuote || null,
      anchor_start_offset: Number.isFinite(Number(this.docCommentAnchorStartOffset))
        ? Number(this.docCommentAnchorStartOffset)
        : null,
      anchor_end_offset: Number.isFinite(Number(this.docCommentAnchorEndOffset))
        ? Number(this.docCommentAnchorEndOffset)
        : null,
    };
  },

  getDocCommentAnchorMetadata(fields = {}) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== ''));
  },

  getDocCommentAnchorResolution(comment = null) {
    if (!this.getDocCommentAnchorQuote(comment)) return { state: 'unavailable' };
    if (this.docEditorMode !== 'rich' || !this.docRichEditorAdapter?.editor) return { state: 'not-visible' };
    return resolveRichEditorSelectionAnchor(this.docRichEditorAdapter.editor, comment);
  },

  getDocCommentAnchorFallbackLabel(comment = null) {
    if (!this.getDocCommentAnchorQuote(comment)) return '';
    const saved = this.docCommentAnchorRevealState?.commentId === comment?.record_id
      ? this.docCommentAnchorRevealState
      : null;
    const resolution = saved || this.getDocCommentAnchorResolution(comment);
    if (resolution.state !== 'stale') return '';
    return resolution.reason === 'ambiguous-quote'
      ? 'Anchor is ambiguous after document edits.'
      : 'Anchor is stale after document edits.';
  },

  revealDocCommentAnchor(comment = null) {
    if (!this.getDocCommentAnchorQuote(comment) || this.docEditorMode !== 'rich') return { state: 'not-visible' };
    const resolved = revealRichEditorSelectionAnchor(this.docRichEditorAdapter?.editor, comment);
    this.docCommentAnchorRevealState = {
      commentId: comment?.record_id || null,
      ...resolved,
    };
    return resolved;
  },

  getPendingDocCommentAnchorLabel() {
    if (!this.docCommentAnchorLine && this.showDocCommentModal) return 'New general comment';
    if (!this.docCommentAnchorLine) return 'Choose a block to anchor this comment.';
    const endLine = Number(this.docCommentAnchorEndLine);
    return Number.isFinite(endLine) && endLine > this.docCommentAnchorLine
      ? `New comment on lines ${this.docCommentAnchorLine}–${endLine}`
      : `New comment on line ${this.docCommentAnchorLine}`;
  },

  getDocCommentAnchorSortKey(comment = null) {
    const anchorBlockId = String(comment?.anchor_block_id || '').trim();
    const blocks = Array.isArray(this.docEditorBlocks) ? this.docEditorBlocks : [];
    const blockIndex = anchorBlockId
      ? blocks.findIndex((block) => String(block?.id || '').trim() === anchorBlockId)
      : -1;
    const block = blockIndex >= 0 ? blocks[blockIndex] : null;
    const line = Number(block?.start_line ?? comment?.anchor_line_number);
    const anchorLine = Number.isFinite(line) && line > 0 ? line : Number.MAX_SAFE_INTEGER;
    const anchorOrder = blockIndex >= 0 ? blockIndex : Number.MAX_SAFE_INTEGER;
    const timestamp = String(comment?.created_at || comment?.updated_at || '');
    const recordId = String(comment?.record_id || '');
    return { anchorLine, anchorOrder, timestamp, recordId };
  },

  compareDocCommentsByAnchor(a, b) {
    const left = this.getDocCommentAnchorSortKey(a);
    const right = this.getDocCommentAnchorSortKey(b);
    if (left.anchorLine !== right.anchorLine) return left.anchorLine - right.anchorLine;
    if (left.anchorOrder !== right.anchorOrder) return left.anchorOrder - right.anchorOrder;
    const timestampCompare = left.timestamp.localeCompare(right.timestamp);
    if (timestampCompare !== 0) return timestampCompare;
    return left.recordId.localeCompare(right.recordId);
  },

  getDocBlockIdentity(block = null, index = -1) {
    return String(block?.id || (Number.isInteger(index) && index >= 0 ? `index:${index}` : '')).trim();
  },

  getDocBlockBySelectedId() {
    const selectedBlockId = String(this.docSelectedBlockId || '').trim();
    if (!selectedBlockId) return null;
    return this.docEditorBlocks.find((block, index) => this.getDocBlockIdentity(block, index) === selectedBlockId) || null;
  },

  getActiveDocCommentAnchorBlock() {
    if (this.docEditorMode === 'block' && this.docEditingBlockIndex >= 0) {
      return this.docEditorBlocks[this.docEditingBlockIndex] || null;
    }
    if (this.docEditorMode !== 'preview' && this.docEditorMode !== 'block') return null;
    return this.getDocBlockBySelectedId();
  },

  selectDocBlockForComment(block, index = -1, options = {}) {
    if (!block) return;
    const blockId = this.getDocBlockIdentity(block, index);
    if (!blockId) return;
    this.docSelectedBlockId = blockId;
    if (options.clearThread !== false) {
      this.closeDocCommentThread({ syncRoute: false });
    }
    this.scheduleDocCommentConnectorUpdate();
  },

  blockIsSelectedForComment(block, index = -1) {
    const selectedBlockId = String(this.docSelectedBlockId || '').trim();
    if (!selectedBlockId) return false;
    return this.getDocBlockIdentity(block, index) === selectedBlockId;
  },

  getDocCommentsForBlock(block) {
    const startLine = Number(block?.start_line);
    if (!Number.isFinite(startLine) && !block?.id) return [];
    return this.docComments
      .filter((comment) => !comment.parent_comment_id && commentBelongsToDocBlock(comment, block))
      .sort((a, b) => this.compareDocCommentsByAnchor(a, b));
  },

  blockHasSelectedDocComment(block) {
    return this.getDocCommentsForBlock(block)
      .some((comment) => comment.record_id === this.selectedDocCommentId);
  },

  getDocBlockCommentState(block) {
    const comments = this.getDocCommentsForBlock(block);
    if (comments.length === 0) return 'none';
    if (comments.some((comment) => comment.comment_status !== 'resolved')) return 'open';
    return 'resolved';
  },

  getDocBlockCommentCount(block) {
    return this.getDocCommentsForBlock(block).reduce((count, comment) => {
      const replies = this.getDocCommentReplies(comment.record_id).length;
      return count + 1 + replies;
    }, 0);
  },

  selectDocCommentThread(commentId, options = {}) {
    const rootId = this.getDocCommentThreadId(commentId);
    if (!rootId) return;
    const root = this.getDocCommentById(rootId);
    this.docCommentsVisible = true;
    this.docMobilePane = 'comments';
    this.selectedDocCommentId = rootId;
    this.docSelectedBlockId = null;
    this.showDocCommentModal = false;
    this.clearPendingDocCommentAnchor();
    this.newDocCommentBody = '';
    this.newDocCommentReplyBody = '';
    if (options.syncRoute !== false) this.syncRoute();
    this.scheduleDocCommentConnectorUpdate();
    if (options.reveal !== false) this.revealDocCommentAnchor(root);
  },

  closeDocCommentThread(options = {}) {
    this.selectedDocCommentId = null;
    this.newDocCommentReplyBody = '';
    if (options.syncRoute !== false) this.syncRoute();
    this.clearDocCommentConnector();
  },

  openDocCommentModal(block) {
    if (!this.selectedDocId || !block) return;
    this.docCommentsVisible = true;
    this.docMobilePane = 'comments';
    const blockIndex = Array.isArray(this.docEditorBlocks) ? this.docEditorBlocks.indexOf(block) : -1;
    this.docSelectedBlockId = this.getDocBlockIdentity(block, blockIndex);
    this.docCommentAnchorLine = Number(block.start_line) || 1;
    this.docCommentAnchorEndLine = this.docCommentAnchorLine;
    this.docCommentAnchorBlockId = block.id || null;
    this.docCommentAnchorQuote = '';
    this.docCommentAnchorStartOffset = null;
    this.docCommentAnchorEndOffset = null;
    this.selectedDocCommentId = null;
    this.newDocCommentReplyBody = '';
    this.newDocCommentBody = '';
    this.showDocCommentModal = false;
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.querySelector('[data-doc-new-comment-input]')?.focus?.();
      });
    }
    this.scheduleDocCommentConnectorUpdate();
  },

  startDocCommentPlacement() {
    const hasRichSelection = this.capturePendingRichDocCommentAnchor();
    this.docCommentsVisible = true;
    this.docMobilePane = 'comments';
    this.closeDocCommentThread({ syncRoute: false });
    this.newDocCommentBody = '';
    if (hasRichSelection) {
      this.showDocCommentModal = false;
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          document.querySelector('[data-doc-new-comment-input]')?.focus?.();
        });
      }
      this.scheduleDocCommentConnectorUpdate();
      return;
    }
    const block = this.getActiveDocCommentAnchorBlock();
    if (block) {
      this.openDocCommentModal(block);
      return;
    }
    this.docSelectedBlockId = null;
    this.clearPendingDocCommentAnchor();
    this.showDocCommentModal = true;
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.querySelector('[data-doc-new-comment-input]')?.focus?.();
      });
    }
    this.scheduleDocCommentConnectorUpdate();
  },

  closeDocCommentModal() {
    this.showDocCommentModal = false;
    this.clearPendingDocCommentAnchor();
    this.newDocCommentBody = '';
    this.scheduleDocCommentConnectorUpdate();
  },

  toggleDocCommentsVisible() {
    this.docCommentsVisible = !this.docCommentsVisible;
    this.docMobilePane = this.docCommentsVisible ? 'comments' : 'document';
    if (!this.docCommentsVisible) {
      this.showDocCommentModal = false;
      this.clearPendingDocCommentAnchor();
      this.closeDocCommentThread({ syncRoute: false });
      this.clearDocCommentConnector();
      return;
    }
    this.scheduleDocCommentConnectorUpdate();
  },

  async addDocComment() {
    const body = String(this.newDocCommentBody || '').trim();
    const doc = this.selectedDocument;
    const drafts = [...this.docCommentAudioDrafts];
    if (this.containsInlineImageUploadToken(body)) {
      this.error = 'Wait for image upload to finish.';
      return;
    }
    if ((!body && drafts.length === 0) || !doc || !this.session?.npub) return;
    if (isTowerPgBackendMode()) {
      if (!body) {
        this.error = 'Text is required for PG document comments.';
        return;
      }
      if (drafts.length > 0) {
        this.error = 'Audio drafts are not available in PG document comments yet.';
        return;
      }
      const now = new Date().toISOString();
      const anchorFields = this.getPendingDocCommentAnchorFields();
      const localRow = {
        record_id: crypto.randomUUID(),
        owner_npub: this.workspaceOwnerNpub,
        target_record_id: doc.record_id,
        target_record_family_hash: recordFamilyHash('document'),
        parent_comment_id: null,
        ...anchorFields,
        comment_status: 'open',
        body,
        attachments: [],
        sender_npub: this.session.npub,
        record_state: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
        pg_backend: true,
        pg_channel_id: doc.pg_channel_id || doc.channel_id || null,
        pg_metadata: {
          client_record_id: null,
          ...this.getDocCommentAnchorMetadata(anchorFields),
        },
      };
      localRow.pg_metadata.client_record_id = localRow.record_id;
      await upsertComment(localRow);
      this.docComments = [...this.docComments, localRow]
        .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
      this.scheduleStorageImageHydration();
      this.selectDocCommentThread(localRow.record_id, { syncRoute: false });
      this.closeDocCommentModal();
      this.syncRoute();
      try {
        const accepted = await createTowerPgDocCommentFromLocal(this, localRow);
        await replaceCommentRecord(localRow.record_id, accepted);
        this.docComments = this.docComments
          .filter((comment) => comment.record_id !== localRow.record_id)
          .concat(accepted)
          .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
        this.selectedDocCommentId = accepted.record_id;
        this.scheduleDocCommentConnectorUpdate();
      } catch (error) {
        this.error = error?.message || 'Failed to sync PG document comment.';
      }
      return;
    }

    const targetGroupIds = await this.getEncryptableDocCommentGroupIdsForWrite(doc);
    if (targetGroupIds == null) return;

    const now = new Date().toISOString();
    const recordId = crypto.randomUUID();
    const anchorFields = this.getPendingDocCommentAnchorFields();
    const { attachments } = await this.materializeAudioDrafts({
      drafts,
      target_record_id: recordId,
      target_record_family_hash: recordFamilyHash('comment'),
      target_group_ids: toRaw(targetGroupIds),
      write_group_ref: this.getPreferredDocWriteGroupRef(doc),
    });
    const localRow = {
      record_id: recordId,
      owner_npub: this.workspaceOwnerNpub,
      target_record_id: doc.record_id,
      target_record_family_hash: recordFamilyHash('document'),
      parent_comment_id: null,
      ...anchorFields,
      comment_status: 'open',
      body,
      attachments,
      sender_npub: this.session.npub,
      record_state: 'active',
      version: 1,
      created_at: now,
      updated_at: now,
    };

    await upsertComment(localRow);
    this.docComments = [...this.docComments, localRow]
      .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
    this.scheduleStorageImageHydration();
    this.selectDocCommentThread(recordId, { syncRoute: false });
    this.docCommentAudioDrafts = [];
    this.closeDocCommentModal();
    this.syncRoute();

    const envelope = await outboundComment({
      ...localRow,
      target_group_ids: toRaw(targetGroupIds),
      signature_npub: this.signingNpub,
      write_group_ref: this.getPreferredDocWriteGroupRef(doc),
    });
    await queueTowerPendingWrite(this, {
      record_id: recordId,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    await this.flushAndBackgroundSync();
  },

  async addDocCommentReply() {
    const body = String(this.newDocCommentReplyBody || '').trim();
    const doc = this.selectedDocument;
    const root = this.selectedDocComment;
    const drafts = [...this.docCommentReplyAudioDrafts];
    if (this.containsInlineImageUploadToken(body)) {
      this.error = 'Wait for image upload to finish.';
      return;
    }
    if ((!body && drafts.length === 0) || !doc || !root || !this.session?.npub) return;
    if (isTowerPgBackendMode()) {
      if (!body) {
        this.error = 'Text is required for PG document comment replies.';
        return;
      }
      if (drafts.length > 0) {
        this.error = 'Audio drafts are not available in PG document comment replies yet.';
        return;
      }
      const now = new Date().toISOString();
      const rootAnchorFields = {
        anchor_block_id: root.anchor_block_id || null,
        anchor_line_number: root.anchor_line_number || null,
        anchor_end_line_number: root.anchor_end_line_number ?? root.pg_metadata?.anchor_end_line_number ?? null,
        anchor_quote: this.getDocCommentAnchorQuote(root) || null,
        anchor_start_offset: root.anchor_start_offset ?? root.pg_metadata?.anchor_start_offset ?? null,
        anchor_end_offset: root.anchor_end_offset ?? root.pg_metadata?.anchor_end_offset ?? null,
      };
      const localRow = {
        record_id: crypto.randomUUID(),
        owner_npub: this.workspaceOwnerNpub,
        target_record_id: doc.record_id,
        target_record_family_hash: recordFamilyHash('document'),
        parent_comment_id: root.record_id,
        ...rootAnchorFields,
        comment_status: 'open',
        body,
        attachments: [],
        sender_npub: this.session.npub,
        record_state: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
        pg_backend: true,
        pg_channel_id: doc.pg_channel_id || doc.channel_id || null,
        pg_metadata: {
          ...(root.pg_metadata && typeof root.pg_metadata === 'object' ? root.pg_metadata : {}),
          client_record_id: null,
          ...this.getDocCommentAnchorMetadata(rootAnchorFields),
          comment_status: 'open',
        },
      };
      localRow.pg_metadata.client_record_id = localRow.record_id;
      await upsertComment(localRow);
      this.docComments = [...this.docComments, localRow]
        .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
      this.scheduleStorageImageHydration();
      this.newDocCommentReplyBody = '';
      this.docCommentReplyAudioDrafts = [];
      this.scheduleDocCommentConnectorUpdate();
      try {
        const accepted = await createTowerPgDocCommentFromLocal(this, localRow);
        await replaceCommentRecord(localRow.record_id, accepted);
        this.docComments = this.docComments
          .filter((comment) => comment.record_id !== localRow.record_id)
          .concat(accepted)
          .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
        this.scheduleDocCommentConnectorUpdate();
      } catch (error) {
        this.error = error?.message || 'Failed to sync PG document comment reply.';
      }
      return;
    }

    const targetGroupIds = await this.getEncryptableDocCommentGroupIdsForWrite(doc);
    if (targetGroupIds == null) return;

    const now = new Date().toISOString();
    const recordId = crypto.randomUUID();
    const rootAnchorFields = {
      anchor_block_id: root.anchor_block_id || null,
      anchor_line_number: root.anchor_line_number || null,
      anchor_end_line_number: root.anchor_end_line_number ?? null,
      anchor_quote: this.getDocCommentAnchorQuote(root) || null,
      anchor_start_offset: root.anchor_start_offset ?? null,
      anchor_end_offset: root.anchor_end_offset ?? null,
    };
    const { attachments } = await this.materializeAudioDrafts({
      drafts,
      target_record_id: recordId,
      target_record_family_hash: recordFamilyHash('comment'),
      target_group_ids: toRaw(targetGroupIds),
      write_group_ref: this.getPreferredDocWriteGroupRef(doc),
    });
    const localRow = {
      record_id: recordId,
      owner_npub: this.workspaceOwnerNpub,
      target_record_id: doc.record_id,
      target_record_family_hash: recordFamilyHash('document'),
      parent_comment_id: root.record_id,
      ...rootAnchorFields,
      comment_status: 'open',
      body,
      attachments,
      sender_npub: this.session.npub,
      record_state: 'active',
      version: 1,
      created_at: now,
      updated_at: now,
    };

    await upsertComment(localRow);
    this.docComments = [...this.docComments, localRow]
      .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
    this.scheduleStorageImageHydration();
    this.newDocCommentReplyBody = '';
    this.docCommentReplyAudioDrafts = [];
    this.scheduleDocCommentConnectorUpdate();

    const envelope = await outboundComment({
      ...localRow,
      target_group_ids: toRaw(targetGroupIds),
      signature_npub: this.signingNpub,
      write_group_ref: this.getPreferredDocWriteGroupRef(doc),
    });
    await queueTowerPendingWrite(this, {
      record_id: recordId,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    await this.flushAndBackgroundSync();
  },

  async setDocCommentStatus(commentId, nextStatus) {
    const comment = this.getDocCommentById(commentId);
    const doc = this.selectedDocument;
    if (!comment || !doc || !this.session?.npub) return;
    const status = nextStatus === 'resolved' ? 'resolved' : 'open';
    if ((comment.comment_status || 'open') === status) return;
    if (isTowerPgBackendMode()) {
      const updated = {
        ...comment,
        comment_status: status,
        pg_metadata: {
          ...(comment.pg_metadata && typeof comment.pg_metadata === 'object' && !Array.isArray(comment.pg_metadata) ? comment.pg_metadata : {}),
          comment_status: status,
        },
        previous_version: comment.version ?? 1,
        version: (comment.version ?? 1) + 1,
        updated_at: new Date().toISOString(),
      };
      await upsertComment(updated);
      this.docComments = this.docComments.map((candidate) =>
        candidate.record_id === comment.record_id ? updated : candidate
      );
      this.syncRoute();
      this.scheduleDocCommentConnectorUpdate();
      try {
        const accepted = await updateTowerPgDocCommentFromLocal(this, updated);
        await replaceCommentRecord(comment.record_id, accepted);
        this.docComments = this.docComments.map((candidate) =>
          candidate.record_id === comment.record_id ? accepted : candidate
        );
        this.scheduleDocCommentConnectorUpdate();
      } catch (error) {
        this.error = error?.message || 'Failed to sync PG document comment status.';
      }
      return;
    }
    const targetGroupIds = await this.getEncryptableDocCommentGroupIdsForWrite(doc);
    if (targetGroupIds == null) return;

    const updated = {
      ...comment,
      comment_status: status,
      version: (comment.version ?? 1) + 1,
      updated_at: new Date().toISOString(),
    };
    await upsertComment(updated);
    this.docComments = this.docComments.map((candidate) =>
      candidate.record_id === comment.record_id ? updated : candidate
    );
    this.syncRoute();
    this.scheduleDocCommentConnectorUpdate();

    const envelope = await outboundComment({
      ...updated,
      previous_version: comment.version ?? 1,
      target_group_ids: toRaw(targetGroupIds),
      signature_npub: this.signingNpub,
      write_group_ref: this.getPreferredDocWriteGroupRef(doc),
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    await this.flushAndBackgroundSync();
  },

  async removeDocComment(commentId) {
    const comment = this.getDocCommentById(commentId);
    const doc = this.selectedDocument;
    if (!comment || !doc || !this.session?.npub) return;
    if (isTowerPgBackendMode()) {
      const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
        ? true
        : window.confirm('Remove this comment thread? This cannot be undone.');
      if (!confirmed) return;
      const now = new Date().toISOString();
      const idsToDelete = new Set([comment.record_id]);
      if (!comment.parent_comment_id) {
        for (const reply of this.getDocCommentReplies(comment.record_id)) idsToDelete.add(reply.record_id);
      }
      const updatedComments = this.docComments.map((candidate) =>
        idsToDelete.has(candidate.record_id)
          ? {
              ...candidate,
              record_state: 'deleted',
              version: (candidate.version ?? 1) + 1,
              updated_at: now,
            }
          : candidate
      );
      for (const updated of updatedComments.filter((candidate) => idsToDelete.has(candidate.record_id))) {
        await upsertComment(updated);
      }
      this.docComments = updatedComments;
      if (idsToDelete.has(this.selectedDocCommentId)) {
        this.selectedDocCommentId = null;
        this.newDocCommentReplyBody = '';
        this.clearDocCommentConnector();
      }
      this.syncRoute();
      this.scheduleDocCommentConnectorUpdate();
      try {
        await deleteTowerPgDocCommentFromLocal(this, comment);
      } catch (error) {
        this.error = error?.message || 'Failed to delete PG document comment.';
      }
      return;
    }
    const targetGroupIds = await this.getEncryptableDocCommentGroupIdsForWrite(doc);
    if (targetGroupIds == null) return;

    const updated = {
      ...comment,
      record_state: 'deleted',
      version: (comment.version ?? 1) + 1,
      updated_at: new Date().toISOString(),
    };
    await upsertComment(updated);
    this.docComments = this.docComments.map((candidate) =>
      candidate.record_id === comment.record_id ? updated : candidate
    );
    if (this.selectedDocCommentId === comment.record_id) {
      this.selectedDocCommentId = null;
      this.newDocCommentReplyBody = '';
      this.clearDocCommentConnector();
    }
    this.syncRoute();
    this.scheduleDocCommentConnectorUpdate();

    const envelope = await outboundComment({
      ...updated,
      previous_version: comment.version ?? 1,
      target_group_ids: toRaw(targetGroupIds),
      signature_npub: this.signingNpub,
      write_group_ref: this.getPreferredDocWriteGroupRef(doc),
    });
    await queueTowerPendingWrite(this, {
      record_id: updated.record_id,
      record_family_hash: envelope.record_family_hash,
      envelope,
    });
    await this.flushAndBackgroundSync();
  },

  getDocCommentSummary,

  getSelectedDocCheckoutSession() {
    if (!this.selectedDocId || this.selectedDocType !== 'document') return null;
    return this.getLockManagedCheckoutSession(this.selectedDocId, recordFamilyHash('document'));
  },

  async acquireSelectedDocCheckout(options = {}) {
    const item = this.selectedDocument;
    if (!item) return false;
    if (isTowerPgBackendMode()) {
      try {
        await acquirePgEditLeaseForRecord(this, item, 'document', options);
        return true;
      } catch (error) {
        if (options.reportError !== false) {
          this.error = error?.code === 'pg_synced_offline'
            ? 'Reconnect to edit synced PG documents.'
            : (error?.userMessage || error?.message || 'Unable to acquire Tower PG edit lease.');
        }
        return false;
      }
    }
    try {
      await this.ensureLockManagedCheckout(item, recordFamilyHash('document'), {
        intent: 'edit',
        reportError: true,
        ...options,
      });
      return true;
    } catch {
      return false;
    }
  },

  async enterSelectedDocEditMode(mode = 'rich') {
    const item = this.selectedDocument;
    if (!item) return false;
    const requestedMode = mode === 'source'
      ? 'source'
      : mode === 'block'
        ? 'block'
        : 'rich';
    if (isTowerPgBackendMode() && isSyncedPgRecord(item)) {
      const held = Boolean(getPgEditLeaseSession(this, 'document', item.record_id)?.lease?.lease_token);
      const acquired = held || await this.beginSelectedDocLeaseAcquisition({ mode: requestedMode });
      if (!acquired) return false;
      this.docEditAccessState = 'editing';
      this.setDocEditorMode(requestedMode);
      return true;
    }
    const hasPgLease = isTowerPgBackendMode()
      && (!isSyncedPgRecord(item) || Boolean(getPgEditLeaseSession(this, 'document', item.record_id)?.lease?.lease_token));
    const session = this.getSelectedDocCheckoutSession();
    if (!hasPgLease && !isCheckoutHeld(session?.checkout)) {
      const acquired = await this.acquireSelectedDocCheckout();
      if (!acquired) return false;
    }
    this.setDocEditorMode(requestedMode);
    if (isTowerPgBackendMode() && isSyncedPgRecord(item)) {
      startPgEditLeaseRenewal(this, item, 'document');
    }
    this.docEditAccessState = 'editing';
    this.docEditAccessMessage = '';
    this.docRichEditorAdapter?.setEditable?.(true);
    return true;
  },

  setDocReadMode() {
    this.setDocEditorMode('preview');
  },

  async saveAndExitSelectedDocEditMode() {
    const item = this.selectedDocument;
    if (!item) return false;

    if (Number(this.docRichImageUploadCount || 0) > 0) {
      this.error = 'Wait for pasted images to finish uploading before saving this document.';
      this.docAutosaveState = 'pending';
      return false;
    }

    if (this.docEditorMode !== 'preview') {
      if (this.docEditingBlockIndex >= 0) {
        this.commitDocBlockEdit();
      }
      try {
        // Make the explicit Save boundary durable before serialization,
        // storage preparation, signing, or transport can fail. The normal
        // input debounce is intentionally not sufficient here: a user can
        // type and immediately press Save before that timer fires.
        await this.persistSelectedDocDraft({ immediate: true });
        const saved = await this.saveSelectedDocItem({ autosave: false });
        if (!saved) return false;
      } catch (error) {
        // Some failures happen before saveSelectedPgDocItem reaches its own
        // persistence branch (for example an editor serialization exception).
        // Keep the latest visible state recoverable and leave edit mode open.
        await this.persistSelectedDocDraft({
          immediate: true,
          remoteOutcome: {
            status: 'error',
            code: error?.code || 'save_failed',
            at: new Date().toISOString(),
          },
        }).catch(() => {});
        this.docAutosaveState = 'error';
        if (!this.error) this.error = error?.message || 'Failed to save document. Your draft remains open and recoverable.';
        return false;
      }
    }

    if (this.docEditorMode !== 'rich' && this.isTiptapDocsEditorEnabled()) this.setDocEditorMode('rich');
    if (isTowerPgBackendMode()) {
      await releasePgEditLeaseForRecord(this, this.selectedDocument || item, 'document');
    } else {
      await this.releaseLockManagedCheckout(this.selectedDocument || item, recordFamilyHash('document'), {
        reportError: false,
        force: true,
      });
    }
    this.docEditAccessState = 'ready';
    this.docEditAccessMessage = '';
    this.docRichEditorAdapter?.setEditable?.(this.isSelectedDocRichEditorEditable());
    void this.inspectSelectedDocEditLease(this.selectedDocument || item);
    return true;
  },

  setDocEditorMode(mode) {
    const nextMode = mode === 'rich' ? 'rich' : mode === 'source' ? 'source' : mode === 'block' ? 'block' : 'preview';
    if (nextMode === 'rich' && !this.isTiptapDocsEditorEnabled()) return;
    if (nextMode !== 'preview') {
      if (isTowerPgBackendMode()) {
        const item = this.selectedDocument;
        if (nextMode !== 'rich' && isSyncedPgRecord(item) && !getPgEditLeaseSession(this, 'document', item?.record_id)?.lease?.lease_token) return;
      } else {
      const session = this.getSelectedDocCheckoutSession();
      if (!isCheckoutHeld(session?.checkout)) return;
      }
    }
    if (nextMode === 'source' && this.docEditingBlockIndex >= 0) {
      this.commitDocBlockEdit();
    }
    if (this.docEditorMode === 'rich' && nextMode !== 'rich') {
      this.syncDocRichEditorContentModel();
      this.destroyDocRichEditor();
    }
    if (nextMode === 'preview' && this.docEditingBlockIndex >= 0) {
      this.cancelDocBlockEdit();
    }
    if (nextMode === 'rich' && this.docEditingBlockIndex >= 0) {
      this.commitDocBlockEdit();
    }
    if (nextMode === 'rich' && !this.docEditorProseMirrorState) {
      const editorState = createDocumentEditorState({
        ...(this.selectedDocument || {}),
        content: this.docEditorContent,
        content_blocks: this.docEditorBlocks,
      });
      this.docEditorProseMirrorState = editorState.editorState;
      this.docEditorContentModel = editorState.contentModel;
    }
    this.docEditorMode = nextMode;
  },

  toggleDocEditorMode() {
    if (this.docEditorMode === 'preview') {
      void this.enterSelectedDocEditMode('rich');
      return;
    }
    if (this.docEditorMode === 'block') {
      this.setDocEditorMode('source');
      return;
    }
    if (this.docEditorMode === 'source' && this.isTiptapDocsEditorEnabled()) {
      this.setDocEditorMode('rich');
      return;
    }
    this.setDocEditorMode('preview');
  },

  resolveDocShareTarget(target = null) {
    if (target === 'current-folder') {
      return this.currentFolder
        ? { type: 'directory', item: this.currentFolder }
        : { type: null, item: null };
    }
    if (target?.type === 'document' || target?.type === 'directory') {
      return { type: target.type, item: target.item || null };
    }
    if (this.selectedDocument) {
      return { type: 'document', item: this.selectedDocument };
    }
    if (this.selectedDirectory) {
      return { type: 'directory', item: this.selectedDirectory };
    }
    if (this.currentFolder) {
      return { type: 'directory', item: this.currentFolder };
    }
    return { type: null, item: null };
  },

  openDocShareModal(target = null) {
    const resolved = this.resolveDocShareTarget(target);
    if (!resolved.item) {
      this.error = 'Select a document or folder first';
      return;
    }
    this.docShareTargetType = resolved.type;
    this.docShareTargetId = resolved.item.record_id;
    this.docEditorShares = this.getEffectiveDocShares(resolved.item).map((share) => ({ ...share }));
    this.docEditorSharesDirty = false;
    this.docShareQuery = '';
    this.showDocShareModal = true;
  },

  closeDocShareModal() {
    this.showDocShareModal = false;
    this.docShareQuery = '';
    this.docShareTargetType = '';
    this.docShareTargetId = '';
  },

  async startDocTitleEdit() {
    if (this.docEditorMode === 'preview') return false;
    if (isTowerPgBackendMode() && isSyncedPgRecord(this.selectedDocument)
      && this.docEditAccessState !== 'editing') {
      const acquired = await this.beginSelectedDocLeaseAcquisition();
      if (!acquired) return false;
    }
    this.docEditingTitle = true;
    return true;
  },

  finishDocTitleEdit() {
    this.docEditingTitle = false;
    this.docEditDraftDirty = true;
    this.scheduleDocLocalDraftPersistence();
    this.scheduleDocAutosave();
  },

  syncDocBlocksFromContent() {
    this.docEditorBlocks = parseMarkdownBlocks(this.docEditorContent, {
      previousBlocks: this.docEditorBlocks,
    });
  },

  handleDocSourceInput(value) {
    this.docEditorContent = value;
    this.syncDocBlocksFromContent();
    this.refreshProseMirrorStateFromCompatibility();
    this.docEditDraftDirty = true;
    this.scheduleDocLocalDraftPersistence();
    this.scheduleDocAutosave();
    this.scheduleStorageImageHydration();
  },

  measureDocBlockEditorMinHeight(previewEl = null) {
    const fallback = 88;
    const height = Number(previewEl?.getBoundingClientRect?.().height) || Number(previewEl?.offsetHeight) || 0;
    return Math.max(fallback, Math.ceil(height));
  },

  getDocBlockEditorStyle() {
    const minHeight = Number(this.docBlockEditorMinHeightPx) || 0;
    return minHeight > 0 ? { minHeight: `${minHeight}px` } : {};
  },

  resizeDocBlockEditor(textarea = null) {
    if (!textarea) return;
    const minHeight = Number(this.docBlockEditorMinHeightPx) || this.measureDocBlockEditorMinHeight();
    textarea.style.minHeight = `${minHeight}px`;
    textarea.style.height = `${minHeight}px`;
    const nextHeight = Math.max(minHeight, Number(textarea.scrollHeight) || 0);
    textarea.style.height = `${nextHeight}px`;
  },

  startDocBlockEdit(index, previewEl = null) {
    if (this.docEditorMode !== 'block') return;
    if (this.docEditingBlockIndex >= 0 && this.docEditingBlockIndex !== index) {
      this.commitDocBlockEdit();
    }
    if (!this.docEditorBlocks[index]) {
      this.docEditorBlocks = [...this.docEditorBlocks, createDocumentBlock('')];
    }
    this.docBlockEditorMinHeightPx = this.measureDocBlockEditorMinHeight(previewEl);
    this.selectDocBlockForComment(this.docEditorBlocks[index], index, { clearThread: false });
    this.docEditingBlockIndex = index;
    this.docBlockBuffer = this.docEditorBlocks[index]?.raw ?? '';
  },

  appendDocBlock() {
    if (this.docEditorMode !== 'block') return;
    const index = this.docEditorBlocks.length;
    this.docEditorBlocks = [...this.docEditorBlocks, createDocumentBlock('')];
    this.startDocBlockEdit(index);
  },

  updateDocBlockBuffer(value, textarea = null) {
    this.docBlockBuffer = value;
    this.resizeDocBlockEditor(textarea);
    this.scheduleStorageImageHydration();
  },

  commitDocBlockEdit() {
    if (this.docEditingBlockIndex < 0) return;
    const blocks = [...this.docEditorBlocks];
    const raw = String(this.docBlockBuffer || '').trimEnd();
    if (raw) {
      blocks[this.docEditingBlockIndex] = {
        ...(blocks[this.docEditingBlockIndex] || createDocumentBlock('')),
        raw,
        text: raw,
      };
    } else {
      blocks.splice(this.docEditingBlockIndex, 1);
    }
    this.docEditorBlocks = normalizeDocumentBlocks(blocks);
    this.docEditorContent = assembleMarkdownBlocks(this.docEditorBlocks);
    this.refreshProseMirrorStateFromCompatibility();
    this.docEditingBlockIndex = -1;
    this.docBlockBuffer = '';
    this.docBlockEditorMinHeightPx = 0;
    this.docEditDraftDirty = true;
    this.scheduleDocLocalDraftPersistence();
    this.scheduleDocAutosave();
    this.scheduleStorageImageHydration();
  },

  cancelDocBlockEdit() {
    this.docEditingBlockIndex = -1;
    this.docBlockBuffer = '';
    this.docBlockEditorMinHeightPx = 0;
  },

  scheduleDocAutosave() {
    this.scheduleDocLocalDraftPersistence();
    if (!this.docsEditorOpen) return;
    if (this.docEditorMode === 'preview') return;
    if (isTowerPgBackendMode() && isSyncedPgRecord(this.selectedDocument)
      && !['editing', 'recovery'].includes(this.docEditAccessState)) return;
    this.docAutosaveState = 'pending';
    if (this.docAutosaveTimer) return;
    this.docAutosaveTimer = setTimeout(async () => {
      this.docAutosaveTimer = null;
      try {
        await this.saveSelectedDocItem({ autosave: true });
      } catch {
        // saveSelectedDocItem already updates error/autosave state
      }
    }, DOCUMENT_REMOTE_AUTOSAVE_DELAY_MS);
  },

  cancelDocAutosave() {
    if (this.docAutosaveTimer) clearTimeout(this.docAutosaveTimer);
    this.docAutosaveTimer = null;
  },

  serializeDocShares,
  normalizeDocShare,
  mergeDocShareLists,
  getStoredDocShares,
  getExplicitDocShares,
  _resolveDocGroupRef(value) {
    return this.resolveGroupId
      ? this.resolveGroupId(value)
      : String(value || '').trim() || null;
  },
  getPreferredDocWriteGroupRef(record) {
    const resolveGroupRef = (value) => this._resolveDocGroupRef(value);
    const allowedGroupIds = getStoreActorWritableGroupRefs(this);
    const normalizedRecord = normalizeDocAccessRow(record, resolveGroupRef);
    return getPreferredDocWriteGroupRef(
      normalizedRecord,
      {
        hasKey: (value) => hasGroupKey(resolveGroupRef(value)),
        allowedGroupIds,
      },
    );
  },

  normalizeDocumentRowGroupRefs(record) {
    const resolveGroupRef = (value) => this._resolveDocGroupRef(value);
    return normalizeDocAccessRow(record, resolveGroupRef);
  },

  normalizeDirectoryRowGroupRefs(record) {
    const resolveGroupRef = (value) => this._resolveDocGroupRef(value);
    return normalizeDocAccessRow(record, resolveGroupRef);
  },

  getMissingDocGroupRefs(record) {
    const normalized = this.normalizeDocumentRowGroupRefs(record);
    return getMissingRecordGroupRefsForStore(this, normalized, {
      resolveGroupId: (value) => this._resolveDocGroupRef(value),
    });
  },

  async ensureDocGroupKeysLoaded(record) {
    const normalized = this.normalizeDocumentRowGroupRefs(record);
    const groupIds = normalizeGroupIds(normalized?.group_ids || []);
    if (groupIds.length === 0) return [];
    let missingGroupRefs = getMissingRecordGroupRefsForStore(this, normalized, {
      resolveGroupId: (value) => this._resolveDocGroupRef(value),
    });
    if (missingGroupRefs.length === 0) return [];
    if (typeof this.refreshGroups === 'function') {
      await this.refreshGroups({ force: true });
    }
    missingGroupRefs = getMissingRecordGroupRefsForStore(this, normalized, {
      resolveGroupId: (value) => this._resolveDocGroupRef(value),
    });
    if (missingGroupRefs.length === 0) return [];
    const loadedGroupCount = groupIds.length - missingGroupRefs.length;
    if (loadedGroupCount > 0) return [];
    return missingGroupRefs;
  },

  getEncryptableDocCommentGroupIds(record) {
    const normalized = this.normalizeDocumentRowGroupRefs(record);
    const { requestedGroupIds, encryptableGroupIds, missingGroupIds } = getRecordGroupKeyState(normalized, {
      resolveGroupId: (value) => this._resolveDocGroupRef(value),
    });
    if (requestedGroupIds.length === 0) return [];
    if (missingGroupIds.length === 0) return encryptableGroupIds;
    this.error = `Document comment write is missing group keys: ${missingGroupIds.join(', ')}`;
    return null;
  },

  async getEncryptableDocCommentGroupIdsForWrite(record) {
    const normalized = this.normalizeDocumentRowGroupRefs(record);
    try {
      return await getEncryptableRecordGroupRefsForStore(this, normalized, {
        label: 'Document comment write',
        resolveGroupId: (value) => this._resolveDocGroupRef(value),
      });
    } catch (error) {
      this.error = error?.message || 'Document comment write is missing group keys.';
    }
    return null;
  },

  async markDocRecordWriteFailed(table, record, error, options = {}) {
    if (!record?.record_id) return record;
    const syncFailedRecord = {
      ...record,
      sync_status: 'failed',
      updated_at: options.updated_at || record.updated_at || new Date().toISOString(),
    };
    if (table === 'directory') {
      await upsertDirectory(syncFailedRecord);
      this.patchDirectoryLocal(syncFailedRecord);
    } else {
      await upsertDocument(syncFailedRecord);
      this.patchDocumentLocal(syncFailedRecord);
    }
    const prefix = table === 'directory' ? 'Folder' : 'Document';
    this.error = error?.message || `${prefix} write is missing required group keys.`;
    return syncFailedRecord;
  },

  getEffectiveDirectoryShares(directoryOrId, seen = new Set()) {
    const directory = typeof directoryOrId === 'string'
      ? this.directories.find((item) => item.record_id === directoryOrId)
      : directoryOrId;
    if (!directory?.record_id || seen.has(directory.record_id)) return [];

    const nextSeen = new Set(seen);
    nextSeen.add(directory.record_id);
    const explicit = this.getExplicitDocShares(directory);
    const inherited = directory.parent_directory_id
      ? this.getInheritedDirectoryShares(directory.parent_directory_id, nextSeen)
      : [];
    return this.mergeDocShareLists(explicit, inherited);
  },

  getInheritedDirectoryShares(directoryOrId, seen = new Set()) {
    const directory = typeof directoryOrId === 'string'
      ? this.directories.find((item) => item.record_id === directoryOrId)
      : directoryOrId;
    if (!directory?.record_id) return [];
    return this.getEffectiveDirectoryShares(directory, seen)
      .map((share) => this.normalizeDocShare({ ...share }, directory.record_id))
      .filter(Boolean);
  },

  getEffectiveDocShares(item) {
    if (!item) return [];
    const explicit = this.getExplicitDocShares(item);
    const inherited = item.parent_directory_id
      ? this.getInheritedDirectoryShares(item.parent_directory_id)
      : [];
    return this.mergeDocShareLists(explicit, inherited);
  },

  getDocShareSubtitle(share) {
    if (!share) return '';
    const shortBase = this.getShortNpub(
      share.type === 'person'
        ? share.person_npub
        : (share.group_npub || share.via_group_npub || '')
    );
    const viaGroup = share.type === 'person' && share.via_group_npub
      ? this.getDocShareTitle({ type: 'group', label: '', group_npub: share.via_group_npub })
      : '';
    const base = viaGroup ? `${shortBase} · via ${viaGroup}` : shortBase;
    if (!this.isInheritedDocShare(share)) return base;
    const directory = this.directories.find((item) => item.record_id === share.inherited_from_directory_id);
    return directory?.title
      ? `${base} · inherited from ${directory.title}`
      : `${base} · inherited`;
  },

  getDocShareTitle(share) {
    if (!share) return '';
    if (share.type === 'person') return this.getSenderName(share.person_npub);
    const groupRef = share.group_id || share.group_npub || share.via_group_id || share.via_group_npub || '';
    const knownGroup = this.groups.find((group) => group.group_id === groupRef || group.group_npub === groupRef);
    return share.label || knownGroup?.name || 'Group';
  },

  getDocShareAvatar(share) {
    if (!share || share.type !== 'person') return null;
    return this.getSenderAvatar(share.person_npub);
  },

  isInheritedDocShare(shareOrKey) {
    const share = typeof shareOrKey === 'string'
      ? this.docEditorShares.find((item) => item.key === shareOrKey)
      : shareOrKey;
    return Boolean(share?.inherited || share?.inherited_from_directory_id);
  },

  openNewDocModal(type) {
    this.newDocModalType = type;
    this.newDocModalTitle = '';
    this.newDocModalScopeId = this.getDefaultDocScopeId(this.getDefaultParentDirectoryId());
    this.newDocModalChannelId = this.getDefaultDocChannelId(this.newDocModalScopeId);
    this.newDocModalScopeQuery = this.getNewDocModalScopeOptionLabel(this.newDocModalScopeId);
    this.newDocModalChannelQuery = this.getNewDocModalChannelOptionLabel(this.newDocModalChannelId);
    this.newDocModalScopeDropdownOpen = false;
    this.newDocModalChannelDropdownOpen = false;
    this.newDocModalSubmitting = false;
    this.scopePickerQuery = '';
  },

  closeNewDocModal() {
    this.newDocModalType = null;
    this.newDocModalTitle = '';
    this.newDocModalScopeId = null;
    this.newDocModalScopeQuery = '';
    this.newDocModalScopeDropdownOpen = false;
    this.newDocModalChannelId = null;
    this.newDocModalChannelQuery = '';
    this.newDocModalChannelDropdownOpen = false;
    this.newDocModalSubmitting = false;
    this.scopePickerQuery = '';
  },

  get newDocModalScopeOptions() {
    return (this.scopes || [])
      .filter((scope) => scope?.record_id && scope.record_state !== 'deleted')
      .map((scope) => ({
        id: scope.record_id,
        title: scope.title || 'Untitled scope',
        label: this.getScopeBreadcrumb?.(scope.record_id) || scope.title || scope.record_id,
        level: scope.level || 'scope',
      }))
      .sort((left, right) => String(left.label || '').localeCompare(String(right.label || '')));
  },

  get newDocModalChannelOptions() {
    const scopeId = String(this.newDocModalScopeId || '').trim();
    return (this.channels || [])
      .filter((channel) => channel?.record_id && channel.record_state !== 'deleted')
      .filter((channel) => !scopeId || getPgChannelScopeId(channel) === scopeId)
      .map((channel) => ({
        id: channel.record_id,
        label: this.getChannelLabel?.(channel) || channel.title || channel.record_id,
        scopeId: getPgChannelScopeId(channel),
      }))
      .sort((left, right) => String(left.label || '').localeCompare(String(right.label || '')));
  },

  get filteredNewDocModalScopeOptions() {
    return this.filterNewDocModalOptions(this.newDocModalScopeOptions, this.newDocModalScopeQuery, ['label', 'title']);
  },

  get filteredNewDocModalChannelOptions() {
    return this.filterNewDocModalOptions(this.newDocModalChannelOptions, this.newDocModalChannelQuery, ['label']);
  },

  filterNewDocModalOptions(options = [], query = '', fields = ['label']) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => fields.some((field) =>
      String(option?.[field] || '').toLowerCase().includes(needle)));
  },

  get newDocModalSelectedScope() {
    return this.newDocModalScopeId ? this.scopesMap.get(this.newDocModalScopeId) || null : null;
  },

  get newDocModalScopeLabel() {
    const scope = this.newDocModalSelectedScope;
    if (!scope) return '';
    return this.getScopeBreadcrumb(scope.record_id) || scope.title || 'Selected scope';
  },

  get newDocModalSelectedChannel() {
    const channelId = String(this.newDocModalChannelId || '').trim();
    if (!channelId) return null;
    return (this.channels || []).find((channel) => channel?.record_id === channelId && channel.record_state !== 'deleted') || null;
  },

  get newDocModalContextSummary() {
    const scopeLabel = this.newDocModalScopeLabel || 'Select a scope';
    if (!isTowerPgBackendMode() || this.newDocModalType === 'folder') return scopeLabel;
    const channelLabel = this.getNewDocModalChannelOptionLabel(this.newDocModalChannelId);
    return channelLabel ? `${channelLabel} · ${scopeLabel}` : scopeLabel;
  },

  getNewDocModalScopeOptionLabel(scopeId) {
    const option = this.newDocModalScopeOptions.find((item) => item.id === scopeId);
    return option?.label || '';
  },

  getNewDocModalChannelOptionLabel(channelId) {
    const option = this.newDocModalChannelOptions.find((item) => item.id === channelId)
      || (this.channels || [])
        .filter((channel) => channel?.record_id && channel.record_state !== 'deleted')
        .map((channel) => ({
          id: channel.record_id,
          label: this.getChannelLabel?.(channel) || channel.title || channel.record_id,
        }))
        .find((item) => item.id === channelId);
    return option?.label || '';
  },

  selectNewDocModalScope(scopeId) {
    const scope = this.scopesMap?.get(scopeId) || null;
    this.newDocModalScopeId = scope?.record_id || null;
    this.newDocModalScopeQuery = this.getNewDocModalScopeOptionLabel(this.newDocModalScopeId);
    this.newDocModalScopeDropdownOpen = false;
    if (!isTowerPgBackendMode()) return;
    const channelStillValid = this.newDocModalChannelId
      && this.newDocModalChannelOptions.some((channel) => channel.id === this.newDocModalChannelId);
    if (!channelStillValid) {
      this.newDocModalChannelId = this.getDefaultDocChannelId(this.newDocModalScopeId);
      this.newDocModalChannelQuery = this.getNewDocModalChannelOptionLabel(this.newDocModalChannelId);
    }
  },

  openNewDocModalScopeDropdown() {
    this.newDocModalScopeDropdownOpen = true;
  },

  closeNewDocModalScopeDropdown() {
    this.newDocModalScopeDropdownOpen = false;
  },

  selectNewDocModalScopeFromQuery(value) {
    const query = String(value || '').trim();
    const lower = query.toLowerCase();
    const match = this.newDocModalScopeOptions.find((option) =>
      option.id === query
      || String(option.label || '').toLowerCase() === lower
      || String(option.title || '').toLowerCase() === lower);
    if (match) {
      this.selectNewDocModalScope(match.id);
      return;
    }
    this.newDocModalScopeQuery = this.getNewDocModalScopeOptionLabel(this.newDocModalScopeId);
    this.closeNewDocModalScopeDropdown();
  },

  selectNewDocModalChannel(channelId) {
    const channel = (this.channels || []).find((entry) => entry?.record_id === channelId && entry.record_state !== 'deleted') || null;
    this.newDocModalChannelId = channel?.record_id || null;
    this.newDocModalChannelQuery = this.getNewDocModalChannelOptionLabel(this.newDocModalChannelId);
    this.newDocModalChannelDropdownOpen = false;
    const scopeId = getPgChannelScopeId(channel);
    if (scopeId && this.scopesMap?.has(scopeId)) {
      this.newDocModalScopeId = scopeId;
      this.newDocModalScopeQuery = this.getNewDocModalScopeOptionLabel(scopeId);
    }
  },

  openNewDocModalChannelDropdown() {
    this.newDocModalChannelDropdownOpen = true;
  },

  closeNewDocModalChannelDropdown() {
    this.newDocModalChannelDropdownOpen = false;
  },

  selectNewDocModalChannelFromQuery(value) {
    const query = String(value || '').trim();
    const lower = query.toLowerCase();
    const match = this.newDocModalChannelOptions.find((option) =>
      option.id === query || String(option.label || '').toLowerCase() === lower);
    if (match) {
      this.selectNewDocModalChannel(match.id);
      return;
    }
    this.newDocModalChannelQuery = this.getNewDocModalChannelOptionLabel(this.newDocModalChannelId);
    this.closeNewDocModalChannelDropdown();
  },

  async confirmNewDocModal() {
    const title = this.newDocModalTitle.trim();
    const modalType = this.newDocModalType;
    if (!title || !modalType || this.newDocModalSubmitting) return;
    if (!this.newDocModalScopeId) {
      this.error = 'Select a scope before creating a document or folder.';
      return;
    }
    if (isTowerPgBackendMode() && modalType !== 'folder' && !this.newDocModalChannelId) {
      this.error = 'Select a channel before creating a document.';
      return;
    }
    this.newDocModalSubmitting = true;
    const scopeId = this.newDocModalScopeId;
    const channelId = this.newDocModalChannelId;
    try {
      if (modalType === 'folder') {
        await this.createDirectory(title, { scopeId });
      } else {
        await this.createDocument(title, { scopeId, channelId });
      }
    } finally {
      this.closeNewDocModal();
      this.newDocModalSubmitting = false;
    }
  },

  getSelectedDirectoryChildren() {
    if (!this.selectedDirectory) return [];
    return [
      ...this.directories
        .filter((item) => item.parent_directory_id === this.selectedDirectory.record_id && item.record_state !== 'deleted')
        .map((item) => ({ type: 'directory', item })),
      ...this.documents
        .filter((item) => item.parent_directory_id === this.selectedDirectory.record_id && item.record_state !== 'deleted')
        .map((item) => ({ type: 'document', item })),
    ].sort((a, b) => String(a.item.title || '').localeCompare(String(b.item.title || '')));
  },

  getDocItemLocationLabel(item) {
    if (!item?.parent_directory_id) return 'Root';
    const parent = this.directories.find((directory) => directory.record_id === item.parent_directory_id);
    return parent?.title || 'Root';
  },

  getDocItemShareSummary(item) {
    if (!item) return 'Private';
    const shares = this.getEffectiveDocShares(item);
    if (shares.length === 0) return 'Private';
    return shares
      .map((share) => (share.type === 'person'
        ? this.getSenderName(share.person_npub)
        : (share.label || 'Group')))
      .join(', ');
  },

  addDocShareFromSuggestion(suggestion) {
    if (!suggestion) return;

    const nextShare = suggestion.type === 'person'
      ? {
        type: 'person',
        key: `person:${suggestion.npub}`,
        access: 'read',
        label: suggestion.label,
        person_npub: suggestion.npub,
        group_npub: null,
        via_group_npub: null,
      }
      : {
        type: 'group',
        key: `group:${suggestion.group_npub}`,
        access: 'read',
        label: suggestion.label,
        person_npub: null,
        group_id: suggestion.group_npub,
        group_npub: suggestion.group_npub,
        via_group_id: null,
        via_group_npub: null,
      };

    this.docEditorShares = this.mergeDocShareLists(this.docEditorShares, [nextShare]);
    this.docEditorSharesDirty = true;
    this.docShareQuery = '';
  },

  updateDocShareAccess(shareKey, access) {
    if (this.isInheritedDocShare(shareKey)) return;
    this.docEditorShares = this.docEditorShares.map((share) =>
      share.key === shareKey
        ? { ...share, access: access === 'write' ? 'write' : 'read' }
        : share
    );
    this.docEditorSharesDirty = true;
  },

  removeDocShare(shareKey) {
    if (this.isInheritedDocShare(shareKey)) return;
    this.docEditorShares = this.docEditorShares.filter((share) => share.key !== shareKey);
    this.docEditorSharesDirty = true;
  },

  async ensureDirectShareGroup(personNpub) {
    const ownerNpub = this.session?.npub;
    if (!ownerNpub) throw new Error('Sign in first');

    const existing = this.groups.find((group) => {
      const members = [...new Set(group.member_npubs ?? [])].sort();
      return members.length === 2
        && members[0] === [ownerNpub, personNpub].sort()[0]
        && members[1] === [ownerNpub, personNpub].sort()[1];
    });
    if (existing) {
      return existing.group_id || existing.group_npub;
    }

    const group = await this.createEncryptedGroup(
      `Direct: ${this.getSenderName(personNpub)}`,
      [personNpub],
    );
    await this.rememberPeople([personNpub], 'share');
    return group.group_id;
  },

  async materializeDocSharesForSync() {
    const shares = [];

    for (const share of this.docEditorShares) {
      if (share.type === 'person' && share.person_npub) {
        const viaGroup = share.via_group_id || share.via_group_npub || await this.ensureDirectShareGroup(share.person_npub);
        shares.push({
          ...share,
          via_group_id: viaGroup,
          via_group_npub: viaGroup,
        });
      } else if (share.type === 'group' && (share.group_id || share.group_npub)) {
        shares.push({
          ...share,
          group_id: share.group_id || share.group_npub || null,
        });
      }
    }

    return shares;
  },

  async saveDocShareTarget() {
    const target = this.activeDocShareTarget;
    if (!target) {
      this.error = 'Select a document or folder first';
      return;
    }
    if (!this.docEditorSharesDirty) {
      this.closeDocShareModal();
      return;
    }

    if (this.docShareTargetType === 'directory') {
      await this.saveSelectedDirectoryItem();
    } else {
      await this.saveSelectedDocItem({ autosave: false });
    }
    this.closeDocShareModal();
  },

  getDefaultParentDirectoryId() {
    if (this.currentFolderId) return this.currentFolderId;
    if (this.selectedDocument?.parent_directory_id) return this.selectedDocument.parent_directory_id;
    return null;
  },

  getDefaultDocScopeId(parentDirectoryId = null) {
    const inherited = this.getDirectoryDefaultScopeAssignment(parentDirectoryId);
    if (inherited?.scope_id && this.scopesMap?.has(inherited.scope_id)) return inherited.scope_id;
    if (isTowerPgBackendMode() && this.selectedChannel?.scope_id && this.scopesMap?.has(this.selectedChannel.scope_id)) {
      return this.selectedChannel.scope_id;
    }
    if (this.selectedBoardScope?.record_id) return this.selectedBoardScope.record_id;
    if (this.selectedBoardId && this.scopesMap?.has(this.selectedBoardId)) return this.selectedBoardId;
    return null;
  },

  getDefaultDocChannelId(scopeId = null) {
    if (!isTowerPgBackendMode()) return null;
    const requestedScopeId = String(scopeId || '').trim();
    const context = this.resolvePgWriteContext?.({
      scopeId: requestedScopeId,
      channelId: this.pgContextSelectedChannelId || this.selectedChannelId,
      boardId: this.selectedBoardId,
    }) || null;
    if (context?.channelId) return context.channelId;
    const selectedChannel = this.selectedChannel?.record_id ? this.selectedChannel : null;
    if (selectedChannel && (!requestedScopeId || getPgChannelScopeId(selectedChannel) === requestedScopeId)) {
      return selectedChannel.record_id;
    }
    const scopedChannels = (this.channels || [])
      .filter((channel) => channel?.record_id && channel.record_state !== 'deleted')
      .filter((channel) => !requestedScopeId || getPgChannelScopeId(channel) === requestedScopeId);
    return scopedChannels.length === 1 ? scopedChannels[0].record_id : null;
  },

  buildDocAccessForScope(scopeId, shares = []) {
    const scope = this.scopesMap?.get(scopeId) || null;
    if (!scope?.record_id) return null;
    const scopePolicyGroupIds = this.getResolvedScopePolicyGroupIds(scope.record_id);
    const scopeShares = this.buildScopeDefaultShares(scopePolicyGroupIds);
    const mergedShares = this.mergeDocShareLists(scopeShares, shares);
    const deliveryGroupIds = normalizeGroupIds([
      ...scopePolicyGroupIds,
      ...this.getShareGroupIds(mergedShares),
    ]);
    return {
      ...this.buildScopeAssignment(scope.record_id),
      scope_policy_group_ids: scopePolicyGroupIds,
      shares: mergedShares,
      group_ids: deliveryGroupIds,
      write_group_id: scopePolicyGroupIds[0] || deliveryGroupIds[0] || null,
    };
  },

  getDefaultPrivateShares() {
    const groupRef = this.memberPrivateGroupRef || this.memberPrivateGroupNpub;
    if (!groupRef) return [];
    return [{
      type: 'group',
      key: `group:${groupRef}`,
      access: 'write',
      label: this.memberPrivateGroup?.name || 'Private',
      person_npub: null,
      group_id: groupRef,
      group_npub: this.memberPrivateGroup?.group_npub || this.memberPrivateGroupNpub || groupRef,
      via_group_id: null,
      via_group_npub: null,
      inherited: false,
      inherited_from_directory_id: null,
    }];
  },

  getShareGroupIds,

  async createDirectory(title = 'New directory', options = {}) {
    if (isTowerPgBackendMode()) {
      this.error = 'Folders are not available in Tower PG mode. Use scopes, channels, and threads for structure.';
      return null;
    }
    const ownerNpub = this.workspaceOwnerNpub;
    if (!ownerNpub) {
      this.error = 'Sign in first';
      return null;
    }

    const parentDirectoryId = this.getDefaultParentDirectoryId();
    const scopeId = options.scopeId || this.getDefaultDocScopeId(parentDirectoryId);
    const scopedAccess = this.buildDocAccessForScope(scopeId, this.getInheritedDirectoryShares(parentDirectoryId));
    if (!scopedAccess?.scope_id) {
      this.error = 'Select a scope before creating a folder.';
      return;
    }
    const recordId = crypto.randomUUID();
    const now = new Date().toISOString();
    let row = {
      record_id: recordId,
      owner_npub: ownerNpub,
      title,
      parent_directory_id: parentDirectoryId,
      ...scopedAccess,
      sync_status: 'pending',
      record_state: 'active',
      version: 1,
      updated_at: now,
    };
    row = this.normalizeDirectoryRowGroupRefs(row);

    await upsertDirectory(row);
    this.patchDirectoryLocal(row);
    try {
      const missingGroupRefs = await this.ensureDocGroupKeysLoaded(row);
      if (missingGroupRefs.length > 0) {
        throw new Error(`Folder write is missing group keys: ${missingGroupRefs.join(', ')}`);
      }
      await queueTowerPendingWrite(this, {
        record_id: recordId,
        record_family_hash: recordFamilyHash('directory'),
        envelope: await this.buildManagedDirectoryEnvelope({
          record_id: recordId,
          owner_npub: ownerNpub,
          title: row.title,
          parent_directory_id: row.parent_directory_id,
          scope_id: row.scope_id ?? null,
          scope_l1_id: row.scope_l1_id ?? null,
          scope_l2_id: row.scope_l2_id ?? null,
          scope_l3_id: row.scope_l3_id ?? null,
          scope_l4_id: row.scope_l4_id ?? null,
          scope_l5_id: row.scope_l5_id ?? null,
          scope_policy_group_ids: row.scope_policy_group_ids ?? null,
          shares: row.shares,
          group_ids: row.group_ids,
          signature_npub: this.signingNpub,
          write_group_ref: this.getPreferredDocWriteGroupRef(row),
        }, row, { intent: 'create' }),
      });
    } catch (error) {
      await this.markDocRecordWriteFailed('directory', row, error);
      await this.refreshDirectories();
      this.navigateToFolder(recordId);
      return;
    }

    await this.refreshDirectories();
    this.navigateToFolder(recordId);
    await this.flushAndBackgroundSync();
  },

  async createDocument(title = 'Untitled document', options = {}) {
    const ownerNpub = this.workspaceOwnerNpub;
    if (!ownerNpub) {
      this.error = 'Sign in first';
      return;
    }

    const parentDirectoryId = this.getDefaultParentDirectoryId();
    let pgContext = null;
    let scopeId = options.scopeId || this.getDefaultDocScopeId(parentDirectoryId);
    if (isTowerPgBackendMode()) {
      pgContext = this.resolvePgWriteContext?.({
        scopeId,
        channelId: options.channelId,
        threadId: options.threadId,
        boardId: options.boardId || this.selectedBoardId,
      }) || null;
      if (!pgContext) {
        return this.openWriteContextModal?.('document', { title, options }) || null;
      }
      scopeId = pgContext.scopeId;
    }
    const scopedAccess = this.buildDocAccessForScope(scopeId, this.getInheritedDirectoryShares(parentDirectoryId));
    if (!scopedAccess?.scope_id) {
      this.error = 'Select a scope before creating a document.';
      return null;
    }
    const recordId = crypto.randomUUID();
    const now = new Date().toISOString();
    const initialContent = typeof options.initialContent === 'string' ? options.initialContent : '';
    const contentModel = createDocumentEditorState({ content: initialContent, content_blocks: [] }).contentModel;
    if (pgContext) {
      try {
        const pgWorkspaceContext = resolveTowerPgWorkspaceContext(this);
        const pgWorkspaceOwnerNpub = pgWorkspaceContext.workspaceOwnerNpub || ownerNpub;
        const contentPayload = await this.prepareDocumentContentForEnvelope({
          record_id: recordId,
          owner_npub: pgWorkspaceOwnerNpub,
          title,
        }, contentModel, [], null, { pgStorageContext: pgWorkspaceContext });
        const accepted = await createTowerPgDocFromLocal(this, {
          record_id: recordId,
          owner_npub: pgWorkspaceOwnerNpub,
          title,
          ...contentModel,
          ...contentPayload,
          ...scopedAccess,
          pg_channel_id: pgContext.channelId,
          pg_thread_id: pgContext.threadId || null,
        });
        const acceptedRow = {
          ...accepted,
          content: contentModel.content,
          content_format: contentModel.content_format,
          content_blocks: contentModel.content_blocks,
          editor_state: contentModel.editor_state,
          editor_state_format: contentModel.editor_state_format,
          editor_state_version: contentModel.editor_state_version,
          content_storage_object_id: contentPayload.content_storage_object_id,
          content_storage_format: contentPayload.content_storage_format,
          content_storage_content_type: contentPayload.content_storage_content_type,
          content_size_bytes: contentPayload.content_size_bytes,
          content_sha256_hex: contentPayload.content_sha256_hex,
          content_storage_status: 'remote',
          content_storage_error: null,
          pg_canonical_version_id: canonicalDocVersionId(accepted),
          pg_canonical_storage_object_id: contentPayload.content_storage_object_id,
          pg_canonical_body_sha256_hex: contentPayload.content_sha256_hex,
          pg_canonical_size_bytes: contentPayload.content_size_bytes,
          pg_thread_id: pgContext.threadId || accepted.pg_thread_id || null,
        };
        await upsertDocument(acceptedRow);
        this.patchDocumentLocal(acceptedRow);
        if (options.open !== false) this.openDoc(accepted.record_id);
        Promise.resolve()
          .then(() => this.refreshDocuments())
          .catch((refreshError) => {
            console.warn('[flightdeck] PG document refresh failed after create', refreshError);
          });
        return acceptedRow;
      } catch (error) {
        if (options.throwOnError) throw error;
        const localRow = this.normalizeDocumentRowGroupRefs({
          record_id: recordId,
          owner_npub: ownerNpub,
          title,
          ...contentModel,
          source_links: normalizeRecordLinkList(options.sourceLinks || [], 'source'),
          references: [],
          deliverable_links: normalizeRecordLinkList(options.deliverableLinks || [], 'deliverable'),
          parent_directory_id: parentDirectoryId,
          ...scopedAccess,
          pg_backend: true,
          pg_record_type: 'doc',
          pg_channel_id: pgContext.channelId,
          pg_thread_id: pgContext.threadId || null,
          sync_status: 'failed',
          record_state: 'active',
          version: 1,
          created_at: now,
          updated_at: now,
        });
        await upsertDocument(localRow);
        this.patchDocumentLocal(localRow);
        this.openDoc(localRow.record_id);
        this.error = isOnlineForPgEdit()
          ? (error?.message || 'Could not create PG document.')
          : 'PG document saved locally. Reconnect to sync it.';
        return localRow;
      }
    }
    let row = {
      record_id: recordId,
      owner_npub: ownerNpub,
      title,
      ...contentModel,
      source_links: normalizeRecordLinkList(options.sourceLinks || [], 'source'),
      references: [],
      deliverable_links: normalizeRecordLinkList(options.deliverableLinks || [], 'deliverable'),
      parent_directory_id: parentDirectoryId,
      ...scopedAccess,
      ...(pgContext ? {
        pg_channel_id: pgContext.channelId,
        pg_thread_id: pgContext.threadId || null,
      } : {}),
      sync_status: 'pending',
      record_state: 'active',
      version: 1,
      updated_at: now,
    };
    row = this.normalizeDocumentRowGroupRefs(row);

    await upsertDocument(row);
    this.patchDocumentLocal(row);
    try {
      const missingGroupRefs = await this.ensureDocGroupKeysLoaded(row);
      if (missingGroupRefs.length > 0) {
        throw new Error(`Document write is missing group keys: ${missingGroupRefs.join(', ')}`);
      }
      await queueTowerPendingWrite(this, {
        record_id: recordId,
        record_family_hash: recordFamilyHash('document'),
        envelope: await this.buildManagedDocumentEnvelope({
          record_id: recordId,
          owner_npub: ownerNpub,
          title: row.title,
          content: row.content,
          parent_directory_id: row.parent_directory_id,
          scope_id: row.scope_id ?? null,
          scope_l1_id: row.scope_l1_id ?? null,
          scope_l2_id: row.scope_l2_id ?? null,
          scope_l3_id: row.scope_l3_id ?? null,
          scope_l4_id: row.scope_l4_id ?? null,
          scope_l5_id: row.scope_l5_id ?? null,
          scope_policy_group_ids: row.scope_policy_group_ids ?? null,
          source_links: row.source_links ?? [],
          references: row.references ?? [],
          deliverable_links: row.deliverable_links ?? [],
          shares: row.shares,
          group_ids: row.group_ids,
          signature_npub: this.signingNpub,
          write_group_ref: this.getPreferredDocWriteGroupRef(row),
        }, row, { intent: 'create' }),
      });
    } catch (error) {
      await this.markDocRecordWriteFailed('document', row, error);
      await this.refreshDocuments();
      if (options.open !== false) this.openDoc(recordId);
      return;
    }

    await this.refreshDocuments();
    if (options.open !== false) this.openDoc(recordId);
    await this.flushAndBackgroundSync();
    return row;
  },

  async saveSelectedDirectoryItem() {
    this.error = null;
    const item = this.activeDocShareTarget;
    const ownerNpub = this.workspaceOwnerNpub;
    if (!item || this.docShareTargetType !== 'directory' || !ownerNpub) {
      this.error = 'Select a folder first';
      return;
    }
    if (!item.scope_id) {
      this.error = 'Select a scope before saving folder sharing.';
      return;
    }
    this.assertCanMutateLockManagedRecord(item, recordFamilyHash('directory'));
    await this.ensureLockManagedCheckout(item, recordFamilyHash('directory'), { intent: 'edit' });

    const currentSharesSerialized = this.serializeDocShares(this.getEffectiveDocShares(item));
    const editorSharesSerialized = this.serializeDocShares(this.docEditorShares || []);
    if (currentSharesSerialized === editorSharesSerialized) {
      this.docEditorSharesDirty = false;
      return item;
    }

    const shares = this.docEditorSharesDirty
      ? await this.materializeDocSharesForSync()
      : this.getStoredDocShares(item);
    const now = new Date().toISOString();
    const nextVersion = (item.version ?? 1) + 1;
    const draft = {
      ...item,
      shares,
      group_ids: this.getShareGroupIds(shares),
      write_group_id: item.write_group_id || null,
    };
    const scopePolicyPatch = item.scope_id
      ? (this.shouldRefreshScopedPolicy(draft, item.scope_id)
        ? this.buildScopedPolicyRepairPatch(draft, { scopeId: item.scope_id })
        : { scope_policy_group_ids: this.getResolvedScopePolicyGroupIds(item.scope_id) })
      : { scope_policy_group_ids: null };
    const updated = this.normalizeDirectoryRowGroupRefs({
      ...draft,
      ...scopePolicyPatch,
      sync_status: 'pending',
      version: nextVersion,
      updated_at: now,
    });

    await upsertDirectory(updated);
    this.patchDirectoryLocal(updated);
    try {
      const missingGroupRefs = await this.ensureDocGroupKeysLoaded(updated);
      if (missingGroupRefs.length > 0) {
        throw new Error(`Folder write is missing group keys: ${missingGroupRefs.join(', ')}`);
      }
      await queueTowerPendingWrite(this, {
        record_id: item.record_id,
        record_family_hash: recordFamilyHash('directory'),
        envelope: await this.buildManagedDirectoryEnvelope({
          record_id: item.record_id,
          owner_npub: ownerNpub,
          title: updated.title,
          parent_directory_id: updated.parent_directory_id,
          scope_id: updated.scope_id ?? null,
          scope_l1_id: updated.scope_l1_id ?? null,
          scope_l2_id: updated.scope_l2_id ?? null,
          scope_l3_id: updated.scope_l3_id ?? null,
          scope_l4_id: updated.scope_l4_id ?? null,
          scope_l5_id: updated.scope_l5_id ?? null,
          scope_policy_group_ids: updated.scope_policy_group_ids ?? null,
          shares,
          group_ids: updated.group_ids,
          version: nextVersion,
          previous_version: item.version ?? 1,
          signature_npub: this.signingNpub,
          write_group_ref: this.getPreferredDocWriteGroupRef(updated),
        }, item, { intent: 'edit' }),
      });
    } catch (error) {
      await this.markDocRecordWriteFailed('directory', updated, error);
      throw error;
    }

    await this.flushAndBackgroundSync();
    await this.refreshDirectories();
    await this.refreshDocuments();
    this.docEditorSharesDirty = false;
    return updated;
  },

  async saveSelectedDocItem(options = {}) {
    const autosave = options.autosave === true;
    this.error = null;
    if (Number(this.docRichImageUploadCount || 0) > 0) {
      this.docAutosaveState = 'pending';
      if (!autosave) this.error = 'Wait for pasted images to finish uploading before saving this document.';
      return null;
    }
    const item = this.selectedDocument;
    const ownerNpub = this.workspaceOwnerNpub;
    if (!item || !ownerNpub) {
      if (!autosave) this.error = 'Select a document first';
      return;
    }
    if (!item.scope_id) {
      this.docAutosaveState = autosave ? 'error' : this.docAutosaveState;
      if (!autosave) this.error = 'Select a scope before saving this document.';
      return;
    }
    if (isTowerPgBackendMode()) {
      const recordId = item.record_id;
      this.pgDocSavePromises = this.pgDocSavePromises || {};
      const previousSave = this.pgDocSavePromises[recordId] || null;
      const savePromise = (async () => {
        if (previousSave) await previousSave.catch(() => {});
        const latest = this.selectedDocument;
        if (!latest || latest.record_id !== recordId) return null;
        return this.saveSelectedPgDocItem(latest, this.workspaceOwnerNpub, options);
      })();
      this.pgDocSavePromises[recordId] = savePromise;
      try {
        return await savePromise;
      } finally {
        if (this.pgDocSavePromises?.[recordId] === savePromise) {
          delete this.pgDocSavePromises[recordId];
        }
      }
    }
    this.assertCanMutateLockManagedRecord(item, recordFamilyHash('document'), { autosave });
    await this.ensureLockManagedCheckout(item, recordFamilyHash('document'), {
      autosave,
      intent: 'edit',
      reportError: autosave !== true,
    });

    const nextTitle = this.docEditorTitle.trim() || 'Untitled document';
    const currentSharesSerialized = this.serializeDocShares(this.getEffectiveDocShares(item));
    const editorSharesSerialized = this.serializeDocShares(this.docEditorShares || []);
    const contentModel = this.buildSelectedDocContentModel();
    const nextReferences = mergeDocumentSaveReferences(item, parseRecordReferencesFromText(contentModel.content));
    const nextLinksSerialized = JSON.stringify(buildRecordLinkPayload({
      ...item,
      references: nextReferences,
    }));
    const currentLinksSerialized = JSON.stringify(buildRecordLinkPayload(item));
    const hasChanges = nextTitle !== (item.title ?? 'Untitled document')
      || (contentModel.content || '') !== (item.content || '')
      || currentSharesSerialized !== editorSharesSerialized
      || nextLinksSerialized !== currentLinksSerialized;
    if (!hasChanges) {
      this.docAutosaveState = 'saved';
      return;
    }

    const shares = this.docEditorSharesDirty
      ? await this.materializeDocSharesForSync()
      : this.getStoredDocShares(item);
    const now = new Date().toISOString();
    const nextVersion = (item.version ?? 1) + 1;
    this.docAutosaveState = 'saving';
    try {
      const draft = {
        ...item,
        title: nextTitle,
        ...contentModel,
        references: nextReferences,
        shares,
        group_ids: this.getShareGroupIds(shares),
        write_group_id: item.write_group_id || null,
      };
      const scopePolicyPatch = item.scope_id
        ? (this.shouldRefreshScopedPolicy(draft, item.scope_id)
          ? this.buildScopedPolicyRepairPatch(draft, { scopeId: item.scope_id })
          : { scope_policy_group_ids: this.getResolvedScopePolicyGroupIds(item.scope_id) })
        : { scope_policy_group_ids: null };
      const updated = this.normalizeDocumentRowGroupRefs({
        ...draft,
        ...scopePolicyPatch,
        sync_status: 'pending',
        version: nextVersion,
        updated_at: now,
      });
      await upsertDocument(updated);
      this.patchDocumentLocal(updated);
      const missingGroupRefs = await this.ensureDocGroupKeysLoaded(updated);
      if (missingGroupRefs.length > 0) {
        throw new Error(`Document write is missing group keys: ${missingGroupRefs.join(', ')}`);
      }
      await queueTowerPendingWrite(this, {
        record_id: item.record_id,
        record_family_hash: recordFamilyHash('document'),
        envelope: await this.buildManagedDocumentEnvelope({
          record_id: item.record_id,
          owner_npub: ownerNpub,
          title: updated.title,
          content: updated.content,
          parent_directory_id: updated.parent_directory_id,
          scope_id: updated.scope_id ?? null,
          scope_l1_id: updated.scope_l1_id ?? null,
          scope_l2_id: updated.scope_l2_id ?? null,
          scope_l3_id: updated.scope_l3_id ?? null,
          scope_l4_id: updated.scope_l4_id ?? null,
          scope_l5_id: updated.scope_l5_id ?? null,
          scope_policy_group_ids: updated.scope_policy_group_ids ?? null,
          source_links: updated.source_links ?? [],
          references: updated.references ?? [],
          deliverable_links: updated.deliverable_links ?? [],
          shares,
          group_ids: updated.group_ids,
          version: nextVersion,
          previous_version: item.version ?? 1,
          signature_npub: this.signingNpub,
          write_group_ref: this.getPreferredDocWriteGroupRef(updated),
        }, item, { intent: 'edit' }),
      });

      await this.flushAndBackgroundSync();
      await this.refreshDirectories();
      await this.refreshDocuments();
      this.docEditorSharesDirty = false;
      this.docAutosaveState = 'saved';
      this.ensureBackgroundSync(true);
      return updated;
    } catch (error) {
      if (this.selectedDocument?.record_id) {
        await this.markDocRecordWriteFailed('document', {
          ...this.selectedDocument,
          title: nextTitle,
          content: this.docEditorContent,
        }, error);
      }
      this.docAutosaveState = 'error';
      throw error;
    }
  },

  async saveSelectedPgDocItem(item, ownerNpub, options = {}) {
    const autosave = options.autosave === true;
    const nextTitle = this.docEditorTitle.trim() || 'Untitled document';
    const itemVersion = Number(item.version || item.row_version || 0);
    const baseVersion = Number(this.docEditBaseRowVersion || 0);
    const titleChanged = nextTitle !== (item.title ?? 'Untitled document');
    const knownStaleBase = itemVersion > baseVersion
      || this.docEditAccessState === 'recovery'
      || Boolean(this.docRecovery);
    if (isSyncedPgRecord(item) && baseVersion > 0 && itemVersion > baseVersion) {
      if (!this.docEditDraftDirty && !titleChanged && !this.docEditorSharesDirty) {
        if (isDocumentContentReadyForEditor(item)) {
          this.applySelectedDocAuthoritativeContent(item, { preserveSelection: true });
        }
        if (!this.docRecovery) await this.clearSelectedDocDraft(item);
        return item;
      }
      this.docEditConflict = {
        baseVersion,
        currentVersion: itemVersion,
        currentHead: documentEditorBaseIdentity(item),
      };
      this.docEditAccessState = 'recovery';
      this.docEditAccessMessage = 'Tower has a newer head. Saving will preserve this draft as a non-head recovery version.';
      this.docRichEditorAdapter?.setEditable?.(true);
    }
    const contentModel = this.buildSelectedDocContentModel();
    const visibleEditorText = this.docEditorMode === 'rich' ? this.getVisibleDocRichEditorText() : '';
    const normalizedVisibleText = normalizedDocumentPlainText(visibleEditorText);
    const normalizedSerializedText = normalizedDocumentPlainText(proseMirrorPlainText(contentModel.editor_state));
    if (normalizedVisibleText
      && (!normalizedSerializedText || normalizedVisibleText.length > normalizedSerializedText.length)) {
      // A stale adapter can still serialize the last accepted body while a
      // duplicate visible editor contains a much longer draft. Preserve the
      // complete visible text as a plain recovery model before refusing Save;
      // keeping edit mode open also retains the original rich DOM in memory.
      const recoveryModel = createDocumentEditorState({
        content: visibleEditorText,
        content_blocks: [],
      }).contentModel;
      this.docEditorContent = recoveryModel.content;
      this.docEditorBlocks = normalizeDocumentBlocks(recoveryModel.content_blocks, recoveryModel.content);
      this.docEditorProseMirrorState = recoveryModel.editor_state;
      this.docEditorContentModel = recoveryModel;
      this.docAutosaveState = 'error';
      await this.persistSelectedDocDraft({ integrityError: 'visible_editor_content_exceeds_serialized_model' });
      if (!autosave) {
        this.error = 'The visible document did not match the save model. Your complete text is still open and stored as a recovery draft; please retry Save.';
      }
      return null;
    }
    if (!this.docEditDraftDirty && !titleChanged && !this.docEditorSharesDirty) {
      this.docAutosaveState = 'saved';
      if (!this.docRecovery) await this.clearSelectedDocDraft(item);
      return item;
    }
    await this.persistSelectedDocDraft();
    const roundTrip = validateDocumentContentModelRoundTrip(contentModel);
    if (!roundTrip.ok) {
      this.docAutosaveState = 'error';
      this.docEditAccessMessage = 'Save paused because the editor could not preserve the complete document. Your draft is still open and Tower was not changed.';
      await this.persistSelectedDocDraft({ integrityError: roundTrip.reason || 'content_model_round_trip_failed' });
      if (!autosave) this.error = this.docEditAccessMessage;
      return null;
    }
    const nextReferences = mergeDocumentSaveReferences(item, parseRecordReferencesFromText(contentModel.content));
    const nextLinksSerialized = JSON.stringify(buildRecordLinkPayload({
      ...item,
      references: nextReferences,
    }));
    const currentLinksSerialized = JSON.stringify(buildRecordLinkPayload(item));
    const hasChanges = (knownStaleBase && this.docEditDraftDirty)
      || nextTitle !== (item.title ?? 'Untitled document')
      || (contentModel.content || '') !== (item.content || '')
      || nextLinksSerialized !== currentLinksSerialized;
    if (!hasChanges) {
      this.docAutosaveState = 'saved';
      this.docEditDraftDirty = false;
      await this.clearSelectedDocDraft(item);
      return item;
    }
    const pgSession = getPgEditLeaseSession(this, 'document', item.record_id);
    const pgLeaseToken = pgSession?.lease?.lease_token;
    const baseAvailable = this.docEditBaseAvailable === true
      && baseVersion > 0
      && Boolean(this.docEditBaseBodySha256Hex);
    const requiresCanonicalLease = isSyncedPgRecord(item) && baseAvailable && !knownStaleBase;
    if (requiresCanonicalLease && !pgLeaseToken) {
      this.docAutosaveState = 'error';
      if (!autosave) this.error = 'Acquire a PG edit lease before saving this document.';
      return null;
    }

    this.docAutosaveState = 'saving';
    try {
      if (isUnsyncedLocalPgRecord(item)) {
        const localUpdated = {
          ...item,
          title: nextTitle,
          ...contentModel,
          references: nextReferences,
          sync_status: isOnlineForPgEdit() ? 'pending' : 'failed',
          updated_at: new Date().toISOString(),
        };
        await upsertDocument(localUpdated);
        this.patchDocumentLocal(localUpdated);
        if (!isOnlineForPgEdit()) {
          this.docAutosaveState = 'saved';
          this.docEditorSharesDirty = false;
          return localUpdated;
        }
        try {
          const pgWorkspaceContext = resolveTowerPgWorkspaceContext(this);
          const contentPayload = await this.prepareDocumentContentForEnvelope({
            record_id: localUpdated.record_id,
            owner_npub: pgWorkspaceContext.workspaceOwnerNpub || ownerNpub,
            title: nextTitle,
          }, contentModel, [], null, { pgStorageContext: pgWorkspaceContext });
          const accepted = await createTowerPgDocFromLocal(this, {
            ...localUpdated,
            ...contentPayload,
          });
          const canonical = {
            ...accepted,
            content: contentModel.content,
            content_format: contentModel.content_format,
            content_blocks: contentModel.content_blocks,
            editor_state: contentModel.editor_state ?? null,
            editor_state_format: contentModel.editor_state_format ?? null,
            editor_state_version: contentModel.editor_state_version ?? null,
            content_storage_object_id: contentPayload.content_storage_object_id,
            content_storage_format: contentPayload.content_storage_format,
            content_storage_content_type: contentPayload.content_storage_content_type,
            content_size_bytes: contentPayload.content_size_bytes,
            content_sha256_hex: contentPayload.content_sha256_hex,
            content_storage_status: 'remote',
            content_storage_error: null,
            pg_canonical_version_id: canonicalDocVersionId(accepted),
            pg_canonical_storage_object_id: contentPayload.content_storage_object_id,
            pg_canonical_body_sha256_hex: contentPayload.content_sha256_hex,
            pg_canonical_size_bytes: contentPayload.content_size_bytes,
            references: nextReferences,
          };
          await replaceDocumentRecord(localUpdated.record_id, canonical);
          this.documents = (this.documents || []).filter((document) => document.record_id !== localUpdated.record_id);
          this.patchDocumentLocal(canonical);
          if (this.selectedDocId === localUpdated.record_id) this.selectedDocId = canonical.record_id;
          this.setSelectedDocBaseIdentity(documentEditorBaseIdentity(canonical));
          this.docEditDraftDirty = false;
          await this.clearSelectedDocDraft(canonical);
          this.docAutosaveState = 'saved';
          this.docEditorSharesDirty = false;
          return canonical;
        } catch (error) {
          const failed = { ...localUpdated, sync_status: 'failed', updated_at: new Date().toISOString() };
          await upsertDocument(failed);
          this.patchDocumentLocal(failed);
          if (!autosave) this.error = error?.message || 'Failed to sync local PG document.';
          this.docAutosaveState = 'error';
          throw error;
        }
      }
      const pgWorkspaceContext = resolveTowerPgWorkspaceContext(this);
      const storageReuseRecord = this.docLocalDraft?.submitted_storage_object_id
        ? {
            ...item,
            content_storage_object_id: this.docLocalDraft.submitted_storage_object_id,
            content_sha256_hex: this.docLocalDraft.submitted_body_sha256_hex,
          }
        : item;
      const contentPayload = await this.prepareDocumentContentForEnvelope({
        record_id: item.record_id,
        owner_npub: pgWorkspaceContext.workspaceOwnerNpub || ownerNpub,
        title: nextTitle,
      }, contentModel, [], storageReuseRecord, { pgStorageContext: pgWorkspaceContext });
      const updated = {
        ...item,
        title: nextTitle,
        ...contentModel,
        ...contentPayload,
        references: nextReferences,
        pg_save_base_available: baseAvailable,
        pg_save_base_row_version: baseVersion || undefined,
        pg_save_base_version_id: this.docEditBaseVersionId || undefined,
        pg_save_base_body_sha256_hex: this.docEditBaseBodySha256Hex || undefined,
        pg_save_requires_lease: requiresCanonicalLease,
        sync_status: 'pending',
        updated_at: new Date().toISOString(),
      };
      const accepted = await updateTowerPgDocFromLocal(this, updated, item);
      const canonical = accepted;
      await upsertDocument(canonical);
      if (this.docEditDraftDirty) {
        await this.persistSelectedDocDraft();
      } else {
        await this.clearSelectedDocDraft(canonical);
      }
      this.docAutosaveState = this.docEditDraftDirty ? 'pending' : 'saved';
      this.docEditorSharesDirty = false;
      if (this.docEditDraftDirty) this.scheduleDocAutosave();
      return canonical;
    } catch (error) {
      if (isPgDocumentRecoveryCreatedError(error)) {
        const payload = error.payload || JSON.parse(error.responseText || '{}');
        const recovery = payload?.recovery || null;
        const currentHead = payload?.current_head || null;
        this.docRecovery = recovery;
        this.docEditConflict = {
          baseVersion,
          currentVersion: Number(currentHead?.row_version || itemVersion || 0),
          currentHead,
        };
        this.docEditAccessState = 'recovery';
        this.docEditAccessMessage = 'Tower preserved this draft as a recovery version. Continue editing, promote it against the current head, or discard it.';
        this.docEditDraftDirty = false;
        this.docAutosaveState = 'saved';
        this.docRichEditorAdapter?.setEditable?.(true);
        await this.persistSelectedDocDraft({
          status: 'recovery',
          remoteOutcome: {
            status: 'recovery',
            code: payload?.code || 'document_recovery_created',
            at: new Date().toISOString(),
            idempotent_replay: payload?.idempotent_replay === true,
          },
          submittedStorageObjectId: recovery?.submitted_body?.storage_object_id || null,
          submittedBodySha256Hex: recovery?.submitted_body?.body_sha256_hex || null,
        });
        void releasePgEditLeaseForRecord(this, item, 'document', { reportError: false });
        return null;
      }
      if (isPgStaleRowVersionError(error)) {
        await this.refreshDocuments?.();
        const fresh = this.documents.find((candidate) => candidate.record_id === item.record_id) || null;
        this.docEditConflict = {
          baseVersion,
          currentVersion: Number(fresh?.version || 0),
          currentHead: fresh ? documentEditorBaseIdentity(fresh) : null,
        };
        this.docEditAccessState = 'recovery';
        this.docEditAccessMessage = 'Tower rejected the stale base before creating a typed recovery. The local draft remains editable and will retry safely.';
        this.docRichEditorAdapter?.setEditable?.(true);
        await this.persistSelectedDocDraft({
          remoteOutcome: { status: 'error', code: error.code || 'stale_row_version', at: new Date().toISOString() },
        });
        void releasePgEditLeaseForRecord(this, item, 'document', { reportError: false });
        if (!autosave) this.error = this.docEditAccessMessage;
      } else if (!autosave) {
        this.error = error?.message || 'Failed to save PG document.';
      }
      if (!isPgStaleRowVersionError(error)) {
        await this.persistSelectedDocDraft({
          remoteOutcome: { status: 'error', code: error?.code || 'save_failed', at: new Date().toISOString() },
        });
      }
      this.docAutosaveState = 'error';
      throw error;
    }
  },

  async loadSelectedDocRecoveries(options = {}) {
    const item = this.selectedDocument;
    if (!isTowerPgBackendMode() || !item?.record_id || !isSyncedPgRecord(item)) return [];
    const context = resolveTowerPgWorkspaceContext(this);
    if (!context.workspaceId) return [];
    try {
      const result = await getTowerPgDocRecoveries(context.workspaceId, item.record_id, {
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
        state: options.state || 'open',
        limit: 50,
      });
      const recoveries = Array.isArray(result?.recoveries) ? result.recoveries : [];
      if (this.selectedDocId === item.record_id && recoveries.length > 0 && !this.docRecovery) {
        this.docRecovery = recoveries[0];
        if (!this.docEditDraftDirty) {
          this.docEditAccessState = 'recovery_available';
          this.docEditAccessMessage = 'Tower has a preserved recovery version for this document.';
        }
      }
      return recoveries;
    } catch (error) {
      if (options.reportError) this.error = error?.message || 'Failed to load document recoveries.';
      return [];
    }
  },

  async openSelectedDocRecoveryDraft(recoveryId = this.docRecovery?.id) {
    const item = this.selectedDocument;
    const context = resolveTowerPgWorkspaceContext(this);
    const id = String(recoveryId || '').trim();
    if (!item?.record_id || !context.workspaceId || !id) return false;
    try {
      const result = await getTowerPgDocRecoveryBody(context.workspaceId, item.record_id, id, {
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
      });
      const recovery = result?.recovery || this.docRecovery;
      const contentModel = decodeStoredRecoveryContent(result);
      if (!contentModel?.editor_state && typeof contentModel?.content !== 'string') {
        throw new Error('Recovery body did not contain an editable document model.');
      }
      const editorState = createDocumentEditorState(contentModel);
      this.docEditorTitle = recovery?.submitted_patch?.title || item.title || 'Untitled document';
      this.docEditorContent = editorState.contentModel.content || '';
      this.docEditorBlocks = normalizeDocumentBlocks(editorState.contentModel.content_blocks, editorState.contentModel.content);
      this.docEditorProseMirrorState = editorState.editorState;
      this.docEditorContentModel = editorState.contentModel;
      this.docRichEditorAdapter?.setContent?.(editorState.editorState, { emitUpdate: false, preserveSelection: false });
      this.docRecovery = recovery;
      this.setSelectedDocBaseIdentity({
        base_available: Boolean(recovery?.base),
        base_row_version: recovery?.base?.row_version,
        base_version_id: recovery?.base?.version_id,
        base_body_sha256_hex: recovery?.base?.body_sha256_hex,
        base_storage_object_id: null,
      });
      this.docEditConflict = {
        baseVersion: Number(recovery?.base?.row_version || 0),
        currentVersion: Number(recovery?.head_at_creation?.row_version || item.version || 0),
        currentHead: recovery?.head_at_creation || documentEditorBaseIdentity(item),
      };
      this.docEditDraftDirty = false;
      this.docEditAccessState = 'recovery';
      this.docEditAccessMessage = 'Recovery draft open. Continue editing, promote it against the current Tower head, or discard it.';
      this.docAutosaveState = 'saved';
      this.docRichEditorAdapter?.setEditable?.(true);
      await this.persistSelectedDocDraft({
        status: 'recovery',
        remoteOutcome: { status: 'recovery', code: 'recovery_opened', at: new Date().toISOString() },
        submittedStorageObjectId: recovery?.submitted_body?.storage_object_id || null,
        submittedBodySha256Hex: recovery?.submitted_body?.body_sha256_hex || null,
      });
      return true;
    } catch (error) {
      this.error = error?.message || 'Failed to open the recovery draft.';
      return false;
    }
  },

  async promoteSelectedDocRecovery() {
    const item = this.selectedDocument;
    const recoveryId = String(this.docRecovery?.id || '').trim();
    const context = resolveTowerPgWorkspaceContext(this);
    if (!item?.record_id || !recoveryId || !context.workspaceId) return false;
    this.docRecoveryActionState = 'promoting';
    this.error = null;
    try {
      const detail = await getTowerPgDocRecovery(context.workspaceId, item.record_id, recoveryId, {
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
      });
      const currentHead = detail?.current_head;
      if (!currentHead?.row_version || !currentHead?.body_sha256_hex) {
        throw new Error('Tower did not return a complete current-head identity for promotion.');
      }
      await releasePgEditLeaseForRecord(this, item, 'document', { reportError: false });
      const lease = await acquirePgEditLeaseForRecord(this, { ...item, version: currentHead.row_version }, 'document');
      if (!lease?.lease_token) throw new Error('A current document edit lease is required to promote this recovery.');
      const result = await promoteTowerPgDocRecovery(context.workspaceId, item.record_id, recoveryId, {
        row_version: currentHead.row_version,
        ...(currentHead.version_id ? { base_version_id: currentHead.version_id } : {}),
        base_body_sha256_hex: currentHead.body_sha256_hex,
        lease_token: lease.lease_token,
      }, {
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
      });
      const accepted = mapPgDocToLocal({
        ...result.doc,
        canonical_version: result.canonical_version || null,
      }, { workspaceOwnerNpub: context.workspaceOwnerNpub });
      const localDraft = this.docLocalDraft || {};
      const canonical = this.acceptSelectedPgDocSaveCanonical(accepted, {
        ...accepted,
        title: localDraft.title || this.docEditorTitle,
        content: localDraft.content || this.docEditorContent,
        content_format: localDraft.content_format || this.docEditorContentModel?.content_format,
        content_blocks: localDraft.content_blocks || this.docEditorBlocks,
        editor_state: localDraft.editor_state || this.docEditorProseMirrorState,
        editor_state_format: localDraft.editor_state_format || this.docEditorContentModel?.editor_state_format,
        editor_state_version: localDraft.editor_state_version || this.docEditorContentModel?.editor_state_version,
        content_storage_object_id: result.canonical_version?.storage_object_id,
        content_sha256_hex: result.canonical_version?.body_sha256_hex,
        content_size_bytes: result.canonical_version?.size_bytes,
      });
      await upsertDocument(canonical);
      await this.clearSelectedDocDraft(canonical);
      this.docRecovery = result.recovery || null;
      this.docEditConflict = null;
      this.docEditDraftDirty = false;
      this.docEditAccessState = 'ready';
      this.docEditAccessMessage = 'Recovery promoted to the canonical document.';
      this.docAutosaveState = 'saved';
      this.applySelectedDocAuthoritativeContent(canonical, { preserveSelection: true });
      await releasePgEditLeaseForRecord(this, canonical, 'document', { reportError: false });
      return true;
    } catch (error) {
      if (error?.code === 'recovery_promotion_conflict') {
        this.docEditConflict = {
          baseVersion: Number(this.docEditBaseRowVersion || 0),
          currentVersion: Number(error.payload?.current_head?.row_version || 0),
          currentHead: error.payload?.current_head || null,
        };
        this.docEditAccessState = 'recovery';
        this.docEditAccessMessage = 'Tower advanced again. The recovery is still preserved; refresh the head before promoting again.';
      } else {
        this.error = error?.message || 'Failed to promote the recovery version.';
      }
      return false;
    } finally {
      this.docRecoveryActionState = '';
    }
  },

  async discardSelectedDocRecovery() {
    const item = this.selectedDocument;
    const recoveryId = String(this.docRecovery?.id || '').trim();
    const context = resolveTowerPgWorkspaceContext(this);
    if (!item?.record_id || !recoveryId || !context.workspaceId) return false;
    this.docRecoveryActionState = 'discarding';
    try {
      await discardTowerPgDocRecovery(context.workspaceId, item.record_id, recoveryId, {
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
      });
      this.docRecovery = null;
      this.docEditConflict = null;
      this.docEditDraftDirty = false;
      await this.clearSelectedDocDraft(item);
      await this.refreshDocuments?.();
      const fresh = this.documents.find((candidate) => candidate.record_id === item.record_id) || item;
      if (isDocumentContentReadyForEditor(fresh)) this.applySelectedDocAuthoritativeContent(fresh, { preserveSelection: false });
      else this.loadDocEditorFromSelection(fresh);
      this.docEditAccessState = 'ready';
      this.docEditAccessMessage = 'Recovery discarded. The canonical Tower document is unchanged.';
      return true;
    } catch (error) {
      this.error = error?.message || 'Failed to discard the recovery version.';
      return false;
    } finally {
      this.docRecoveryActionState = '';
    }
  },

  async openDocVersioning() {
    if (!this.selectedDocId || this.selectedDocType !== 'document') return;
    const selectedDoc = this.selectedDocument;
    this.docVersioningOpen = true;
    this.docVersionHistory = [];
    this.docVersioningLoading = true;
    this.docVersioningError = null;
    this.docVersioningSelectedIndex = -1;
    this.docVersioningPreviewHtml = '';
    this.syncRoute();

    try {
      if (isTowerPgBackendMode() && selectedDoc?.pg_backend) {
        const context = resolveTowerPgWorkspaceContext(this);
        if (!context.workspaceId) {
          this.docVersioningError = 'Tower PG workspace is not ready.';
          return;
        }
        const result = await getTowerPgDocVersions(context.workspaceId, this.selectedDocId, {
          baseUrl: context.baseUrl,
          appNpub: context.appNpub,
          limit: 50,
        });
        const versions = Array.isArray(result?.versions) ? result.versions : [];
        const decoded = versions.map((ver) => {
          const content = ver?.content && typeof ver.content === 'object' ? ver.content : {};
          return {
            version: ver.version ?? ver.row_version ?? 0,
            title: ver.title || 'Untitled',
            content: typeof content.content === 'string' ? content.content : '',
            content_format: content.content_format || null,
            content_blocks: Array.isArray(content.content_blocks) ? content.content_blocks : [],
            updated_at: ver.updated_at || '',
            operation: ver.operation || 'updated',
            actor_npub: ver.actor_npub || null,
          };
        });
        decoded.sort((a, b) => b.version - a.version);
        this.docVersionHistory = decoded;
        if (decoded.length > 0) this.selectDocVersion(0);
        return;
      }
      const ownerNpub = this.workspaceOwnerNpub || this.session?.npub;
      const viewerNpub = this.session?.npub;
      if (!ownerNpub) {
        this.docVersioningError = 'No workspace owner configured.';
        return;
      }
      const result = await fetchRecordHistory({
        record_id: this.selectedDocId,
        owner_npub: ownerNpub,
        viewer_npub: viewerNpub,
      });
      const versions = Array.isArray(result.versions) ? result.versions : (Array.isArray(result) ? result : []);
      if (versions.length === 0) {
        console.warn('[versioning] Tower returned 0 versions for', this.selectedDocId, '— owner_npub:', ownerNpub);
      }
      const decoded = [];
      for (const ver of versions) {
        try {
          const doc = await inboundDocument(ver);
          decoded.push({
            version: ver.version ?? doc.version ?? 1,
            title: doc.title || 'Untitled',
            content: doc.content || '',
            content_format: doc.content_format || null,
            content_blocks: doc.content_blocks || [],
            updated_at: ver.updated_at || doc.updated_at || '',
          });
        } catch (decryptErr) {
          console.warn('[versioning] decrypt failed for version', ver.version, decryptErr?.message || decryptErr);
          decoded.push({
            version: ver.version ?? 0,
            title: `Version ${ver.version ?? '?'} (encrypted)`,
            content: '',
            updated_at: ver.updated_at || '',
          });
        }
      }
      decoded.sort((a, b) => b.version - a.version);
      this.docVersionHistory = decoded;
      if (decoded.length > 0) this.selectDocVersion(0);
    } catch (error) {
      console.error('[versioning] failed to load history for', this.selectedDocId, error);
      this.docVersioningError = error?.status === 404
        ? 'Version history not available — Tower may need redeployment.'
        : `Failed to load version history: ${error?.message || error}`;
    } finally {
      this.docVersioningLoading = false;
    }
  },

  closeDocVersioning() {
    this.docVersioningOpen = false;
    this.docVersionHistory = [];
    this.docVersioningSelectedIndex = -1;
    this.docVersioningPreviewHtml = '';
    this.docVersioningError = null;
    this.docDiffMode = false;
    this.docDiffHunks = [];
    this.docDiffCompareIndex = -1;
    this.docDiffFromIndex = -1;
    this.docDiffToIndex = -1;
    this.syncRoute();
  },

  selectDocVersion(index) {
    if (index < 0 || index >= this.docVersionHistory.length) return;
    this.docVersioningSelectedIndex = index;
    const ver = this.docVersionHistory[index];
    this.docVersioningPreviewHtml = renderMarkdownToHtml(ver.content || '');
    if (this.docDiffMode) {
      this.docDiffToIndex = index;
      this.computeDocDiff();
    }
  },

  toggleDocDiffMode() {
    this.docDiffMode = !this.docDiffMode;
    if (this.docDiffMode) {
      // Default: "to" = selected version (or newest), "from" = next older
      const toIdx = this.docVersioningSelectedIndex >= 0 ? this.docVersioningSelectedIndex : 0;
      const fromIdx = Math.min(toIdx + 1, this.docVersionHistory.length - 1);
      this.docDiffToIndex = toIdx;
      this.docDiffFromIndex = toIdx !== fromIdx ? fromIdx : -1;
      this.computeDocDiff();
    }
  },

  setDocDiffCompareIndex(index) {
    if (index < 0 || index >= this.docVersionHistory.length) return;
    this.docDiffCompareIndex = index;
    this.docDiffFromIndex = index;
    if (this.docDiffMode) this.computeDocDiff();
  },

  setDocDiffFromIndex(index) {
    this.docDiffFromIndex = index;
    if (this.docDiffMode) this.computeDocDiff();
  },

  setDocDiffToIndex(index) {
    this.docDiffToIndex = index;
    // Also update the selected version index and preview to match
    if (index >= 0 && index < this.docVersionHistory.length) {
      this.docVersioningSelectedIndex = index;
      const ver = this.docVersionHistory[index];
      this.docVersioningPreviewHtml = renderMarkdownToHtml(ver.content || '');
    }
    if (this.docDiffMode) this.computeDocDiff();
  },

  computeDocDiff() {
    const toIdx = this.docDiffToIndex >= 0
      ? this.docDiffToIndex
      : this.docVersioningSelectedIndex;
    const selected = this.docVersionHistory[toIdx];
    if (!selected) { this.docDiffHunks = []; return; }

    const fromIdx = this.docDiffFromIndex >= 0
      ? this.docDiffFromIndex
      : (this.docDiffCompareIndex >= 0 ? this.docDiffCompareIndex : toIdx + 1);

    const older = this.docVersionHistory[fromIdx];
    const diffText = (v) => `# ${v.title}\n\n${v.content}`;

    if (!older) {
      this.docDiffHunks = [{ value: diffText(selected), added: true }];
      return;
    }

    this.docDiffHunks = diffLines(diffText(older), diffText(selected));
  },

  async restoreDocVersion() {
    const ver = this.docVersionHistory[this.docVersioningSelectedIndex];
    if (!ver || !this.selectedDocId) return;
    this.docEditorTitle = ver.title;
    this.docEditorContent = ver.content;
    this.docEditorBlocks = normalizeDocumentBlocks(ver.content_blocks, ver.content);
    this.docEditorContent = assembleMarkdownBlocks(this.docEditorBlocks);
    this.docEditDraftDirty = true;
    this.docEditingBlockIndex = -1;
    this.docSelectedBlockId = null;
    this.docBlockBuffer = '';
    this.docBlockEditorMinHeightPx = 0;
    this.closeDocVersioning();
    await this.saveSelectedDocItem();
  },

  copyDocVersionSource() {
    const ver = this.docVersionHistory[this.docVersioningSelectedIndex];
    if (!ver) return;
    const fullMd = `# ${ver.title}\n\n${ver.content}`;
    navigator.clipboard.writeText(fullMd).catch(() => {});
  },

  exportDocMarkdown() {
    const doc = this.selectedDocument;
    if (!doc) return;
    const title = this.docEditorTitle || doc.title || 'document';
    const content = this.docEditorContent || doc.content || '';
    const fullMd = `# ${title}\n\n${content}`;
    const blob = new Blob([fullMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'document'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  },

  async exportDocPDF() {
    const doc = this.selectedDocument;
    if (!doc) return;
    const title = this.docEditorTitle || doc.title || 'document';
    const content = this.docEditorContent || doc.content || '';
    const rendered = this.renderMarkdown(content);

    // Resolve storage-backed images to data: URLs so they survive cross-window
    // transfer into the print popup (blob: URLs are tied to the originating
    // document and are not accessible from a different browsing context).
    const resolverFn = async (objectId) => {
      const blobUrl = await this.resolveStorageImageUrl(objectId);
      try {
        const response = await fetch(blobUrl);
        const blob = await response.blob();
        return await blobToDataUrl(blob);
      } catch {
        // Fall back to the blob URL if data-URL conversion fails
        return blobUrl;
      }
    };
    const hydrated = await hydrateStorageImageMarkup(rendered, resolverFn);

    const printWindow = window.open('about:blank', '_blank');
    if (!printWindow) {
      this.error = 'Popup blocked — please allow popups for this site and try again.';
      return;
    }
    printWindow.document.write(buildDocPrintHtml(title, hydrated));
    printWindow.document.close();
    printWindow.onafterprint = () => printWindow.close();

    // Wait for all images to finish loading before triggering print, so that
    // storage-backed and remote images are rasterised into the PDF.
    const images = [...printWindow.document.querySelectorAll('img[src]')];
    if (images.length > 0) {
      await Promise.all(images.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; }),
      ));
    }
    printWindow.print();
  },
};

// Preserve computed descriptors when composing the document manager.
Object.defineProperties(docsManagerMixin, Object.getOwnPropertyDescriptors(wikiManagerMixin));
