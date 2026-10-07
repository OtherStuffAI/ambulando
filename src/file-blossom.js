import { mergeChatStorageAttachments } from './chat-attachments.js';
import { liveQuery } from 'dexie';
import { getWorkspaceDb } from './db.js';
import { getTowerPgFileBlossom, getTowerPgAttachmentBlossom } from './api.js';
import { setTowerPgFileBlossom, setTowerPgAttachmentBlossom } from './tower-command-intents.js';
import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';

const subscriptions = new WeakMap();
const focusOrigins = new WeakMap();
function isCurrentContext(store, expected) {
  const current = resolveTowerPgWorkspaceContext(store);
  return expected && ['workspaceId', 'baseUrl', 'appNpub', 'sessionNpub', 'generation'].every(key => current?.[key] === expected[key]);
}
export const fileBlossomMixin = {
  fileBlossomGeneration: 0,
  fileBlossomOpen: false,
  fileBlossomBusy: false,
  fileBlossomCanPublish: false,
  fileBlossomError: '',
  fileBlossomNotice: '',
  fileBlossomOperation: '',
  fileBlossomVersions: [],
  fileBlossomVersionId: '',
  fileBlossomName: '',
  fileBlossomFileId: '',
  fileBlossomContext: null,
  fileBlossomAttachment: false,
  fileBlossomObjectId: '',

  canPublishFileBrowserRow(row) {
    return Boolean(this.isTowerPgMode && row?.source_record_id && (row.pg_record_type === 'file' || (row.source_type === 'chat' && row.object_id)));
  },
  publishableMessageAttachments(message) {
    if (!this.isTowerPgMode || !message?.record_id || message.deleted_at) return [];
    return mergeChatStorageAttachments(message.body, message.attachments)
      .filter(a => ['image', 'file'].includes(a.kind) && a.storage_object_id);
  },
  openMessageAttachmentBlossom(message, attachment) {
    return this.openFileBlossom({ source_type: 'chat', source_record_id: message.record_id,
      object_id: attachment.storage_object_id, name: attachment.filename || 'Attachment',
      workspace_id: message.pg_workspace_id || message.workspace_id });
  },
  get selectedFileBlossomVersion() {
    return (this.fileBlossomVersions || []).find(version => version.version_id === this.fileBlossomVersionId) || null;
  },
  trapFileBlossomFocus(event) {
    if (!this.fileBlossomOpen) return;
    const panel = event.currentTarget.querySelector('[role="dialog"]');
    const controls = [...panel.querySelectorAll('button, input, select')].filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); panel.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
  },
  closeFileBlossom() {
    subscriptions.get(this)?.unsubscribe();
    subscriptions.delete(this);
    this.fileBlossomGeneration += 1;
    this.fileBlossomOpen = false;
    this.fileBlossomContext = null;
    this.fileBlossomVersions = [];
    this.fileBlossomAttachment = false;
    this.fileBlossomObjectId = '';
    this.fileBlossomCanPublish = false;
    this.fileBlossomBusy = false;
    this.fileBlossomOperation = '';
    this.fileBlossomNotice = '';
    focusOrigins.get(this)?.focus?.();
    focusOrigins.delete(this);
  },
  async openFileBlossom(row) {
    this.closeFileBlossom();
    if (typeof document !== 'undefined') focusOrigins.set(this, document.activeElement);
    this.fileBlossomOpen = true;
    this.fileBlossomError = '';
    this.fileBlossomFileId = row.source_record_id;
    this.fileBlossomAttachment = row.source_type === 'chat';
    this.fileBlossomObjectId = row.object_id || '';
    this.fileBlossomName = row.name;
    this.fileBlossomVersionId = '';
    this.fileBlossomBusy = true;
    const generation = this.fileBlossomGeneration;
    try {
      const context = resolveTowerPgWorkspaceContext(this);
      if (!context?.workspaceId || (row.workspace_id && row.workspace_id !== context.workspaceId)) throw new Error('Open this file in its owning workspace.');
      const db = getWorkspaceDb();
      this.fileBlossomContext = context;
      const attachment = this.fileBlossomAttachment;
      let ready = false;
      const key = attachment ? `${context.workspaceId}:message:${row.source_record_id}:${row.object_id}` : `${context.workspaceId}:${row.source_record_id}`;
      subscriptions.set(this, liveQuery(() => db.file_blossom_status.get(key)).subscribe(status => {
        if (!ready || this.fileBlossomGeneration !== generation || !this.fileBlossomOpen || !isCurrentContext(this, context)) return;
        this.fileBlossomVersions = status?.versions || [];
        this.fileBlossomCanPublish = status?.can_publish === true;
        if (!this.fileBlossomVersionId) this.fileBlossomVersionId = this.fileBlossomVersions[0]?.version_id || '';
      }));
      const options = { baseUrl: context.baseUrl, appNpub: context.appNpub };
      const status = attachment
        ? await getTowerPgAttachmentBlossom(context.workspaceId, row.source_record_id, row.object_id, options)
        : await getTowerPgFileBlossom(context.workspaceId, row.source_record_id, options);
      if (this.fileBlossomGeneration !== generation || !this.fileBlossomOpen || !isCurrentContext(this, context)) return;
      ready = true;
      await db.file_blossom_status.put({ ...status, ...(attachment ? { versions: [{ ...status.attachment, version_id: row.object_id }] } : {}), key, workspace_id: context.workspaceId, file_id: row.source_record_id });
    } catch (error) {
      if (this.fileBlossomGeneration === generation) this.fileBlossomError = error?.message || 'Could not read publication status.';
    } finally { if (this.fileBlossomGeneration === generation) this.fileBlossomBusy = false; }
  },
  async changeFileBlossom(publish) {
    const version = this.selectedFileBlossomVersion;
    const context = this.fileBlossomContext;
    if (!context || !version || !this.fileBlossomCanPublish || this.fileBlossomBusy) return;
    if (!isCurrentContext(this, context)) {
      this.closeFileBlossom();
      this.error = 'The workspace changed. Open the publication panel again.';
      return;
    }
    const question = publish
      ? 'Publish this selected version’s bytes anonymously? Anyone with the URL can download or copy them.'
      : 'Remove your publication reference? Other publications and external copies can remain available.';
    if (!window.confirm(question)) return;
    if (!isCurrentContext(this, context)) { this.closeFileBlossom(); this.error = 'The workspace or signer changed. Open the publication panel again.'; return; }
    if (publish && (!version.available || (!version.sha256_hex && this.fileBlossomAttachment))) return;
    this.fileBlossomBusy = true;
    this.fileBlossomOperation = publish ? 'publish' : 'unpublish';
    this.fileBlossomNotice = '';
    this.fileBlossomError = '';
    const generation = this.fileBlossomGeneration;
    try {
      const options = { baseUrl: context.baseUrl, appNpub: context.appNpub };
      if (this.fileBlossomAttachment) await setTowerPgAttachmentBlossom(this, context.workspaceId, this.fileBlossomFileId, this.fileBlossomObjectId, publish, { link_id: version.link_id, sha256_hex: version.sha256_hex }, options);
      else await setTowerPgFileBlossom(this, context.workspaceId, this.fileBlossomFileId, version.version_id, publish, options);
      if (this.fileBlossomGeneration === generation && isCurrentContext(this, context)) this.fileBlossomNotice = publish ? 'Publication saved. Your public link is ready to copy.' : 'Your publication reference was removed. Other publications and external copies may remain.';
    } catch (error) {
      if (this.fileBlossomGeneration === generation) this.fileBlossomError = error?.message || 'Could not change publication.';
    } finally { if (this.fileBlossomGeneration === generation) this.fileBlossomBusy = false; }
  },
  async copyFileBlossomUrl() {
    const url = this.selectedFileBlossomVersion?.blossom_url;
    if (!this.selectedFileBlossomVersion?.public || !url || !isCurrentContext(this, this.fileBlossomContext)) return;
    try { await navigator.clipboard.writeText(url); this.fileBlossomNotice = 'Public link copied.'; this.showFileUploadNotice?.('Public Blossom URL copied.'); }
    catch { this.fileBlossomError = 'Could not copy. Select and copy the URL below.'; }
  },
};
