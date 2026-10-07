import { liveQuery } from 'dexie';
import { getWorkspaceDb } from './db.js';
import { getTowerPgFileBlossom } from './api.js';
import { setTowerPgFileBlossom } from './tower-command-intents.js';
import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';

const subscriptions = new WeakMap();
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
  fileBlossomVersions: [],
  fileBlossomVersionId: '',
  fileBlossomName: '',
  fileBlossomFileId: '',
  fileBlossomContext: null,

  canPublishFileBrowserRow(row) {
    return Boolean(this.isTowerPgMode && row?.pg_record_type === 'file' && row.source_record_id);
  },
  get selectedFileBlossomVersion() {
    return (this.fileBlossomVersions || []).find(version => version.version_id === this.fileBlossomVersionId) || null;
  },
  closeFileBlossom() {
    subscriptions.get(this)?.unsubscribe();
    subscriptions.delete(this);
    this.fileBlossomGeneration += 1;
    this.fileBlossomOpen = false;
    this.fileBlossomContext = null;
    this.fileBlossomVersions = [];
    this.fileBlossomCanPublish = false;
    this.fileBlossomBusy = false;
  },
  async openFileBlossom(row) {
    this.closeFileBlossom();
    this.fileBlossomOpen = true;
    this.fileBlossomError = '';
    this.fileBlossomFileId = row.source_record_id;
    this.fileBlossomName = row.name;
    this.fileBlossomVersionId = '';
    this.fileBlossomBusy = true;
    const generation = this.fileBlossomGeneration;
    try {
      const context = resolveTowerPgWorkspaceContext(this);
      if (!context?.workspaceId || (row.workspace_id && row.workspace_id !== context.workspaceId)) throw new Error('Open this file in its owning workspace.');
      const db = getWorkspaceDb();
      this.fileBlossomContext = context;
      const key = `${context.workspaceId}:${row.source_record_id}`;
      subscriptions.set(this, liveQuery(() => db.file_blossom_status.get(key)).subscribe(status => {
        if (this.fileBlossomGeneration !== generation || !this.fileBlossomOpen || !isCurrentContext(this, context)) return;
        this.fileBlossomVersions = status?.versions || [];
        this.fileBlossomCanPublish = status?.can_publish === true;
        if (!this.fileBlossomVersionId) this.fileBlossomVersionId = this.fileBlossomVersions[0]?.version_id || '';
      }));
      const status = await getTowerPgFileBlossom(context.workspaceId, row.source_record_id, { baseUrl: context.baseUrl, appNpub: context.appNpub });
      if (this.fileBlossomGeneration !== generation || !this.fileBlossomOpen || !isCurrentContext(this, context)) return;
      await db.file_blossom_status.put({ ...status, key, workspace_id: context.workspaceId, file_id: row.source_record_id });
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
    this.fileBlossomBusy = true;
    this.fileBlossomError = '';
    const generation = this.fileBlossomGeneration;
    try {
      await setTowerPgFileBlossom(this, context.workspaceId, this.fileBlossomFileId, version.version_id, publish, { baseUrl: context.baseUrl, appNpub: context.appNpub });
    } catch (error) {
      if (this.fileBlossomGeneration === generation) this.fileBlossomError = error?.message || 'Could not change publication.';
    } finally { if (this.fileBlossomGeneration === generation) this.fileBlossomBusy = false; }
  },
  async copyFileBlossomUrl() {
    const url = this.selectedFileBlossomVersion?.blossom_url;
    if (!url) return;
    try { await navigator.clipboard.writeText(url); this.showFileUploadNotice?.('Public Blossom URL copied.'); }
    catch { this.fileBlossomError = 'Could not copy. Select and copy the URL below.'; }
  },
};
