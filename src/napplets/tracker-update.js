import * as api from '../api.js';
import { ArtifactCatalog } from '../canvas/artifact-picker.js';
import { FileNappletData, parseFileNapplet } from './file-data.js';
import { buildStoragePrepareBody } from '../storage-payloads.js';

// Exact released built-in bytes only. A name/manifest is never proof of origin.
export const ORIGINAL_TRACKER_DIGEST = '192779e50335a83d90076fb17954059e466ccfecea25c5eb5b14d68e8dfa91cd';
export const canUpdateTracker = content => content?.digest === ORIGINAL_TRACKER_DIGEST && new TextEncoder().encode(content.html).length === 14824;
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const conflict = () => Object.assign(new Error('App code changed. Close and reopen before checking for an update.'), { status: 409 });

/** Explicit host action: one code File CAS, no data/metadata writes or migration. */
export async function updateTrackerCode({ context, codeFileId, baseVersionId, binding, source, loadSource, current = () => true, transport = api }) {
  const controller = new AbortController();
  const options = { baseUrl: context.baseUrl, appNpub: context.appNpub, signal: controller.signal };
  const assert = () => { if (!current() || controller.signal.aborted) throw new Error('App update context changed or timed out. Close and reopen to check the saved code.'); };
  const catalog = new ArtifactCatalog(context, transport);
  const data = new FileNappletData(context, codeFileId, binding, { transport, current });
  const timer = setTimeout(() => { controller.abort(); data.stop(); }, 45000);
  const check = async versionId => {
    assert();
    const payload = await transport.getTowerPgFile(context.workspaceId, codeFileId, options); assert();
    const file = payload.file;
    const writable = Object.hasOwn(payload, 'can_write') ? payload.can_write === true : file?.can_write === true;
    if (file?.id !== codeFileId || file.workspace_id !== context.workspaceId || !writable || file.archived_at || file.deleted_at) throw new Error('App code is not writable.');
    if (file.current_version_id !== versionId) throw conflict();
    const parsed = parseFileNapplet(source, file.metadata);
    if (parsed.fileId !== binding.fileId) throw conflict();
    const result = await transport.getTowerPgChannel(context.workspaceId, file.channel_id, options); assert();
    const ch = result.channel;
    if (ch?.id !== file.channel_id || ch.workspace_id !== context.workspaceId || ch.kind !== 'dm' || ch.participant_npubs?.length !== 1 || ch.participant_npubs[0] !== context.viewer || ch.archived_at) throw new Error('App code must be in your private self conversation.');
    data.codeVersion = versionId;
    await data.authority();
    assert();
  };
  const original = async () => {
    await check(baseVersionId);
    const content = await catalog.preview({ id: codeFileId, kind: 'html', currentVersionId: baseVersionId }, { signal: controller.signal }); assert();
    if (!canUpdateTracker(content)) throw new Error('This app code is customized or unrecognized. It has not been replaced.');
  };
  try {
    if (loadSource) source = await loadSource(controller.signal);
    assert();
  const nextBinding = parseFileNapplet(source, { napplet: { version: 1, app_id: 'daily-tracker', bindings: { tracker: { file_id: binding.fileId } } } });
  if (nextBinding.fileId !== binding.fileId) throw new Error('App update binding mismatch.');
    await original();
    const bytes = new TextEncoder().encode(source), digest = await sha256(bytes); assert();
    const prepared = await transport.prepareTowerPgStorageObject(context.workspaceId, buildStoragePrepareBody({ ownerNpub: context.viewer, contentType: 'text/html', sizeBytes: bytes.length, fileName: 'Daily tracker.html' }), options); assert();
    if (prepared.is_public) throw new Error('Private storage required.');
    await transport.uploadStorageObject(prepared, bytes, 'text/html', options); assert();
    await transport.completeStorageObject(prepared.object_id, { size_bytes: bytes.length, sha256_hex: digest }, options); assert();
    await original(); // Recheck bytes, binding, access and base after upload.
    const result = await transport.createTowerPgFileVersion(context.workspaceId, codeFileId, { base_version_id: baseVersionId, storage_object_id: prepared.object_id, client_mutation_id: crypto.randomUUID() }, options); assert();
    const committed = result?.version?.id;
    if (!committed) throw new Error('App update acknowledgement was incomplete. Close and reopen to check the saved code.');
    await check(committed);
    const readback = await catalog.preview({ id: codeFileId, kind: 'html', currentVersionId: committed }, { signal: controller.signal }); assert();
    if (readback.digest !== digest || readback.html !== source) throw new Error('App update could not be confirmed. Close and reopen to check the saved code.');
    await check(committed);
    return committed;
  } finally { clearTimeout(timer); data.stop(); controller.abort(); }
}
