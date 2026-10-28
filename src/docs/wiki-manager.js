import { beginInternalReferenceVisit, resolveInternalReference, rememberReferenceComposerDraft } from '../internal-reference-navigation.js';
import { channelWikiPages, resolveWikiPage, incomingWikiPages, readableWikiPages, wikiPageReferences } from './wiki-links.js';
import { updateTowerPgChannel } from '../tower-command-intents.js';
import { upsertChannel, openWikiCreationJournal } from '../db.js';
import { mapPgChannelToLocal, resolveTowerPgWorkspaceContext } from '../pg-read-hydrator.js';

export const wikiManagerMixin = {
  async completeWikiCreationsForSavedDocument(document, actorId = this.session?.npub) {
    if (!document?.record_id || !actorId) return;
    const ids = wikiPageReferences(document).map(attrs => attrs.documentId).filter(Boolean);
    if (!ids.length) return;
    try { await openWikiCreationJournal().complete(document.record_id, actorId, ids); }
    catch (error) { console.warn('[wiki] Could not retire completed local creation recovery', error); }
  },
  get wikiDocuments() {
    const workspaceId = resolveTowerPgWorkspaceContext(this).workspaceId;
    return (this.documents || []).filter(row => !(row.pg_workspace_id || row.workspace_id)
      || (row.pg_workspace_id || row.workspace_id) === workspaceId);
  },
  async searchBroaderWikiPages() {
    if (!this.wikiLinkPicker.broader) return;
    const picker = this.wikiLinkPicker;
    this.wikiLinkPicker = { ...picker, loading: true, error: '' };
    try { await this.refreshDocuments?.(); }
    catch (error) {
      if (this.wikiLinkPicker.open && this.wikiLinkPicker.originId === picker.originId) this.wikiLinkPicker = { ...this.wikiLinkPicker, error: `Showing cached results. Could not refresh pages: ${error.message}` };
    } finally {
      if (this.wikiLinkPicker.originId === picker.originId) this.wikiLinkPicker = { ...this.wikiLinkPicker, loading: false };
    }
  },
  wikiPageLocation(page) {
    const channel = (this.channels || []).find(row => row.record_id === page.pg_channel_id);
    const scope = (this.scopes || []).find(row => row.record_id === (page.scope_id || channel?.scope_id));
    return `${scope?.title || this.getScopeBreadcrumb?.(page.scope_id || channel?.scope_id) || 'Scope'} / ${channel ? this.getChannelLabel?.(channel) || channel.title || channel.name : 'Channel'}`;
  },
  get wikiLinkDestinations() {
    if (!this.wikiLinkPicker?.open) return [];
    return (this.channels || []).filter(row => !['deleted', 'archived'].includes(row.record_state)
      && row.can_read !== false && row.readable !== false).map(row => ({
      id: row.record_id, scopeId: row.scope_id || row.pg_scope_id,
      label: this.wikiPageLocation({ pg_channel_id: row.record_id, scope_id: row.scope_id || row.pg_scope_id }),
    }));
  },
  get wikiLinkResults() {
    const picker = this.wikiLinkPicker;
    if (!picker?.open) return [];
    const pages = picker.broader ? readableWikiPages(this.wikiDocuments) : this.wikiPages;
    return pages.filter(page => String(page.title || '').toLocaleLowerCase().includes(picker.query.trim().toLocaleLowerCase())).slice(0, 100);
  },
  openDocWikiPicker(title = '', range = null, editor = null) {
    const candidate = editor || this.docRichEditorAdapter?.editor;
    const current = typeof globalThis.Alpine?.raw === 'function' ? globalThis.Alpine.raw(candidate) : candidate;
    if (!current || current.isDestroyed || this.wikiCreateBusy) return false;
    if (current.isActive?.('codeBlock') || current.isActive?.('code')) { this.error = 'Place the cursor outside code to link a page.'; return false; }
    this.wikiLinkPicker = { open: true, query: title, broader: false,
      destinationChannelId: this.selectedDocument?.pg_channel_id || this.selectedChannelId,
      originId: this.selectedDocId, range: range || { from: current.state.selection.from, to: current.state.selection.to }, submitting: false, error: '' };
    // Keep ProseMirror objects out of Alpine's deep reactive state.
    const workspace = this.currentWorkspace, actor = this.session?.npub, channelId = this.selectedChannelId;
    const workspaceGeneration = this._workspaceSelectionGeneration, openGeneration = this.docOpenGeneration, section = this.navSection;
    this._wikiPickerCurrent = () => this.currentWorkspace === workspace && this.session?.npub === actor && this.selectedChannelId === channelId
      && this._workspaceSelectionGeneration === workspaceGeneration && this.docOpenGeneration === openGeneration && this.navSection === section;
    this._wikiPickerEditor = () => current;
    const snapshot = current.state.doc;
    this._wikiPickerDoc = () => snapshot;
    return true;
  },
  closeDocWikiPicker() {
    if (this.wikiCreateBusy) return false;
    this.wikiLinkPicker = { ...this.wikiLinkPicker, open: false };
    this._wikiPickerEditor?.()?.commands.focus();
    this._wikiPickerEditor = null; this._wikiPickerDoc = null;
    return true;
  },
  async selectDocWikiTarget(documentId = null) {
    const picker = this.wikiLinkPicker;
    const editor = this._wikiPickerEditor?.();
    if (this.wikiCreateBusy || picker.submitting) return false;
    if (!editor || editor.isDestroyed || !this._wikiPickerCurrent?.() || picker.originId !== this.selectedDocId || editor.state.doc !== this._wikiPickerDoc?.()) {
      this.wikiLinkPicker = { ...picker, error: 'The source changed. Close this picker and choose the link again.' }; return false;
    }
    if (!documentId) {
      const destination = this.wikiLinkDestinations.find(row => row.id === picker.destinationChannelId);
      if (!destination || !picker.query.trim()) { this.wikiLinkPicker = { ...picker, error: 'Name the page and choose a visible destination.' }; return false; }
      const result = await this.createDocWikiPage(picker.query, picker.range, editor, { channelId: destination.id, scopeId: destination.scopeId });
      if (result) this.wikiLinkPicker = { ...picker, open: false };
      else this.wikiLinkPicker = { ...picker, error: this.error || 'Could not create and link page.' };
      return result;
    }
    this.wikiLinkPicker = { ...picker, submitting: true };
    try {
      const target = readableWikiPages(this.wikiDocuments).find(row => row.record_id === documentId);
      if (!target) throw new Error('This page is no longer available.');
      if (!await this.enterSelectedDocEditMode()) throw new Error(this.docEditAccessMessage || 'Could not edit source.');
      if (!this._wikiPickerCurrent?.() || picker.originId !== this.selectedDocId || editor.state.doc !== this._wikiPickerDoc?.()) throw new Error('The source changed. Choose the link again.');
      editor.chain().focus().insertContentAt(picker.range, { type: 'fdWikiLink', attrs: { documentId: target.record_id, title: target.title } }).run();
      this.syncDocRichEditorContentModel(); this.docEditDraftDirty = true;
      await this.persistSelectedDocDraft({ immediate: true });
      this.closeDocWikiPicker();
      return true;
    } catch (error) { this.wikiLinkPicker = { ...picker, error: error.message }; return false; }
    finally { this.wikiLinkPicker = { ...this.wikiLinkPicker, submitting: false }; }
  },
  get channelDocsHomeId() {
    return String(this.selectedChannel?.metadata?.docs_home_document_id || '');
  },
  get channelDocsHome() {
    return channelWikiPages(this.wikiDocuments, this.selectedChannelId).find(page => page.record_id === this.channelDocsHomeId) || null;
  },
  get wikiPages() { return channelWikiPages(this.wikiDocuments, this.selectedDocument?.pg_channel_id || this.selectedChannelId); },
  get docBacklinks() { return incomingWikiPages(this.wikiDocuments, this.selectedDocument); },
  resolveDocWikiLink(attrs) {
    return resolveWikiPage(this.wikiDocuments, this.selectedDocument?.pg_channel_id || this.selectedChannelId, attrs);
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
    if (this.wikiCreateBusy) return false;
    const navigation = beginInternalReferenceVisit(this);
    let target = this.resolveDocWikiLink({ documentId }).page;
    const started = performance.now();
    this.wikiNavigationTiming = { documentId, stages: [{ stage: 'link activated', elapsedMs: 0 }] };
    const timing = this.wikiNavigationTiming;
    const stage = (name) => {
      if (this.wikiNavigationTiming === timing) timing.stages.push({ stage: name, elapsedMs: performance.now() - started });
    };
    const originId = this.selectedDocId;
    const section = this.navSection;
    const channelId = this.selectedChannelId;
    const workspace = this.currentWorkspace;
    const visit = this.docsHomeVisit;
    try {
      if (!target) {
        this.internalLinkOpening = true;
        this.internalLinkOpenError = '';
        target = await resolveInternalReference(this, 'doc', documentId, { isCurrent: navigation.isCurrent });
        if (!target || !navigation.isCurrent()) return false;
        if (['archived', 'deleted'].includes(target.record_state) || target.archived_at || target.deleted_at) {
          throw new Error('Page deleted or unavailable.');
        }
      }
    } catch (error) {
      if (navigation.isCurrent()) {
        this.error = `Could not open wiki page: ${error.message}`;
        this.internalLinkOpenError = this.error;
      }
      return false;
    } finally {
      if (this.internalLinkOpenRequestId === navigation.request) this.internalLinkOpening = false;
    }
    if (!await this.preserveWikiNavigationDraft()) return false;
    stage('local draft preserved');
    if (!navigation.isCurrent() || originId !== this.selectedDocId || channelId !== this.selectedChannelId || workspace !== this.currentWorkspace
      || visit !== this.docsHomeVisit || this.navSection !== section) return false;
    if (this.selectedDocId === target.record_id) return true;
    rememberReferenceComposerDraft(this, 'doc', originId);
    this.openDoc(target.record_id, { ...options, draftPreserved: true });
    stage('local selection loaded');
    if (typeof window !== 'undefined') {
      await window.Alpine?.nextTick?.();
      await this.docRichEditorMountPromise;
      if (this.selectedDocId === target.record_id) stage('editor mounted');
    }
    return true;
  },
  async createDocWikiPage(title, range, editor, destination = {}) {
    if (this.wikiCreateBusy) return false;
    const origin = this.selectedDocument;
    const originWorkspace = this.currentWorkspace, originActor = this.session?.npub, originGeneration = this._workspaceSelectionGeneration;
    const ownsOrigin = () => this.selectedDocId === origin.record_id && this.currentWorkspace === originWorkspace && this.session?.npub === originActor && this._workspaceSelectionGeneration === originGeneration;
    if (!origin?.pg_channel_id || !title.trim()) { this.error = 'Select a channel document and name the page.'; return false; }
    const started = performance.now();
    this.wikiCreateTimings = [];
    const stage = (name) => this.wikiCreateTimings.push({ stage: name, elapsedMs: Math.round(performance.now() - started) });
    this.wikiCreateBusy = true;
    this.docRichEditorAdapter?.refreshWikiLinks?.();
    const originalEditorDoc = editor.state?.doc;
    this.error = null;
    try {
      if (this.docEditAccessState !== 'editing' && this.docEditAccessState !== 'recovery') {
        const editable = await this.enterSelectedDocEditMode();
        if (editable === false) throw new Error(this.docEditAccessMessage || 'Could not edit the originating page.');
      }
      stage('origin access');
      if (!ownsOrigin() || editor.isDestroyed || editor.state?.doc !== originalEditorDoc) throw new Error('The originating page changed. Choose the link again there.');
      editor.setEditable?.(false);
      const channelId = destination.channelId || origin.pg_channel_id;
      const scopeId = destination.scopeId || origin.scope_id;
      const wikiCreationKey = JSON.stringify([this.session?.npub, origin.record_id, channelId, title.trim().toLocaleLowerCase()]);
      const previousCreation = await openWikiCreationJournal().get(wikiCreationKey);
      const found = resolveWikiPage(this.wikiDocuments, channelId, { title });
      if (!previousCreation && found.state === 'ambiguous') throw new Error('Several pages have this title. Choose a specific page from the picker.');
      let target = previousCreation ? null : found.page;
      if (!target && !this.session?.npub) throw new Error('Sign in before creating a linked page.');
      if (!target) target = await this.createDocument(title.trim(), { scopeId, channelId, open: false, initialContent: '', throwOnError: true,
        wikiCreationKey, wikiSourceId: origin.record_id, wikiActorId: this.session.npub });
      stage('page persisted');
      if (!target || target.sync_status === 'failed') throw new Error(this.error || 'Could not create page.');
      if (!ownsOrigin() || editor.isDestroyed || editor.state?.doc !== originalEditorDoc) throw new Error('Page created, but the originating page changed. Choose it from the picker to link it.');
      editor.chain().focus().insertContentAt(range, { type: 'fdWikiLink', attrs: { documentId: target.record_id, title: target.title } }).run();
      this.syncDocRichEditorContentModel();
      this.docEditDraftDirty = true;
      if (!await this.persistSelectedDocDraft({ immediate: true })) throw new Error('The new page exists but its source link could not be checkpointed. Keep this draft open and retry Save.');
      const saved = await this.saveSelectedDocItem({ autosave: false });
      stage('origin saved');
      if (!saved || this.docRecovery || this.docEditDraftDirty) throw new Error(this.error || 'The new page exists, but the originating page could not be saved. Its link and your draft are preserved; retry Save before opening it.');
      if (!ownsOrigin()) throw new Error('Source saved, but navigation changed. Follow its saved link when ready.');
      await this.completeWikiCreationsForSavedDocument({ ...origin, ...this.docEditorContentModel, editor_state: this.docEditorProseMirrorState || editor.getJSON?.() });
      if (!ownsOrigin()) throw new Error('Source saved, but navigation changed. Follow its saved link when ready.');
      this.openDoc(target.record_id);
      const targetId = target.record_id;
      // Opening mounts the rich editor in ready state. Acquire the target lease
      // on actual input, rather than adding another network wait to navigation.
      this.setDocEditorMode?.('rich');
      // Alpine may still be replacing the origin editor. Await its render and
      // the lazy Tiptap mount before directing typing into the target.
      if (typeof window !== 'undefined') await window.Alpine?.nextTick?.();
      await this.mountDocRichEditor?.(this.docRichEditorMountEl);
      await this.docRichEditorMountPromise;
      if (this.selectedDocId !== targetId) return false;
      const adapterEditor = this.docRichEditorAdapter?.editor;
      const targetEditor = typeof globalThis.Alpine?.raw === 'function' ? globalThis.Alpine.raw(adapterEditor) : adapterEditor;
      if (!targetEditor || targetEditor.isDestroyed) throw new Error('Page opened, but its editor is not ready. Use Edit to retry.');
      targetEditor.commands.focus('start');
      stage('editor focused');
      return true;
    } catch (error) {
      this.error = error.message || 'Could not create and link page.';
      return false;
    } finally {
      if (this.selectedDocId === origin.record_id && !editor.isDestroyed) editor.setEditable?.(this.isSelectedDocRichEditorEditable?.() ?? true);
      this.wikiCreateBusy = false;
      this.docRichEditorAdapter?.refreshWikiLinks?.();
      stage('finished');
    }
  },
  async setChannelDocsHome(documentId = null) {
    if (this.docsHomeSaving) return false;
    const channel = this.selectedChannel;
    if (!channel?.record_id || !this.isTowerPgMode) return false;
    if (documentId && !channelWikiPages(this.wikiDocuments, channel.record_id).some(page => page.record_id === documentId)) {
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
    const workspace = this.currentWorkspace;
    const originId = this.selectedDocId;
    this.docsShowAll = false;
    const visit = ++this.docsHomeVisit;
    if (!homeId) { await this.openChannelAllDocs(options); return false; }
    // An available Home is already in the local collection. Refresh only when
    // resolving a missing target; openDoc reconciles the selected page later.
    const cachedHome = channelWikiPages(this.wikiDocuments, channelId).find(page => page.record_id === homeId);
    if (cachedHome) return this.followDocWikiLink(cachedHome.record_id, options);
    if (this.wikiDocuments.some(page => page.record_id === homeId && page.pg_channel_id !== channelId)) {
      await this.openChannelAllDocs(options); return false;
    }
    try { await this.refreshDocuments?.(); }
    catch (error) { this.error = error.message || 'Could not load channel pages.'; return false; }
    if (visit !== this.docsHomeVisit || channelId !== this.selectedChannelId || workspace !== this.currentWorkspace || homeId !== this.channelDocsHomeId
      || originId !== this.selectedDocId || this.navSection !== 'docs' || this.docsShowAll) return false;
    const home = channelWikiPages(this.wikiDocuments, channelId).find(page => page.record_id === homeId);
    if (!home) { await this.openChannelAllDocs(options); return false; }
    return this.followDocWikiLink(home.record_id, options);
  },
  async openChannelAllDocs(options = {}) {
    const visit = ++this.docsHomeVisit;
    const originId = this.selectedDocId;
    const channelId = this.selectedChannelId;
    const workspace = this.currentWorkspace;
    if (!await this.preserveWikiNavigationDraft()) return false;
    if (visit !== this.docsHomeVisit || originId !== this.selectedDocId || channelId !== this.selectedChannelId || workspace !== this.currentWorkspace) return false;
    this.docsShowAll = true;
    this.closeDocEditor({ syncRoute: false });
    this.currentFolderId = null;
    this.docFilter = '';
    this.navSection = 'docs';
    if (options.syncRoute !== false) this.syncRoute?.();
    return true;
  },
};
