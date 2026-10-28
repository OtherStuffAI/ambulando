// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createTiptapEditorAdapter } from '../src/docs/editor/tiptap-editor-adapter.js';
import { markdownToProseMirrorDoc } from '../src/docs/editor/markdown-to-prosemirror.js';

let adapter;
afterEach(() => { adapter?.destroy(); document.body.replaceChildren(); });
function mount(options = {}) {
  const element = document.createElement('div'); document.body.append(element);
  adapter = createTiptapEditorAdapter({ element, document: { content: '@[Petes Notes](mention:document:notes)\n\n[Canvas](/canvas.html?workspaceid=w&canvasid=c)' }, ...options });
  return adapter;
}
function event(target, extra = {}) {
  return { target, button: 0, clientX: 10, clientY: 10,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
}
it('allows null and non-Element click/pointer targets without changing content or selection', () => {
  const onCanvasLink = vi.fn(); const onEditIntent = vi.fn();
  mount({ recordLinks: { search: () => [] }, onCanvasLink, onEditIntent });
  const before = adapter.getJSON(); const selection = adapter.editor.state.selection.toJSON();
  const handlers = adapter.editor.options.editorProps.handleDOMEvents;
  for (const target of [null, undefined, document, window, {}, document.createTextNode('detached')]) {
    for (const type of ['click', 'pointerdown']) {
      expect(handlers[type](adapter.editor.view, event(target))).toBe(false);
    }
  }
  expect(adapter.getJSON()).toEqual(before);
  expect(adapter.editor.state.selection.toJSON()).toEqual(selection);
  expect(onCanvasLink).not.toHaveBeenCalled();
  expect(onEditIntent).toHaveBeenCalledWith('pointer');
});
it('keeps nested/text-node canvas navigation and shift/drag selection behavior', () => {
  const onCanvasLink = vi.fn(); mount({ recordLinks: { search: () => [] }, onCanvasLink });
  const handlers = adapter.editor.options.editorProps.handleDOMEvents;
  const link = adapter.editor.view.dom.querySelector('a[href*="canvas.html"]');
  const nested = document.createElement('strong'); nested.append('Canvas'); link.replaceChildren(nested);
  const click = event(nested.firstChild);
  expect(handlers.click(adapter.editor.view, click)).toBe(true);
  expect(onCanvasLink).toHaveBeenCalledWith(link.href);
  expect(click.preventDefault).toHaveBeenCalledOnce();
  onCanvasLink.mockClear();
  const shifted = event(nested, { shiftKey: true });
  expect(handlers.click(adapter.editor.view, shifted)).toBe(true);
  expect(onCanvasLink).not.toHaveBeenCalled();
  handlers.pointerdown(adapter.editor.view, event(nested.firstChild));
  document.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 30 }));
  expect(handlers.click(adapter.editor.view, event(nested))).toBe(true);
  expect(onCanvasLink).not.toHaveBeenCalled();
  handlers.pointerdown(adapter.editor.view, event(null));
  expect(handlers.click(adapter.editor.view, event(nested))).toBe(true);
  expect(onCanvasLink).toHaveBeenCalledOnce();
});
it('leaves ordinary links and mention navigation to their existing handlers', () => {
  mount({ document: { content: '[Web](https://example.com) and @[Notes](mention:document:notes)' }, recordLinks: { search: () => [] } });
  const handlers = adapter.editor.options.editorProps.handleDOMEvents;
  for (const target of adapter.editor.view.dom.querySelectorAll('a, .mention-link')) {
    const click = event(target.firstChild);
    expect(handlers.click(adapter.editor.view, click)).toBe(false);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(click.stopPropagation).not.toHaveBeenCalled();
  }
});
it('keeps text, newlines, caret and stable link identity before the first reference across reopen', () => {
  mount();
  adapter.editor.commands.setTextSelection(1);
  adapter.editor.commands.insertContent('Before ');
  // Use the same synthetic keyboard shortcut mechanism used by editor commands.
  expect(adapter.editor.commands.keyboardShortcut('Enter')).toBe(true);
  adapter.editor.commands.insertContent('More ');
  const caret = adapter.editor.state.selection.from;
  expect(adapter.editor.state.doc.textContent).toBe('Before More Petes NotesCanvas');
  expect(adapter.editor.state.doc.nodeAt(caret)?.marks[0]?.type.name).toBe('fdMention');
  const saved = adapter.getContentModel();
  expect(saved.editor_state.content[0].content[0]).toMatchObject({ text: 'Before ' });
  expect(saved.editor_state.content[0].content[0].marks).toBeUndefined();
  expect(saved.content).toContain('Before');
  expect(saved.content).toContain('More @[Petes Notes](mention:document:notes)');
  expect(adapter.editor.state.selection.from).toBe(caret);
  adapter.setContent(saved.editor_state);
  expect(adapter.getContentModel().content).toBe(saved.content);
  adapter.setContent(markdownToProseMirrorDoc(saved.content, { contentBlocks: saved.content_blocks }));
  expect(adapter.getContentModel().content).toBe(saved.content);
  expect(adapter.editor.view.dom.querySelector('[data-mention-id="notes"]').textContent).toBe('Petes Notes');
});
