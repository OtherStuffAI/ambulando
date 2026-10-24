import { yieldToBrowser } from '../utils/yield-to-browser.js';
import { captureRichEditorSelectionAnchor, revealRichEditorSelectionAnchor } from '../docs/editor/comment-selection-anchor.js';
import { loadTiptapEditorAdapter } from '../docs/editor/lazy-tiptap-editor.js';
import { resolveDocumentProseMirrorState } from '../docs/editor/markdown-to-prosemirror.js';

import { canvasDocumentModel } from '../docs/stored-content.js';

// Readers share the page's event loop. Run one conversion/mount/append per
// painted frame, rather than allowing all resolved imports to drain together.
let readerWork = Promise.resolve();
function readerTask(action) {
  const next = readerWork.then(async () => {
    if (typeof requestAnimationFrame === 'function' && !document.hidden) {
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    } else await yieldToBrowser();
    return action();
  });
  readerWork = next.catch(() => undefined);
  return next;
}

const readers = new WeakMap();
const readerFor = root => readers.get(root.querySelector('[x-canvas-document]'));
export function captureCanvasDocumentAnchor(root) {
  const editor = readerFor(root), selection = globalThis.getSelection?.();
  const surface = editor?.view?.dom;
  // A read-only editor need not own focus when native text is selected. Map
  // that exact DOM range rather than reusing a stale ProseMirror selection.
  if (!surface || !selection?.rangeCount || selection.isCollapsed
    || !surface.contains(selection.anchorNode) || !surface.contains(selection.focusNode)) return null;
  try {
    const from = editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset);
    const to = editor.view.posAtDOM(selection.focusNode, selection.focusOffset);
    return captureRichEditorSelectionAnchor({ state: { doc: editor.state.doc, selection: { from, to } } });
  } catch { return null; }
}
export const revealCanvasDocumentAnchor = (root, comment) => {
  if (root.querySelector('[x-canvas-document]')?.getAttribute('aria-busy') === 'true') return { state: 'loading' };
  return revealRichEditorSelectionAnchor(readerFor(root), comment);
};

// Keep editor instances out of Alpine proxies; dispose when a source is removed
// or access is revoked. Layout-only snapshots must retain selection and scroll.
export function registerCanvasDocument(Alpine) {
  Alpine.directive('canvas-document', (element, { expression }, { evaluateLater, effect, cleanup }) => {
    const evaluate = evaluateLater(expression);
    const scroll = element.closest('.canvas-document-scroll');
    // The whiteboard suppresses native touch gestures on its stage. Translate
    // one-finger reading locally so that ancestor touch-action does not pan it.
    let touch, pendingScroll = null, pendingSelection = null;
    const userNavigation = () => { pendingScroll = null; pendingSelection = null; };
    for (const type of ['wheel', 'pointerdown', 'keydown']) scroll?.addEventListener(type, userNavigation, { passive: true });
    const startTouch = event => { userNavigation(); touch = event.touches.length === 1 ? event.touches[0] : null; };
    const moveTouch = event => {
      if (!touch || event.touches.length !== 1 || !scroll) return;
      const next = event.touches[0];
      const scale = scroll.getBoundingClientRect().width / scroll.offsetWidth || 1;
      scroll.scrollLeft += (touch.clientX - next.clientX) / scale;
      scroll.scrollTop += (touch.clientY - next.clientY) / scale;
      touch = next;
      event.preventDefault();
    };
    scroll?.addEventListener('touchstart', startTouch, { passive: true });
    scroll?.addEventListener('touchmove', moveTouch, { passive: false });
    let adapter, disposed = false, latest = '', rendered, activeBody, generation = 0, createAdapter;
    const loading = document.createElement('p');
    loading.className = 'canvas-document-loading'; loading.setAttribute('role', 'status');
    loading.textContent = 'Loading document…'; element.before(loading);
    const setLoading = busy => {
      element.setAttribute('aria-busy', String(busy)); loading.hidden = !busy;
      if (busy) loading.textContent = 'Loading document…';
    };
    const retainScroll = action => {
      const top = pendingScroll?.top ?? scroll?.scrollTop ?? 0, left = pendingScroll?.left ?? scroll?.scrollLeft ?? 0;
      action();
      if (scroll) { scroll.scrollTop = top; scroll.scrollLeft = left; }
    };
    const update = async () => {
      if (!createAdapter || rendered === latest || activeBody === latest || disposed) return;
      const token = ++generation, body = latest; activeBody = body;
      const current = () => !disposed && token === generation;
      setLoading(true);
      // Resolved imports and Alpine effects otherwise queue every reader mount
      // in one microtask drain. Give the title bar/input a real task boundary.
      try {
        const state = await readerTask(() => current() ? resolveDocumentProseMirrorState(canvasDocumentModel(body)) : null);
        if (!current()) return;
        const nodes = state.content || [], initialSize = 16;
        let chunkSize = 32;
        const progressive = nodes.length > 40;
        const initial = progressive ? { ...state, content: nodes.slice(0, initialSize) } : state;
        await readerTask(() => {
          if (!current()) return;
          rendered = undefined;
          pendingScroll = adapter && scroll ? { top: scroll.scrollTop, left: scroll.scrollLeft } : null;
          const selection = adapter?.editor?.state?.selection;
          pendingSelection = selection ? { from: selection.from, to: selection.to } : null;
          if (!adapter) {
            adapter = createAdapter({ element, editable: false, editorState: initial });
            readers.set(element, adapter.editor);
          } else retainScroll(() => adapter.setContent(initial, { preserveSelection: true }));
        });
        for (let offset = initialSize; progressive && offset < nodes.length;) {
          if (!current()) return;
          const count = chunkSize;
          await readerTask(() => {
            if (!current()) return;
            const started = performance.now();
            retainScroll(() => adapter.appendReadOnlyContent(nodes.slice(offset, offset + count)));
            const elapsed = performance.now() - started;
            if (elapsed < 4) chunkSize = Math.min(128, count * 2);
            else if (elapsed > 8) chunkSize = Math.max(8, Math.floor(count / 2));
          });
          offset += count;
        }
        if (current()) {
          if (pendingSelection && adapter?.editor) {
            const max = Math.max(1, adapter.editor.state.doc.content.size);
            adapter.editor.commands.setTextSelection({ from: Math.min(pendingSelection.from, max), to: Math.min(pendingSelection.to, max) });
          }
          pendingScroll = null; pendingSelection = null;
          rendered = body; activeBody = undefined; setLoading(false);
        }
      } catch {
        if (current()) { setLoading(false); loading.hidden = false; loading.textContent = 'Document preview unavailable. Open in Ambulando to read or edit.'; }
      }
    };
    effect(() => evaluate(value => {
      const next = value ?? '';
      if (next !== latest) { ++generation; activeBody = undefined; }
      latest = next;
      if (rendered === latest) setLoading(false);
      else void update();
    }));
    loadTiptapEditorAdapter().then(({ createTiptapEditorAdapter }) => {
      if (disposed) return;
      createAdapter = createTiptapEditorAdapter;
      void update();
    }).catch(() => {
      if (!disposed) { setLoading(false); element.textContent = 'Document preview unavailable. Open in Ambulando to read or edit.'; }
    });
    cleanup(() => {
      disposed = true; ++generation; loading.remove(); readers.delete(element); adapter?.destroy();
      for (const type of ['wheel', 'pointerdown', 'keydown']) scroll?.removeEventListener(type, userNavigation);
      scroll?.removeEventListener('touchstart', startTouch);
      scroll?.removeEventListener('touchmove', moveTouch);
    });
  });
}
