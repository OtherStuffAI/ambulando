import { loadTiptapEditorAdapter } from '../docs/editor/lazy-tiptap-editor.js';
import { resolveDocumentProseMirrorState } from '../docs/editor/markdown-to-prosemirror.js';

import { canvasDocumentModel } from '../docs/stored-content.js';

// Keep editor instances out of Alpine proxies; dispose when a source is removed
// or access is revoked. Layout-only snapshots must retain selection and scroll.
export function registerCanvasDocument(Alpine) {
  Alpine.directive('canvas-document', (element, { expression }, { evaluateLater, effect, cleanup }) => {
    const evaluate = evaluateLater(expression);
    const scroll = element.closest('.canvas-document-scroll');
    // The whiteboard suppresses native touch gestures on its stage. Translate
    // one-finger reading locally so that ancestor touch-action does not pan it.
    let touch;
    const startTouch = event => { touch = event.touches.length === 1 ? event.touches[0] : null; };
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
    let adapter, disposed = false, latest = '', rendered;
    const update = () => {
      if (!adapter || rendered === latest) return;
      const top = scroll?.scrollTop || 0, left = scroll?.scrollLeft || 0;
      adapter.setContent(resolveDocumentProseMirrorState(canvasDocumentModel(latest)), { preserveSelection: true });
      rendered = latest;
      if (scroll) { scroll.scrollTop = top; scroll.scrollLeft = left; }
    };
    effect(() => evaluate(value => { latest = value ?? ''; update(); }));
    loadTiptapEditorAdapter().then(({ createTiptapEditorAdapter }) => {
      if (disposed) return;
      adapter = createTiptapEditorAdapter({ element, editable: false, editorState: resolveDocumentProseMirrorState(canvasDocumentModel(latest)) });
      rendered = latest;
    }).catch(() => {
      if (!disposed) element.textContent = 'Document preview unavailable. Open in Ambulando to read or edit.';
    });
    cleanup(() => {
      disposed = true; adapter?.destroy();
      scroll?.removeEventListener('touchstart', startTouch);
      scroll?.removeEventListener('touchmove', moveTouch);
    });
  });
}
