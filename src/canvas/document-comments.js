import { liveQuery } from 'dexie';
import { getTowerPgDocComments, createTowerPgDocComment } from '../api.js';
import { getWorkspaceDb, upsertComment, replacePgCommentsForTarget } from '../db.js';
import { mapPgDocCommentToLocal } from '../pg-read-hydrator.js';
import { canonicalDocumentAgentMentions } from '../document-agent-mentions.js';
import { assertIdentity } from './projection.js';
import { captureCanvasDocumentAnchor, revealCanvasDocumentAnchor } from './document.js';

// Each reader owns its drafts and authorization lifetime. Accepted records use
// the same Dexie table and typed routes as Documents, never Canvas comments.
export function canvasDocumentComments(deps = {}) {
  const read = deps.read || getTowerPgDocComments, create = deps.create || createTowerPgDocComment;
  const database = deps.database || getWorkspaceDb, put = deps.put || upsertComment;
  const reconcile = deps.reconcile || replacePgCommentsForTarget;
  let context, docId, owner, rootElement, subscription, disposed = false, generation = 0, focus, pending;
  const options = () => ({ baseUrl: context.baseUrl, appNpub: context.appNpub });
  const current = ticket => !disposed && ticket === generation && owner.naplet.access === 'ready' && owner.naplet.source?.id === docId;
  const validate = payload => assertIdentity({ ...payload, workspace_id: context.workspaceId }, context);
  const map = row => {
    if (row?.workspace_id !== context.workspaceId || (row.doc_id || row.target_record_id) !== docId || !row.id) throw new Error('Invalid document comment response.');
    return mapPgDocCommentToLocal(row, { workspaceOwnerNpub: context.workspaceOwnerNpub });
  };
  return {
    commentsOpen: false, commentsReady: false, commentsLoading: false, commentBusy: false,
    documentComments: [], commentError: '', commentBody: '', replyTo: '', commentAnchor: null, commentsLimited: false,
    init() {
      owner = this; rootElement = this.$el; context = this.$store.canvas.context(); docId = this.naplet.source.id;
      this.$watch?.('naplet.source.id', id => this.bindDocumentSource(id));
      this.$watch?.('naplet.access', access => { if (access !== 'ready') this.bindDocumentSource(''); });
      focus = () => { if (this.commentsOpen) void this.refreshDocumentComments(); };
      globalThis.addEventListener('focus', focus);
    },
    bindDocumentSource(id) {
      if (id === docId) return;
      generation++; subscription?.unsubscribe(); subscription = null; docId = id;
      this.documentComments = []; this.commentBody = ''; this.replyTo = ''; this.commentAnchor = null;
      this.commentsOpen = false; this.commentsReady = false; this.commentsLoading = false; this.commentBusy = false; this.commentError = ''; pending = null;
    },
    commentAuthor(comment) {
      const npub = String(comment.sender_npub || '');
      if (npub && npub === context.viewer) return 'You';
      return npub ? `${npub.slice(0, 12)}…${npub.slice(-4)}` : (comment.pg_created_by_actor_id ? `Member ${comment.pg_created_by_actor_id.slice(0, 8)}` : 'Workspace member');
    },
    commentTime(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    },
    destroy() {
      disposed = true; generation++; subscription?.unsubscribe();
      globalThis.removeEventListener('focus', focus);
      this.documentComments = []; this.commentBody = ''; this.commentAnchor = null; pending = null;
    },
    get documentRoots() { return this.documentComments.filter(row => !row.parent_comment_id); },
    documentReplies(id) { return this.documentComments.filter(row => row.parent_comment_id === id); },
    async openDocumentComments() {
      this.commentsOpen = true;
      await this.refreshDocumentComments();
    },
    async refreshDocumentComments() {
      if (disposed || this.commentsLoading || this.commentBusy) return;
      const ticket = ++generation;
      this.commentsLoading = true; this.commentError = '';
      try {
        let observed = new Set((await database().comments.where('target_record_id').equals(docId).toArray()).map(row => row.record_id));
        if (!current(ticket)) return;
        const payload = await read(context.workspaceId, docId, options());
        if (!current(ticket)) return;
        validate(payload);
        if (!Array.isArray(payload.comments)) throw new Error('Document comments unavailable.');
        const rows = payload.comments.map(map);
        // Only a fresh signed read opens the local projection. Do not expose a
        // previous actor's cached comments while authorization is unresolved.
        await reconcile(docId, rows);
        if (!current(ticket)) return;
        this.commentsReady = true; this.commentsLimited = rows.length >= 200;
        subscription?.unsubscribe();
        const ids = new Set(rows.map(row => row.record_id));
        subscription = liveQuery(() => database().comments.where('target_record_id').equals(docId).toArray()).subscribe({
          next: values => {
            if (!current(ticket)) return;
            if (observed) for (const row of values) if (!observed.has(row.record_id)) ids.add(row.record_id);
            observed = new Set(values.map(row => row.record_id));
            this.documentComments = values.filter(row => row.pg_workspace_id === context.workspaceId && row.record_state !== 'deleted' && row.sync_status === 'synced' && ids.has(row.record_id))
              .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
          },
          error: () => { if (current(ticket)) this.commentError = 'Could not read document comments. Try Refresh.'; },
        });
      } catch (error) {
        if (current(ticket)) {
          this.commentError = `Could not load document comments. ${error.message || 'Try Refresh.'}`;
          this.commentsReady = false; this.documentComments = []; subscription?.unsubscribe();
        }
      } finally { if (current(ticket)) this.commentsLoading = false; }
    },
    startDocumentComment() {
      if (this.commentBusy || this.commentBody.trim()) return;
      this.replyTo = ''; this.commentAnchor = captureCanvasDocumentAnchor(rootElement);
      void this.openDocumentComments();
    },
    startDocumentReply(root) {
      if (this.commentBusy || this.commentBody.trim()) { this.commentError = 'Send or clear your current draft before replying.'; return; }
      this.replyTo = root.record_id;
      this.commentAnchor = { ...root.pg_metadata };
      pending = null;
      this.$nextTick(() => this.$refs.documentCommentBody.focus({ preventScroll: true }));
    },
    wholeDocumentComment() { if (!this.commentBusy) { this.replyTo = ''; this.commentAnchor = null; pending = null; } },
    revealDocumentComment(root) {
      const result = revealCanvasDocumentAnchor(rootElement, root);
      this.commentError = result.state === 'found' ? '' : 'The selected text has changed or is no longer available.';
    },
    async sendDocumentComment() {
      const body = this.commentBody.trim();
      if (!body || this.commentBusy || this.commentsLoading || !this.commentsReady || disposed) return;
      this.commentBusy = true; this.commentError = '';
      const ticket = generation;
      const metadata = { ...(this.commentAnchor || {}), comment_status: 'open' };
      delete metadata.client_record_id;
      const signature = JSON.stringify([body, this.replyTo, metadata]);
      if (!pending || pending.signature !== signature) pending = { signature, id: crypto.randomUUID(), attempted: false };
      const attempt = pending;
      try {
        // A transport error can follow a successful write. Reconcile the exact
        // client id before retrying, rather than duplicating the user's reply.
        let accepted;
        if (attempt.attempted) {
          const payload = await read(context.workspaceId, docId, options());
          if (!current(ticket)) return;
          validate(payload);
          accepted = payload.comments?.find(row => row.metadata?.client_record_id === attempt.id);
          if (!accepted && payload.comments?.length >= 200) throw new Error('Could not confirm the earlier send in this limited history. Check Documents before retrying.');
        }
        if (!accepted) {
          attempt.attempted = true;
          const mentions = canonicalDocumentAgentMentions(body);
          const result = await create(context.workspaceId, docId, {
            body, ...(this.replyTo ? { parent_comment_id: this.replyTo } : {}), mentions,
            metadata: { ...metadata, client_record_id: attempt.id, mentions },
          }, options());
          if (!current(ticket)) return;
          validate(result); accepted = result.comment;
        }
        const row = map(accepted);
        await put(row);
        if (!current(ticket)) return;
        this.commentBody = ''; this.replyTo = ''; this.commentAnchor = null; pending = null;
      } catch (error) {
        if (current(ticket)) this.commentError = `Comment not confirmed. Your draft is kept; retry when ready. ${error.message || ''}`;
      } finally { if (current(ticket)) this.commentBusy = false; }
    },
  };
}
