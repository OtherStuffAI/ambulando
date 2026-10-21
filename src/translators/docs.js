import { decodeDocumentContent } from '../docs/stored-content.js';
import { recordFamilyHash } from './chat.js';
import { APP_NPUB } from '../app-identity.js';
import { buildGroupPayloads as buildEncryptedGroupPayloads, decryptRecordPayload, encryptOwnerPayload } from './record-crypto.js';
import { buildWriteGroupFields, buildGroupRefMap, extractGroupIds, normalizeGroupRef, normalizeShareGroupRefs } from './group-refs.js';
import { BLOCK_DOCUMENT_FORMAT, normalizeDocumentBlocks } from '../utils/state-helpers.js';
import { downloadStorageObject } from '../api.js';
import {
  buildRecordLinkPayload,
  normalizeRecordLinkFields,
} from '../record-links.js';

export const DOCUMENT_CONTENT_STORAGE_FORMAT = 'document_content_v1';
export const DOCUMENT_CONTENT_STORAGE_MIME = 'application/vnd.wingman.flightdeck.document-content+json';

function normalizeStorageString(value) {
  return String(value || '').trim() || null;
}

function documentStorageFields(data = {}) {
  return {
    content_storage_object_id: normalizeStorageString(data.content_storage_object_id),
    content_storage_format: normalizeStorageString(data.content_storage_format),
    content_storage_content_type: normalizeStorageString(data.content_storage_content_type),
    content_size_bytes: Number.isFinite(Number(data.content_size_bytes)) ? Number(data.content_size_bytes) : null,
    content_sha256_hex: normalizeStorageString(data.content_sha256_hex),
  };
}

