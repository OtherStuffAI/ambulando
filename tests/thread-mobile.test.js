import { describe, expect, it, vi } from 'vitest';

// Mock Alpine.js
vi.mock('alpinejs', () => ({
  default: { nextTick: (fn) => fn?.() },
}));

import { chatMessageManagerMixin } from '../src/chat-message-manager.js';

// ---------------------------------------------------------------------------
// Helper: create a fake store with mixin methods applied
// ---------------------------------------------------------------------------
function createStore(overrides = {}) {
  const store = {
    messages: [],
    channels: [],
    selectedChannelId: null,
    activeThreadId: null,
    threadInput: '',
    messageInput: '',
    messageAudioDrafts: [],
    threadAudioDrafts: [],
    expandedChatMessageIds: [],
    truncatedChatMessageIds: [],
    focusMessageId: null,
    threadVisibleReplyCount: 6,
    threadSize: 'default',
    pendingChatScrollToLatest: false,
    pendingThreadScrollToLatest: false,
    messageImageUploadCount: 0,
    threadImageUploadCount: 0,
    chatFeedScrollFrame: null,
    threadRepliesScrollFrame: null,
    chatPreviewMeasureFrame: null,
    showChannelSettingsModal: false,
    error: null,
    session: null,
    botNpub: '',
    backendUrl: '',
    THREAD_REPLY_PAGE_SIZE: 6,
    COMPOSER_MAX_LINES: 5,
    MESSAGE_PREVIEW_MAX_LINES: 15,
    syncRoute: vi.fn(),
    rememberPeople: vi.fn().mockResolvedValue(undefined),
    captureScrollAnchor: vi.fn().mockReturnValue(null),
    restoreScrollAnchor: vi.fn(),
    scheduleStorageImageHydration: vi.fn(),
    performSync: vi.fn().mockResolvedValue(undefined),
    ensureBackgroundSync: vi.fn(),
    selectChannel: vi.fn().mockResolvedValue(undefined),
    refreshChannels: vi.fn().mockResolvedValue(undefined),
    createEncryptedGroup: vi.fn().mockResolvedValue({ group_id: 'g1' }),
    getPreferredChannelWriteGroup: vi.fn().mockReturnValue('g1'),
    getChannelLabel: vi.fn().mockReturnValue('test-channel'),
    materializeAudioDrafts: vi.fn().mockResolvedValue({ attachments: [] }),
    containsInlineImageUploadToken: vi.fn().mockReturnValue(false),
    workspaceOwnerNpub: 'npub1owner',
    ...overrides,
  };

  const descriptors = Object.getOwnPropertyDescriptors(chatMessageManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }

  return store;
}

// ---------------------------------------------------------------------------
// CSS rule validation helpers
// ---------------------------------------------------------------------------

/**
 * Parse the styles.css file and extract media-query-scoped rules.
 * Returns an array of { breakpoint, selector, declarations } objects.
 */
async function loadStylesheet() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cssPath = path.resolve(import.meta.dirname, '..', 'src', 'styles.css');
  return fs.readFileSync(cssPath, 'utf-8');
}

function findMediaBlock(css, maxWidth) {
  // Find all @media blocks for the given max-width
  const pattern = new RegExp(
    `@media\\s*\\(\\s*max-width\\s*:\\s*${maxWidth}px\\s*\\)\\s*\\{`,
    'g',
  );
  const blocks = [];
  let match;
  while ((match = pattern.exec(css)) !== null) {
    // Walk braces to find the closing brace
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      if (css[i] === '}') depth--;
      i++;
    }
    blocks.push(css.slice(match.index, i));
  }
  return blocks.join('\n');
}

function blockContainsRule(block, selector) {
  return block.includes(selector);
}

