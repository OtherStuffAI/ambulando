import { reviewDocumentInWorker } from './document-review-client.js';
import { createDocumentEditorState } from './editor/document-editor-store.js';
import { prosemirrorToFlightDeckContentModel } from './editor/prosemirror-to-flightdeck.js';
import { resolveTowerPgWorkspaceContext } from '../pg-read-hydrator.js';
import { isOnlineForPgEdit, isSyncedPgRecord } from '../pg-edit-session.js';
import { upsertDocument, preserveDocumentDraftCopy, getPreservedDocumentDraftCopies } from '../db.js';
import { toRaw } from '../utils/state-helpers.js';

export function createDocumentReviewMixin({ documentEditorBaseIdentity, documentContentSignature, isDocumentContentReadyForEditor }) {
  const identity = row => JSON.stringify(documentEditorBaseIdentity(row));
  const editable = row => ({ title: row.title || 'Untitled document', editor_state: createDocumentEditorState(row).editorState });
  const working = store => ({ title: store.docEditorTitle || 'Untitled document', ...toRaw(store.buildSelectedDocContentModel()) });
  const signature = row => JSON.stringify([row.title, documentContentSignature(row)]);
  return {
    describeDocMergeConflict(value) {
      if (value === undefined || value === null) return 'Removed';
      if (typeof value === 'string') return value || '(empty)';
      if (typeof value !== 'object') return String(value);
      if (Array.isArray(value)) {
        if (value.every(v => typeof v === 'string')) return value.join('') || '(empty)';
        return value.map(v => this.describeDocMergeConflict(v)).join('\n') || '(empty)';
      }
      if (value.type === 'text') return `${value.text || ''}${value.marks?.length ? ' (' + value.marks.map(m => m.type === 'link' ? `link to ${m.attrs?.href || ''}` : m.type).join(', ') + ')' : ''}`;
      if (value.content) return this.describeDocMergeConflict(value.content);
      if (value.type) return value.type === 'image' ? `Image: ${value.attrs?.alt || value.attrs?.src || ''}` : value.type;
      return Object.entries(value).map(([key, item]) => `${({ href: 'Link', editor_state: 'Document content', title: 'Title', attrs: 'Formatting' })[key] || key}: ${this.describeDocMergeConflict(item)}`).join(' · ');
    },

    async loadSelectedDocPreservedCopies() {
      const current = this.docReviewCurrentGuard();
      const copies = await getPreservedDocumentDraftCopies(this.getSelectedDocWorkspaceId(), this.selectedDocId);
      if (current()) this.docPreservedCopies = copies;
      return copies;
    },

    async resumeSelectedDocPreservedCopy(copy) {
      if (this.docEditDraftDirty || this.docDraftChoice || !copy) return false;
      return this.restoreSelectedDocDraft(this.selectedDocument, { generation: this.docEditAccessGeneration, draft: copy, resume: true });
    },

    docReviewCurrentGuard() {
      const id = this.selectedDocId, generation = this.docEditAccessGeneration;
      const context = resolveTowerPgWorkspaceContext(this), actor = this.session?.npub;
      return () => this.selectedDocId === id && generation === this.docEditAccessGeneration
        && context.workspaceId === resolveTowerPgWorkspaceContext(this).workspaceId
        && context.baseUrl === resolveTowerPgWorkspaceContext(this).baseUrl && actor === this.session?.npub;
    },

    async checkSelectedDocLatest() {
      const item = this.selectedDocument;
      if (!isSyncedPgRecord(item)) return item;
      const current = this.docReviewCurrentGuard();
      if (this.docEditDraftDirty || this.docMergePending) await this.persistSelectedDocDraft();
      if (!current()) return null;
      if (!isOnlineForPgEdit()) { this.docNeedsHeadCheck = true; return null; }
      let head;
      try {
        head = await this.hydrateSelectedDocWithRetry(item.record_id, { requireFresh: true, isCurrent: current, requireComplete: true, throwError: true });
      } catch (error) {
        if (!current()) return null;
        this.docNeedsHeadCheck = true;
        this.docEditAccessMessage = Number(error.status) === 403 ? 'You no longer have access to this document. Your local draft is preserved.'
          : [404, 410].includes(Number(error.status)) ? 'This document is no longer available. Your local draft is preserved.'
          : 'The latest document could not be checked. Your local draft is preserved; reconnect and retry.';
        return null;
      }
      if (!current()) return null;
      if (!head || !isDocumentContentReadyForEditor(head) || head.record_state !== 'active') {
        this.docNeedsHeadCheck = true;
        this.docEditAccessMessage = 'The latest document is unavailable, deleted or inaccessible. Your draft is preserved. Reconnect or check access before saving.';
        return null;
      }
      if (Number(head.version) < Math.max(Number(this.docLatestRemote?.version || 0), Number(this.selectedDocument?.version || 0))) {
        this.docNeedsHeadCheck = true;
        this.docEditAccessMessage = 'The shared version changed while checking. Your draft is preserved; retry review.';
        return null;
      }
      this.docNeedsHeadCheck = false;
      this.docLatestRemote = toRaw(head);
      if (!this.docEditDraftDirty && !this.docLocalDraft && !this.docDraftChoice && !this.docEditorSharesDirty) {
        this.applySelectedDocAuthoritativeContent(head, { preserveSelection: true });
        return head;
      }
      const base = this.buildSelectedDocDraftRow();
      const headIdentity = documentEditorBaseIdentity(head);
      const matches = base?.base_available && Number(base.base_row_version) === Number(head.version)
        && base.base_body_sha256_hex === headIdentity.base_body_sha256_hex
        && (!base.base_version_id || base.base_version_id === headIdentity.base_version_id);
      if (!matches) {
        this.docEditConflict = { baseVersion: this.docEditBaseRowVersion, currentVersion: head.version, currentHead: headIdentity };
        this.docEditAccessState = 'conflict';
        this.docEditAccessMessage = 'Newer version available — Review changes. Your draft is preserved.';
        this.cancelDocAutosave();
        await this.persistSelectedDocDraft();
      }
      return head;
    },

    async reviewSelectedDocChanges() {
      if (this.docReviewBusy) return false;
      const current = this.docReviewCurrentGuard();
      this.docReviewBusy = true;
      this.cancelDocAutosave();
      try {
        const head = await this.checkSelectedDocLatest();
        if (!head || !current()) return false;
        const local = working(this);
        const baseDocument = this.docSavedSnapshot || this.docLocalDraft?.base_document;
        const base = this.docEditBaseAvailable && baseDocument && isDocumentContentReadyForEditor(baseDocument)
          && Number(baseDocument.version) === Number(this.docEditBaseRowVersion)
          && documentContentSignature(baseDocument) === this.docEditBaseContentSignature ? editable(baseDocument) : null;
        const previous = this.docReview || this.docLocalDraft?.review_state;
        const sameReview = previous && identity(previous.head) === identity(head) && signature(previous.local) === signature(local);
        const input = { base, local: editable(local), latest: editable(head), localText: local.content, latestText: head.content,
          resolutions: sameReview ? toRaw(previous.input.resolutions) : {} };
        const result = await reviewDocumentInWorker(input);
        if (!current()) return false;
        if (signature(local) !== signature(working(this))) {
          this.docEditAccessMessage = 'Your draft changed during review preparation. Review again to include those edits.';
          return false;
        }
        if (!sameReview && previous?.result?.value) {
          const preview = prosemirrorToFlightDeckContentModel(previous.result.value.editor_state);
          this.docReviewPrevious = [...(this.docReviewPrevious || []), { title: previous.result.value.title, content: preview.content, latestVersion: previous.head.version, unresolved: previous.result.unresolved }];
        }
        this.docReview = { head, local, input, result, confirmReplace: false, baseVersion: this.docEditBaseRowVersion };
        await this.persistSelectedDocDraft();
        return true;
      } catch (error) {
        if (current()) this.docEditAccessMessage = error.message;
        return false;
      } finally { if (current()) this.docReviewBusy = false; }
    },

    async resolveSelectedDocMerge(id, choice) {
      const review = this.docReview;
      if (!review || this.docReviewBusy || !['local', 'latest'].includes(choice)) return false;
      const current = this.docReviewCurrentGuard();
      this.docReviewBusy = true;
      try {
        const input = { ...toRaw(review.input), resolutions: { ...review.input.resolutions, [id]: choice } };
        const result = await reviewDocumentInWorker(input);
        if (!current() || this.docReview !== review) return false;
        review.input = input; review.result = result;
        await this.persistSelectedDocDraft();
        return true;
      } finally { if (current()) this.docReviewBusy = false; }
    },

    async closeSelectedDocReview() {
      // Review choices are recoverable independently of the visible panel.
      if (this.docReview) await this.persistSelectedDocDraft();
      this.docReview = null;
      return true;
    },

    async applySelectedDocReview(action) {
      const review = this.docReview;
      if (!review || this.docReviewBusy || !['accept', 'merge'].includes(action)) return false;
      if (action === 'accept' && (this.docEditDraftDirty || this.docLocalDraft) && !review.confirmReplace) return false;
      if (action === 'merge' && (!review.input.base || review.result.unresolved)) return false;
      const current = this.docReviewCurrentGuard();
      this.docReviewBusy = true;
      let refresh = false;
      try {
        await this.persistSelectedDocDraft();
        const head = await this.checkSelectedDocLatest();
        if (!head || !current()) return false;
        if (identity(head) !== identity(review.head) || signature(working(this)) !== signature(review.local)) {
          refresh = true;
          this.docEditAccessMessage = 'The document changed during review. Your draft and previous review are preserved; review the latest changes again.';
          return false;
        }
        const original = toRaw(this.buildSelectedDocDraftRow());
        if (action === 'merge') {
          const model = prosemirrorToFlightDeckContentModel(review.result.value.editor_state);
          // Persist the merged work against its new common base before touching
          // the editor. Failure/navigation cannot leave a half-applied merge.
          const base = documentEditorBaseIdentity(head);
          const row = { ...original, ...model, title: review.result.value.title,
            ...base, base_document: toRaw(head), base_content_signature: documentContentSignature(head),
            review_original: original.review_original || { ...original, preserved_copies: undefined, review_state: null }, review_state: null,
            merge_pending: true, recovery_id: null, recovery: null, current_head: null, draft_status: 'dirty' };
          await this.persistSelectedDocDraft({ row });
          if (!current()) return false;
          if (signature(working(this)) !== signature(review.local)) {
            await this.persistSelectedDocDraft();
            this.docEditAccessMessage = 'Your draft changed while preparing the merge. It is preserved; review again.';
            return false;
          }
          await upsertDocument(head);
          if (!current()) return false;
          this.patchDocumentLocal(head);
          if (signature(working(this)) !== signature(review.local)) {
            await this.persistSelectedDocDraft();
            this.docEditAccessMessage = 'Your draft changed while loading the merge. It is preserved; review again.';
            return false;
          }
          this.applySelectedDocAuthoritativeContent({ ...head, ...model, title: row.title }, { preserveSelection: false });
          this.docSavedSnapshot = toRaw(head);
          this.setSelectedDocBaseIdentity(base);
          this.docEditBaseContentSignature = documentContentSignature(head);
          this.docEditDraftDirty = true;
          this.docMergePending = true;
          this.docAutosaveState = 'device';
          this.docEditAccessState = 'ready';
          this.docEditAccessMessage = 'Merged draft ready. Edit the result, then Save to publish the next version.';
          this.docLocalDraft = row;
          this.docReview = null;
          await this.persistSelectedDocDraft();
          // Normal lease acquisition remains permission-checked; no takeover.
          await this.beginSelectedDocLeaseAcquisition();
        } else {
          await preserveDocumentDraftCopy(original);
          if (!current()) return false;
          await this.loadSelectedDocPreservedCopies();
          if (!current()) return false;
          await upsertDocument(head);
          if (!current()) return false;
          this.patchDocumentLocal(head);
          // Clear durable draft only after a complete fresh latest has loaded.
          if (!await this.clearSelectedDocDraft(head) || !current()) return false;
          if (signature(working(this)) !== signature(review.local)) {
            await this.persistSelectedDocDraft();
            this.docEditAccessMessage = 'Your draft changed while accepting latest. It is preserved; review again.';
            return false;
          }
          this.applySelectedDocAuthoritativeContent(head, { preserveSelection: false });
          this.docReview = null; this.docMergePending = false; this.docLatestRemote = head;
          this.docEditAccessState = 'ready';
          this.docEditAccessMessage = 'Latest saved version accepted. No new version was created.';

        }
        return true;
      } catch (error) {
        if (current()) this.docEditAccessMessage = `Your draft is preserved. ${error.message}`;
        return false;
      } finally {
        if (current()) {
          this.docReviewBusy = false;
          if (refresh) this.docReview.confirmReplace = false;
        }
      }
    },
  };
}
