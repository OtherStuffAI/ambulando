import { channelWikiPages, resolveWikiPage } from './wiki-links.js';
import { updateTowerPgChannel } from '../tower-command-intents.js';
import { upsertChannel } from '../db.js';
import { mapPgChannelToLocal, resolveTowerPgWorkspaceContext } from '../pg-read-hydrator.js';

export const wikiManagerMixin = {
  get channelDocsHomeId() {
    return String(this.selectedChannel?.metadata?.docs_home_document_id || '');
  },
  get channelDocsHome() {
    return resolveWikiPage(this.documents, this.selectedChannelId, { documentId: this.channelDocsHomeId }).page || null;
  },
  get wikiPages() { return channelWikiPages(this.documents, this.selectedDocument?.pg_channel_id || this.selectedChannelId); },
  resolveDocWikiLink(attrs) {
    return resolveWikiPage(this.documents, this.selectedDocument?.pg_channel_id || this.selectedChannelId, attrs);
  },
  async preserveWikiNavigationDraft() {
    if (!this.docEditDraftDirty) return true;
    const originId = this.selectedDocId;
    const title = this.docEditorTitle;
    const content = this.docEditorContent;
    const editorDoc = this.docRichEditorAdapter?.editor?.state.doc;
    try {
      if (!await this.persistSelectedDocDraft({ immediate: true })) throw new Error('Draft persistence did not complete.');
      if (this.selectedDocId !== originId || this.docEditorTitle !== title || this.docEditorContent !== content
        || this.docRichEditorAdapter?.editor?.state.doc !== editorDoc) {
        throw new Error('Your draft changed while being preserved. Try navigation again.');
      }
      return true;
    } catch (error) { this.error = `Could not preserve your draft: ${error.message}`; return false; }
  },
  async followDocWikiLink(documentId, options = {}) {
    const target = this.resolveDocWikiLink({ documentId }).page;
    if (!target) { this.error = 'Page deleted or unavailable.'; return false; }
    if (!await this.preserveWikiNavigationDraft()) return false;
    this.openDoc(target.record_id, options);
    return true;
  },
  async createDocWikiPage(title, range, editor) {
    if (this.wikiCreateBusy) return false;
    const origin = this.selectedDocument;
    if (!origin?.pg_channel_id || !title.trim()) { this.error = 'Select a channel document and name the page.'; return false; }
    const originalEditorDoc = editor.state?.doc;
    this.wikiCreateBusy = true;
    this.error = null;
    try {
      if (this.docEditAccessState !== 'editing' && this.docEditAccessState !== 'recovery') {
        const editable = await this.enterSelectedDocEditMode();
        if (editable === false) throw new Error(this.docEditAccessMessage || 'Could not edit the originating page.');
      }
      if (this.selectedDocId !== origin.record_id || editor.isDestroyed || editor.state?.doc !== originalEditorDoc) throw new Error('The originating page changed. Choose the link again there.');
      editor.setEditable?.(false);
      const found = this.resolveDocWikiLink({ title });
      if (found.state === 'ambiguous') throw new Error('Several pages have this title. Choose a specific page from the picker.');
      let target = found.page;
      if (!target) target = await this.createDocument(title.trim(), { scopeId: origin.scope_id, channelId: origin.pg_channel_id, open: false, throwOnError: true });
      if (!target || target.sync_status === 'failed') throw new Error(this.error || 'Could not create page.');
      if (this.selectedDocId !== origin.record_id || editor.isDestroyed || editor.state?.doc !== originalEditorDoc) throw new Error('Page created, but the originating page changed. Choose it from the picker to link it.');
      editor.chain().focus().insertContentAt(range, { type: 'fdWikiLink', attrs: { documentId: target.record_id, title: target.title } }).run();
      this.syncDocRichEditorContentModel();
      this.docEditDraftDirty = true;
      const saved = await this.saveSelectedDocItem({ autosave: false });
      if (!saved || this.docRecovery || this.docEditDraftDirty) throw new Error(this.error || 'The new page exists, but the originating page could not be saved. Its link and your draft are preserved; retry Save before opening it.');
      this.openDoc(target.record_id);
      return true;
    } catch (error) {
      this.error = error.message || 'Could not create and link page.';
      return false;
    } finally {
      if (this.selectedDocId === origin.record_id && !editor.isDestroyed) editor.setEditable?.(this.isSelectedDocRichEditorEditable?.() ?? true);
      this.wikiCreateBusy = false;
    }
  },
  async setChannelDocsHome(documentId = null) {
    if (this.docsHomeSaving) return false;
    const channel = this.selectedChannel;
    if (!channel?.record_id || !this.isTowerPgMode) return false;
    if (documentId && !resolveWikiPage(this.documents, channel.record_id, { documentId }).page) {
      this.error = 'Choose an available page in this channel.'; return false;
    }
    this.docsHomeSaving = true;
    try {
      const { workspaceId, baseUrl, appNpub, workspaceOwnerNpub } = resolveTowerPgWorkspaceContext(this);
      // Tower merges this narrow patch with current metadata, preserving concurrent
      // channel settings. A null reference clears home without local authority.
      const result = await updateTowerPgChannel(this, workspaceId, channel.record_id,
        { metadata: { docs_home_document_id: documentId || null } }, { baseUrl, appNpub });
      const row = mapPgChannelToLocal(result.channel, { workspaceOwnerNpub });
      await upsertChannel(row);
      this.channels = this.channels.map((candidate) => candidate.record_id === row.record_id ? row : candidate);
      return true;
    } catch (error) { this.error = error.message || 'Could not update shared home page.'; return false; }
    finally { this.docsHomeSaving = false; }
  },
  async openChannelDocsHome(options = {}) {
    const channelId = this.selectedChannelId;
    const homeId = this.channelDocsHomeId;
    this.docsShowAll = false;
    const visit = ++this.docsHomeVisit;
    if (!homeId) return false;
    try { await this.refreshDocuments?.(); }
    catch (error) { this.error = error.message || 'Could not load channel pages.'; return false; }
    if (visit !== this.docsHomeVisit || channelId !== this.selectedChannelId || this.navSection !== 'docs' || this.docsShowAll) return false;
    const home = resolveWikiPage(this.documents, channelId, { documentId: homeId }).page;
    if (!home) { await this.openChannelAllDocs(options); return false; }
    return this.followDocWikiLink(home.record_id, options);
  },
  async openChannelAllDocs(options = {}) {
    this.docsHomeVisit++;
    if (!await this.preserveWikiNavigationDraft()) return false;
    this.docsShowAll = true;
    this.closeDocEditor({ syncRoute: false });
    this.currentFolderId = null;
    this.docFilter = '';
    this.navSection = 'docs';
    if (options.syncRoute !== false) this.syncRoute?.();
    return true;
  },
};
