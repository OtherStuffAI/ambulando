import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat document full-page navigation', () => {
  it('renders an always-visible origin-aware Back button in the document header', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    expect(html).toContain('class="task-back-btn doc-back-btn"');
    expect(html).toContain('@click="$store.chat.returnFromDoc()"');
    expect(html).toContain('Back');
  });

  it('routes chat doc mentions through the hydrated full-page opener', () => {
    const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

    expect(source).toContain('resolveInternalReference(this, linkType, recordId');
    expect(source).toContain("this.handleMentionNavigate('doc', recordId, options)");
    expect(source).toContain('this.openDoc(recordId,');
    expect(source).not.toContain('this.createOptimisticChatDoc(docId, options.title)');

  });

  it('prefetches doc mention cards before click without blocking modal open', () => {
    const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

    expect(source).toContain("document.addEventListener('pointerover'");
    expect(source).toContain("document.addEventListener('focusin'");
    expect(source).toContain('this.prefetchFlightDeckDoc(link.dataset.mentionId)');
    expect(source).toContain('docHydrationInFlightById');
    expect(source).toContain("content_storage_status: 'loading'");
  });

  it('intercepts same-origin docs links in chat before they open a new window', () => {
    const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

    expect(source).toContain("route.section === 'docs' && params.docid");
    expect(source).toContain('this.handleMentionNavigate(type, id, { commentId: params.commentid');
    expect(source).toContain('url.origin !== window.location.origin');
  });

  it('makes the shared document opener enforce the full-page docs section', () => {
    const source = readFileSync(new URL('../src/docs-manager.js', import.meta.url), 'utf8');
    const start = source.indexOf('openDoc(recordId, options = {})');
    const end = source.indexOf('closeDocEditor(options = {})', start);
    const method = source.slice(start, end);

    expect(method).toContain("this.navSection = 'docs'");
    expect(method).toContain('this.chatDocModalOpen = false');
    expect(method).toContain('this.docDetailOriginRoute');
  });

  it('stores document origins in route history', () => {
    const source = readFileSync(new URL('../src/shell-state.js', import.meta.url), 'utf8');

    expect(source).toContain('state.docDetailOriginRoute = this.docDetailOriginRoute');
    expect(source).toContain("originRoute: window.history.state?.docDetailOriginRoute || ''");
  });

  it('resets legacy chat document modal state before full-page navigation', () => {
    const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
    const start = source.indexOf('async openChatDocModal(recordId, options = {})');
    const end = source.indexOf('closeChatDocModal()', start);
    const methods = source.slice(start, end);

    expect(methods).toContain("this.handleMentionNavigate('doc', recordId, options)");

  });
});
