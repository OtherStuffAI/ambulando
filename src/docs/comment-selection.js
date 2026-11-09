import { captureRichEditorSelectionAnchor } from './editor/comment-selection-anchor.js';

// Read-only ProseMirror tables do not always update editor.state.selection.
// Map the native range, including nested marks/links, before focus leaves it.
export function captureDocumentDomSelection(editor, selection = globalThis.getSelection?.()) {
  editor = globalThis.Alpine?.raw?.(editor) || editor;
  if (!editor?.view?.dom || !selection?.rangeCount || selection.isCollapsed
    || !editor.view.dom.contains(selection.anchorNode) || !editor.view.dom.contains(selection.focusNode)) return null;
  try {
    return captureRichEditorSelectionAnchor({ state: { doc: editor.state.doc, selection: {
      from: editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset),
      to: editor.view.posAtDOM(selection.focusNode, selection.focusOffset),
    } } });
  } catch { return null; }
}

export function captureDocumentPreviewSelection(surface, blocks, selection = globalThis.getSelection?.()) {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const element = node => node?.nodeType === 1 ? node : node?.parentElement;
  const block = element(range.startContainer)?.closest('[data-doc-selection-block]');
  if (!block || !surface.contains(block) || !block.contains(range.endContainer)) return null;
  const model = blocks[Number(block.dataset.docSelectionBlock)];
  const quote = range.toString();
  if (!model || !quote.trim()) return null;
  const row = element(range.startContainer)?.closest('tr');
  const rows = row ? [...row.closest('table').rows] : [];
  const rowIndex = rows.indexOf(row);
  const line = (Number(model.start_line) || 1) + (rowIndex > 0 ? rowIndex + 1 : 0);
  return { anchor_quote: quote, anchor_block_id: model.id || null, anchor_line_number: line, anchor_end_line_number: line };
}

export function documentCommentSelection(surface, { capture, activate }) {
  const doc = surface.ownerDocument, win = doc.defaultView;
  const button = doc.createElement('button');
  button.type = 'button'; button.className = 'doc-selection-comment'; button.hidden = true;
  button.setAttribute('aria-label', 'Comment on selected text');
  button.title = 'Comment on selected text (Ctrl/⌘ Alt M)';
  button.textContent = '+';
  doc.body.append(button);
  let frame = null, anchor = null, dismissed = null;
  const listeners = [];
  const on = (target, type, handler, options) => {
    target?.addEventListener(type, handler, options);
    listeners.push(() => target?.removeEventListener(type, handler, options));
  };
  function update() {
    frame = null; button.hidden = true; anchor = null;
    const selection = win.getSelection();
    if (!surface.isConnected || !surface.getClientRects().length || !selection?.rangeCount || selection.isCollapsed
      || !surface.contains(selection.anchorNode) || !surface.contains(selection.focusNode)) { dismissed = null; return; }
    const next = capture(selection), key = next && JSON.stringify(next);
    if (!next) return;
    if (key !== dismissed) dismissed = null;
    if (dismissed) return;
    const viewport = win.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
    const bounds = surface.getBoundingClientRect();
    const rects = [...selection.getRangeAt(0).getClientRects()].filter(r => r.width > 0 && r.height > 0
      && r.bottom > Math.max(top, bounds.top) && r.top < Math.min(top + height, bounds.bottom)
      && r.right > Math.max(left, bounds.left) && r.left < Math.min(left + width, bounds.right));
    if (!rects.length || width < 52 || height < 52) return;
    const rect = rects.at(-1);
    button.style.left = `${Math.max(left + 4, Math.min(left + width - 48, bounds.right - 48))}px`;
    button.style.top = `${Math.max(top + 4, Math.min(top + height - 48, rect.top))}px`;
    anchor = next; button.hidden = false;
  }
  const schedule = () => { if (frame === null) frame = win.requestAnimationFrame(update); };
  const begin = () => { update(); if (anchor) { const selected = anchor; dismissed = JSON.stringify(selected); button.hidden = true; activate(selected); } };
  on(button, 'pointerdown', event => event.preventDefault());
  on(button, 'mousedown', event => event.preventDefault());
  on(button, 'click', begin);
  on(doc, 'selectionchange', schedule);
  on(doc, 'scroll', schedule, true);
  on(win, 'resize', schedule);
  on(win.visualViewport, 'resize', schedule);
  on(win.visualViewport, 'scroll', schedule);
  on(doc, 'keydown', event => {
    if (event.key === 'Escape') { dismissed = anchor && JSON.stringify(anchor); button.hidden = true; }
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyM' && !button.hidden) { event.preventDefault(); begin(); }
  });
  const observer = new win.ResizeObserver(schedule); observer.observe(surface);
  return { destroy() { listeners.forEach(remove => remove()); observer.disconnect(); if (frame !== null) win.cancelAnimationFrame(frame); button.remove(); } };
}