async function resolveDocumentContent(data = {}) {
  const storage = documentStorageFields(data);
  if (!storage.content_storage_object_id) {
    return {
      content: data.content ?? '',
      content_format: data.content_format,
      content_blocks: data.content_blocks,
      editor_state: data.editor_state,
      editor_state_format: data.editor_state_format,
      editor_state_version: data.editor_state_version,
      content_storage_status: null,
    };
  }

  try {
    const bytes = await downloadStorageObject(storage.content_storage_object_id);
    const raw = new TextDecoder().decode(bytes);
    let model;
    try {
      model = decodeDocumentContent(raw, { allowLegacyModel: true });
      if (!model) throw new Error('Invalid document content model');
    } catch (parseError) {
      const contentType = String(storage.content_storage_content_type || '').toLowerCase();
      const storageFormat = String(storage.content_storage_format || '').toLowerCase();
      if (contentType.includes('markdown') || storageFormat === 'flightdeck_pg_doc_body') {
        return {
          content: raw,
          content_format: data.content_format,
          content_blocks: data.content_blocks,
          editor_state: data.editor_state,
          editor_state_format: data.editor_state_format,
          editor_state_version: data.editor_state_version,
          content_storage_status: 'loaded',
        };
      }
      throw parseError;
    }
    return {
      content: model.content ?? data.content ?? '',
      content_format: model.content_format ?? data.content_format,
      content_blocks: model.content_blocks ?? data.content_blocks,
      editor_state: model.editor_state ?? data.editor_state,
      editor_state_format: model.editor_state_format ?? data.editor_state_format,
      editor_state_version: model.editor_state_version ?? data.editor_state_version,
      content_storage_status: 'loaded',
    };
  } catch (error) {
    return {
      content: data.content ?? '',
      content_format: data.content_format,
      content_blocks: data.content_blocks,
      editor_state: data.editor_state,
      editor_state_format: data.editor_state_format,
      editor_state_version: data.editor_state_version,
      content_storage_status: 'error',
      content_storage_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function appendStorageFields(data, source = {}) {
  const storage = documentStorageFields(source);
  if (!storage.content_storage_object_id) return data;
  return {
    ...data,
    ...storage,
  };
}

export async function inboundDirectory(record) {
  const payload = await decryptRecordPayload(record);
  const data = payload.data ?? payload;
  const groupPayloads = record.group_payloads || [];
  const groupRefMap = buildGroupRefMap(groupPayloads);

  const recordLinks = normalizeRecordLinkFields(data);

  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    title: data.title ?? 'Untitled directory',
    parent_directory_id: data.parent_directory_id ?? null,
    scope_id: data.scope_id ?? null,
    scope_l1_id: data.scope_l1_id ?? null,
    scope_l2_id: data.scope_l2_id ?? null,
    scope_l3_id: data.scope_l3_id ?? null,
    scope_l4_id: data.scope_l4_id ?? null,
    scope_l5_id: data.scope_l5_id ?? null,
    scope_policy_group_ids: Array.isArray(data.scope_policy_group_ids) ? data.scope_policy_group_ids : null,
    shares: normalizeShareGroupRefs(data.shares, groupPayloads),
    group_ids: extractGroupIds(groupPayloads),
    write_group_id: normalizeGroupRef(record.write_group_id || record.write_group_npub, groupRefMap),
    sync_status: 'synced',
    record_state: data.record_state ?? 'active',
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export async function outboundDirectory({
  record_id,
  owner_npub,
  title,
  parent_directory_id = null,
  scope_id = null,
  scope_l1_id = null,
  scope_l2_id = null,
  scope_l3_id = null,
  scope_l4_id = null,
  scope_l5_id = null,
  scope_policy_group_ids = null,
  shares = [],
  group_ids = [],
  version = 1,
  previous_version = 0,
  signature_npub = owner_npub,
  write_group_ref = null,
  record_state = 'active',
}) {
  const innerPayload = {
    app_namespace: APP_NPUB,
    collection_space: 'directory',
    schema_version: 1,
    record_id,
    data: {
      title,
      parent_directory_id,
      scope_id,
      scope_l1_id,
      scope_l2_id,
      scope_l3_id,
      scope_l4_id,
      scope_l5_id,
      scope_policy_group_ids,
      shares,
      record_state,
    },
  };

  return {
    record_id,
    owner_npub,
    record_family_hash: recordFamilyHash('directory'),
    version,
    previous_version,
    signature_npub,
    ...buildWriteGroupFields(write_group_ref),
    owner_payload: await encryptOwnerPayload(owner_npub, innerPayload),
    group_payloads: await buildEncryptedGroupPayloads(group_ids || [], innerPayload),
  };
}

export async function inboundDocument(record) {
  const payload = await decryptRecordPayload(record);
  const data = payload.data ?? payload;
  const groupPayloads = record.group_payloads || [];
  const groupRefMap = buildGroupRefMap(groupPayloads);
  const resolvedContent = await resolveDocumentContent(data);
  const storage = documentStorageFields(data);
  const recordLinks = normalizeRecordLinkFields(data);

  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    title: data.title ?? 'Untitled document',
    content: resolvedContent.content ?? '',
    content_format: resolvedContent.content_format ?? null,
    content_blocks: normalizeDocumentBlocks(resolvedContent.content_blocks, resolvedContent.content ?? ''),
    editor_state: resolvedContent.editor_state && typeof resolvedContent.editor_state === 'object'
      ? resolvedContent.editor_state
      : null,
    editor_state_format: resolvedContent.editor_state_format ?? null,
    editor_state_version: resolvedContent.editor_state_version ?? null,
    ...storage,
    content_storage_status: resolvedContent.content_storage_status,
    content_storage_error: resolvedContent.content_storage_error ?? null,
    parent_directory_id: data.parent_directory_id ?? null,
    scope_id: data.scope_id ?? null,
    scope_l1_id: data.scope_l1_id ?? null,
    scope_l2_id: data.scope_l2_id ?? null,
    scope_l3_id: data.scope_l3_id ?? null,
    scope_l4_id: data.scope_l4_id ?? null,
    scope_l5_id: data.scope_l5_id ?? null,
    scope_policy_group_ids: Array.isArray(data.scope_policy_group_ids) ? data.scope_policy_group_ids : null,
    ...recordLinks,
    shares: normalizeShareGroupRefs(data.shares, groupPayloads),
    group_ids: extractGroupIds(groupPayloads),
    write_group_id: normalizeGroupRef(record.write_group_id || record.write_group_npub, groupRefMap),
    sync_status: 'synced',
    record_state: data.record_state ?? 'active',
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export async function outboundDocument({
  record_id,
  owner_npub,
  title,
  content,
  content_format = BLOCK_DOCUMENT_FORMAT,
  content_blocks = null,
  content_storage_object_id = null,
  content_storage_format = null,
  content_storage_content_type = null,
  content_size_bytes = null,
  content_sha256_hex = null,
  parent_directory_id = null,
  scope_id = null,
  scope_l1_id = null,
  scope_l2_id = null,
  scope_l3_id = null,
  scope_l4_id = null,
  scope_l5_id = null,
  scope_policy_group_ids = null,
  source_links = [],
  references = [],
  deliverable_links = [],
  shares = [],
  group_ids = [],
  version = 1,
  previous_version = 0,
  signature_npub = owner_npub,
  write_group_ref = null,
  record_state = 'active',
}) {
  const hasStorageContent = Boolean(normalizeStorageString(content_storage_object_id));
  const normalizedContentBlocks = hasStorageContent
    ? (Array.isArray(content_blocks) ? content_blocks : [])
    : normalizeDocumentBlocks(content_blocks, content);

  const recordLinks = buildRecordLinkPayload({ source_links, references, deliverable_links });
  const contentData = appendStorageFields({
    title,
    content,
    content_format,
    content_blocks: normalizedContentBlocks,
    parent_directory_id,
    scope_id,
    scope_l1_id,
    scope_l2_id,
    scope_l3_id,
    scope_l4_id,
    scope_l5_id,
    scope_policy_group_ids,
    ...recordLinks,
    shares,
    record_state,
  }, {
    content_storage_object_id,
    content_storage_format,
    content_storage_content_type,
    content_size_bytes,
    content_sha256_hex,
  });

  const innerPayload = {
    app_namespace: APP_NPUB,
    collection_space: 'document',
    schema_version: 1,
    record_id,
    data: contentData,
  };

  return {
    record_id,
    owner_npub,
    record_family_hash: recordFamilyHash('document'),
    version,
    previous_version,
    signature_npub,
    ...buildWriteGroupFields(write_group_ref),
    owner_payload: await encryptOwnerPayload(owner_npub, innerPayload),
    group_payloads: await buildEncryptedGroupPayloads(group_ids || [], innerPayload),
  };
}