function extractDeclarations(block, selector) {
  const idx = block.indexOf(selector);
  if (idx < 0) return '';
  let start = block.indexOf('{', idx);
  if (start < 0) return '';
  let depth = 1;
  let i = start + 1;
  while (i < block.length && depth > 0) {
    if (block[i] === '{') depth++;
    if (block[i] === '}') depth--;
    i++;
  }
  return block.slice(start + 1, i - 1).trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Thread mobile responsive behavior', () => {
  describe('CSS: thread message avatar alignment', () => {
    it('top-aligns only direct Thread View avatar controls and strengthens the scoped separator', async () => {
      const css = await loadStylesheet();

      expect(css).toMatch(/\.thread-message\s*\{[^}]*border-bottom\s*:\s*1px solid color-mix\(in srgb, var\(--text\) 12%, var\(--border\)\)[^}]*\}/s);
      expect(css).toMatch(/\.thread-message\s*>\s*\.identity-avatar-button\s*\{[^}]*align-self\s*:\s*flex-start[^}]*margin-top\s*:\s*0\.15rem[^}]*\}/s);
    });
  });

  describe('CSS: mobile breakpoint rules for thread panel', () => {
    let css;
    let mobileBlock;

    it('loads the stylesheet', async () => {
      css = await loadStylesheet();
      expect(css).toBeTruthy();
      // Combine 768px blocks
      mobileBlock = findMediaBlock(css, 768);
    });

    it('has a mobile rule for .chat-thread-panel to fill the modal width', async () => {
      css = css || await loadStylesheet();
      mobileBlock = mobileBlock || findMediaBlock(css, 768);
      expect(blockContainsRule(mobileBlock, '.chat-thread-panel')).toBe(true);
      const decl = extractDeclarations(mobileBlock, '.chat-thread-panel');
      expect(decl).toMatch(/width\s*:\s*100%/);
      expect(decl).toMatch(/height\s*:\s*calc\(100dvh - 1rem\)/);
    });

    it('uses a modal backdrop instead of hiding .chat-main when thread is open', async () => {
      css = css || await loadStylesheet();
      mobileBlock = mobileBlock || findMediaBlock(css, 768);
      expect(blockContainsRule(mobileBlock, '.chat-thread-modal-backdrop')).toBe(true);
      expect(blockContainsRule(mobileBlock, '.chat-layout-thread-open .chat-main')).toBe(false);
    });

    it('has a mobile rule to keep the thread modal inside the viewport', async () => {
      css = css || await loadStylesheet();
      mobileBlock = mobileBlock || findMediaBlock(css, 768);
      const backdropDecl = extractDeclarations(mobileBlock, '.chat-thread-modal-backdrop');
      expect(backdropDecl).toMatch(/padding\s*:\s*0\.5rem/);
    });

    it('centers the mobile scope selector row and keeps quick workspace access', async () => {
      css = css || await loadStylesheet();
      mobileBlock = mobileBlock || findMediaBlock(css, 768);
      const headerDecl = extractDeclarations(mobileBlock, '.page-header');
      const backdropDecl = extractDeclarations(mobileBlock, '.mobile-sidebar-backdrop');
      const sidebarDecl = extractDeclarations(mobileBlock, '.sidebar');
      const switcherDecl = extractDeclarations(mobileBlock, '.mobile-scope-switcher');
      const contextControlsDecl = extractDeclarations(mobileBlock, '.mobile-scope-context-controls');
      const triggerDecl = extractDeclarations(mobileBlock, '.mobile-scope-trigger');
      const resultsDecl = extractDeclarations(mobileBlock, '.mobile-scope-results');
      const headerZ = Number(headerDecl.match(/z-index\s*:\s*(\d+)/)?.[1]);
      const backdropZ = Number(backdropDecl.match(/z-index\s*:\s*(\d+)/)?.[1]);
      const sidebarZ = Number(sidebarDecl.match(/z-index\s*:\s*(\d+)/)?.[1]);
      const switcherZ = Number(switcherDecl.match(/z-index\s*:\s*(\d+)/)?.[1]);
      const resultsZ = Number(resultsDecl.match(/z-index\s*:\s*(\d+)/)?.[1]);

      expect(switcherDecl).toMatch(/display\s*:\s*block/);
      expect(contextControlsDecl).toMatch(/display\s*:\s*grid/);
      expect(contextControlsDecl).toMatch(/grid-template-columns\s*:\s*38px minmax\(0,\s*1fr\) 38px/);
      expect(backdropDecl).toMatch(/top\s*:\s*var\(--mobile-nav-drawer-top\)/);
      expect(sidebarDecl).toMatch(/top\s*:\s*var\(--mobile-nav-drawer-top\)/);
      expect(sidebarDecl).toMatch(/height\s*:\s*calc\(100dvh - var\(--mobile-nav-drawer-top\)\)/);
      expect(triggerDecl).toMatch(/justify-content\s*:\s*center/);
      expect(triggerDecl).toMatch(/text-align\s*:\s*center/);
      expect(headerZ).toBeGreaterThan(resultsZ);
      expect(resultsZ).toBeGreaterThan(switcherZ);
      expect(switcherZ).toBeGreaterThan(sidebarZ);
      expect(headerZ).toBeGreaterThan(sidebarZ);
      expect(sidebarZ).toBeGreaterThan(backdropZ);
    });

    it('mounts mobile composer actions beside the textarea with thread controls stacked', async () => {
      css = css || await loadStylesheet();
      mobileBlock = mobileBlock || findMediaBlock(css, 768);

      expect(blockContainsRule(mobileBlock, '.chat-input-bar')).toBe(true);
      const chatInputBarDecl = extractDeclarations(mobileBlock, '.chat-input-bar');
      expect(chatInputBarDecl).toMatch(/flex-direction\s*:\s*row/);
      expect(chatInputBarDecl).toMatch(/align-items\s*:\s*flex-end/);

      const chatInputActionsDecl = extractDeclarations(mobileBlock, '.chat-input-actions');
      expect(chatInputActionsDecl).toMatch(/flex-direction\s*:\s*column/);
      expect(chatInputActionsDecl).toMatch(/align-self\s*:\s*flex-end/);

      const chatInputDecl = extractDeclarations(mobileBlock, '.chat-input-bar .chat-input');
      expect(chatInputDecl).toMatch(/align-self\s*:\s*flex-end/);
      expect(chatInputDecl).toMatch(/min-width\s*:\s*0/);

      const threadInputBarDecl = extractDeclarations(mobileBlock, '.thread-input-bar');
      expect(threadInputBarDecl).toMatch(/padding\s*:\s*0\.55rem 0\.65rem/);

      const threadComposerBodyDecl = extractDeclarations(css, '.thread-composer-body');
      expect(threadComposerBodyDecl).toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\) auto/);

      const threadInputActionsDecl = extractDeclarations(mobileBlock, '.thread-input-actions');
      expect(threadInputActionsDecl).toMatch(/flex-direction\s*:\s*column/);
      expect(threadInputActionsDecl).toMatch(/gap\s*:\s*0\.35rem/);

      const threadInputDecl = extractDeclarations(mobileBlock, '.thread-input-bar .chat-input');
      expect(threadInputDecl).toMatch(/align-self\s*:\s*flex-end/);
      expect(threadInputDecl).toMatch(/min-width\s*:\s*0/);
      expect(threadInputDecl).toMatch(/min-height\s*:\s*calc\(\(1\.4em\) \+ 1\.2rem \+ 2px\)/);
    });
  });

  describe('JS: thread lifecycle state on mobile', () => {
    it('openThread sets threadSize to default', () => {
      const store = createStore();
      store.openThread('msg-1');
      expect(store.activeThreadId).toBe('msg-1');
      expect(store.threadSize).toBe('default');
    });

    it('closeThread resets threadSize to default', () => {
      const store = createStore({ threadSize: 'full', activeThreadId: 'msg-1' });
      store.closeThread();
      expect(store.activeThreadId).toBeNull();
      expect(store.threadSize).toBe('default');
    });

    it('cycleThreadSize toggles default -> full -> default', () => {
      const store = createStore();
      expect(store.threadSize).toBe('default');
      store.cycleThreadSize();
      expect(store.threadSize).toBe('full');
      store.cycleThreadSize();
      expect(store.threadSize).toBe('default');
    });
  });

  describe('HTML: thread layout class binding', () => {
    it('keeps only the modal thread composer as a multiline tokenized textbox', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const htmlPath = path.resolve(import.meta.dirname, '..', 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');

      expect(html).not.toContain('data-chat-composer="message"');
      expect(html).toContain('data-chat-composer="thread"');
      expect(html).toContain('contenteditable="true"');
      expect(html).toContain('aria-multiline="true"');
      expect(html).toContain('class="thread-input-actions"');
    });

    it('clips horizontal overflow and keeps desktop resizing separate from the mobile height cap', async () => {
      const css = await loadStylesheet();
      const composerDecl = css.match(/\.chat-input\s*\{([^}]*)\}/)?.[1] || '';
      const mobileBlock = findMediaBlock(css, 768);
      const mobileChatComposerDecl = extractDeclarations(mobileBlock, '.chat-input-bar .chat-input');
      const mobileThreadComposerDecl = extractDeclarations(mobileBlock, '.thread-input-bar .chat-input');

      expect(composerDecl).toMatch(/overflow-x\s*:\s*hidden/);
      expect(composerDecl).toMatch(/overflow-y\s*:\s*hidden/);
      expect(composerDecl).toMatch(/resize\s*:\s*vertical/);
      expect(composerDecl).toMatch(/max-height\s*:\s*min\(50vh,\s*32rem\)/);
      for (const declaration of [mobileChatComposerDecl, mobileThreadComposerDecl]) {
        expect(declaration).toMatch(/resize\s*:\s*none/);
        expect(declaration).toMatch(/max-height\s*:\s*calc\(\(5 \* 1\.4em\) \+ 1\.2rem \+ 2px\)/);
      }
    });

    it('clips horizontal overflow on channel and thread message scrollports', async () => {
      const css = await loadStylesheet();
      const chatFeedDecl = css.match(/\.chat-feed\s*\{([^}]*)\}/)?.[1] || '';
      const threadRepliesDecl = css.match(/\.thread-replies\s*\{([^}]*)\}/)?.[1] || '';

      for (const declaration of [chatFeedDecl, threadRepliesDecl]) {
        expect(declaration).toMatch(/overflow-x\s*:\s*hidden/);
        expect(declaration).toMatch(/overflow-y\s*:\s*auto/);
      }
    });

    it('thread full size state is available for the modal class', async () => {
      const store = createStore({ activeThreadId: 'msg-1', threadSize: 'full' });
      const shouldApplyFull = !!(store.activeThreadId && store.threadSize === 'full');
      expect(shouldApplyFull).toBe(true);
    });

    it('mounts the thread panel in a modal backdrop', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const htmlPath = path.resolve(import.meta.dirname, '..', 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');
      expect(html).toContain('class="chat-thread-modal-backdrop"');
      expect(html).toContain('@click.self="$store.chat.deckThreadComposerOpen ? $store.chat.closeDeckThreadComposer() : $store.chat.closeVisibleThread()"');
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).not.toContain('thread-wide');
      expect(html).not.toContain("threadSize === 'wide'");
    });

    it('uses the command-palette backdrop treatment above mobile chrome', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const cssPath = path.resolve(import.meta.dirname, '..', 'src', 'styles.css');
      const styles = fs.readFileSync(cssPath, 'utf-8');
      const backdropDecl = extractDeclarations(styles, '.chat-thread-modal-backdrop');
      const panelDecl = extractDeclarations(styles, '.chat-thread-panel');
      const taskBackdropDecl = extractDeclarations(styles, '.chat-task-page-backdrop');
      const docBackdropDecl = extractDeclarations(styles, '.chat-doc-page-backdrop');

      expect(backdropDecl).toMatch(/background\s*:\s*color-mix\(in srgb, var\(--primary\) 42%, transparent\)/);
      expect(backdropDecl).toMatch(/backdrop-filter\s*:\s*none/);
      expect(backdropDecl).toMatch(/z-index\s*:\s*220/);
      expect(panelDecl).toMatch(/width\s*:\s*min\(66\.666vw,\s*1120px\)/);
      expect(taskBackdropDecl).toMatch(/z-index\s*:\s*220/);
      expect(taskBackdropDecl).toMatch(/background\s*:\s*color-mix\(in srgb, var\(--primary\) 42%, transparent\)/);
      expect(taskBackdropDecl).toMatch(/backdrop-filter\s*:\s*none/);
      expect(docBackdropDecl).toMatch(/z-index\s*:\s*220/);
      expect(docBackdropDecl).toMatch(/background\s*:\s*color-mix\(in srgb, var\(--primary\) 42%, transparent\)/);
      expect(docBackdropDecl).toMatch(/backdrop-filter\s*:\s*none/);
    });
  });
});
