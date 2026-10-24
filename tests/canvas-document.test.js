// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { registerCanvasDocument, captureCanvasDocumentAnchor, revealCanvasDocumentAnchor } from '../src/canvas/document.js';

const loader = vi.hoisted(() => vi.fn());
vi.mock('../src/docs/editor/lazy-tiptap-editor.js', () => ({ loadTiptapEditorAdapter: loader }));

function mount(body) {
  document.body.innerHTML = '<div class="canvas-document-scroll"><div id="reader"></div></div>';
  let directive, refresh, dispose, value = body;
  registerCanvasDocument({ directive: (_name, handler) => { directive = handler; } });
  const element = document.querySelector('#reader');
  directive(element, { expression: 'body' }, {
    evaluateLater: () => callback => callback(value),
    effect: callback => { refresh = callback; callback(); },
    cleanup: callback => { dispose = callback; },
  });
  return { element, update: next => { value = next; refresh(); }, dispose };
}

it('mounts read-only, coalesces loading updates, preserves layout-only state and destroys on removal', async () => {
  let resolve;
  loader.mockReturnValue(new Promise(done => { resolve = done; }));
  const adapter = { setContent: vi.fn(), destroy: vi.fn() }, create = vi.fn(() => adapter);
  const reader = mount('# First');
  reader.update('# Latest');
  resolve({ createTiptapEditorAdapter: create });
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0][0]).toMatchObject({ element: reader.element, editable: false, editorState: { type: 'doc' } });
  expect(JSON.stringify(create.mock.calls[0][0].editorState)).toContain('Latest');
  reader.update('# Latest');
  expect(adapter.setContent).not.toHaveBeenCalled();
  const scroll = reader.element.parentElement;
  scroll.scrollTop = 80; scroll.scrollLeft = 12;
  reader.update('> Changed');
  await vi.waitFor(() => expect(adapter.setContent).toHaveBeenCalledWith(expect.objectContaining({ type: 'doc' }), { preserveSelection: true }));
  expect([scroll.scrollTop, scroll.scrollLeft]).toEqual([80, 12]);
  reader.dispose();
  expect(adapter.destroy).toHaveBeenCalledOnce();
});

it('does not mount after access removal while the shared adapter is loading', async () => {
  let resolve;
  loader.mockReturnValue(new Promise(done => { resolve = done; }));
  const create = vi.fn();
  const reader = mount('Private source');
  reader.dispose();
  resolve({ createTiptapEditorAdapter: create });
  await Promise.resolve();
  expect(create).not.toHaveBeenCalled();
});

it('provides a usable failure message when the renderer cannot load', async () => {
  loader.mockRejectedValue(new Error('unavailable'));
  const reader = mount('Source');
  await vi.waitFor(() => expect(reader.element.textContent).toContain('Open in Ambulando'));
  reader.dispose();
});

it('contains one-finger reading at canvas zoom and removes touch handlers on disposal', async () => {
  loader.mockResolvedValue({ createTiptapEditorAdapter: () => ({ destroy() {} }) });
  const reader = mount('Read only');
  const scroll = reader.element.parentElement;
  Object.defineProperty(scroll, 'offsetWidth', { value: 200 });
  scroll.getBoundingClientRect = () => ({ width: 400 });
  const send = (type, x, y) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
    scroll.dispatchEvent(event);
    return event;
  };
  send('touchstart', 100, 100);
  expect(send('touchmove', 80, 60).defaultPrevented).toBe(true);
  expect([scroll.scrollLeft, scroll.scrollTop]).toEqual([10, 20]);
  reader.dispose();
  send('touchmove', 0, 0);
  expect([scroll.scrollLeft, scroll.scrollTop]).toEqual([10, 20]);
});

it.each([
  JSON.stringify({ format: 'document_content_v1', content_model: { content: '# Stored heading\n\n| Name | Value |\n| --- | --- |\n| A | B |' } }),
  { format: 'document_content_v1', content_model: { content: '# Stored heading' } },
])('decodes stored envelopes before Markdown conversion', async body => {
  const create = vi.fn(() => ({ destroy() {} }));
  loader.mockResolvedValue({ createTiptapEditorAdapter: create });
  const reader = mount(body);
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const state = create.mock.calls[0][0].editorState;
  expect(state.content[0]).toMatchObject({ type: 'heading', content: [{ text: 'Stored heading' }] });
  expect(JSON.stringify(state)).not.toContain('content_model');
  reader.dispose();
});

it('retains native rich state and metadata rather than rebuilding from fallback Markdown', async () => {
  const native = { type: 'doc', content: [{ type: 'paragraph', attrs: { fdBlockId: 'anchor' }, content: [{ type: 'text', text: 'Rich source', marks: [{ type: 'bold' }] }] }] };
  const create = vi.fn(() => ({ destroy() {} }));
  loader.mockResolvedValue({ createTiptapEditorAdapter: create });
  const reader = mount(JSON.stringify({ format: 'document_content_v1', content_model: { content: 'Fallback', content_format: 'prosemirror', content_blocks: [], editor_state: native } }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0][0].editorState).toEqual(native);
  reader.dispose();
});


it('captures the native read-only selection rather than stale editor focus', async () => {
  const doc = { textBetween: () => 'Selected passage' };
  let editor;
  loader.mockResolvedValue({ createTiptapEditorAdapter: ({ element }) => {
    element.textContent = 'Selected passage';
    editor = { view: { dom: element, posAtDOM: (_node, offset) => offset + 1 }, state: { doc, selection: { from: 1, to: 1 } } };
    return { editor, destroy() {} };
  } });
  const reader = mount('Selected passage');
  reader.element.setAttribute('x-canvas-document', 'body');
  await vi.waitFor(() => expect(editor).toBeDefined());
  const selection = window.getSelection(), range = document.createRange();
  range.setStart(reader.element.firstChild, 0); range.setEnd(reader.element.firstChild, 16); selection.removeAllRanges(); selection.addRange(range);
  expect(captureCanvasDocumentAnchor(reader.element.parentElement)).toMatchObject({ anchor_quote: 'Selected passage', anchor_start_offset: 1, anchor_end_offset: 17 });
  selection.removeAllRanges();
  expect(captureCanvasDocumentAnchor(reader.element.parentElement)).toBeNull();
  reader.dispose();
});


it('yields between real content batches and cancels remaining work when removed', async () => {
  const native = { type: 'doc', content: Array.from({ length: 100 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Block ${i}` }] })) };
  const adapter = { destroy: vi.fn(), appendReadOnlyContent: vi.fn() };
  const create = vi.fn(() => adapter);
  loader.mockResolvedValue({ createTiptapEditorAdapter: create });
  const body = JSON.stringify({ format: 'document_content_v1', content_model: { content_format: 'prosemirror', editor_state: native } });
  const reader = mount(body);
  adapter.appendReadOnlyContent.mockImplementationOnce(() => reader.dispose());
  await vi.waitFor(() => expect(adapter.destroy).toHaveBeenCalledOnce());
  expect(create.mock.calls[0][0].editorState.content).toHaveLength(16);
  expect(adapter.appendReadOnlyContent).toHaveBeenCalledOnce();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(adapter.appendReadOnlyContent).toHaveBeenCalledOnce();
});

it('replaces an in-flight progressive source and completes only the latest body', async () => {
  const native = { type: 'doc', content: Array.from({ length: 100 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Old ${i}` }] })) };
  const adapter = { destroy: vi.fn(), appendReadOnlyContent: vi.fn(), setContent: vi.fn() };
  loader.mockResolvedValue({ createTiptapEditorAdapter: () => adapter });
  const reader = mount(JSON.stringify({ format: 'document_content_v1', content_model: { content_format: 'prosemirror', editor_state: native } }));
  adapter.appendReadOnlyContent.mockImplementationOnce(() => reader.update('# New authorized body'));
  await vi.waitFor(() => expect(adapter.setContent).toHaveBeenCalledOnce());
  expect(JSON.stringify(adapter.setContent.mock.calls[0][0])).toContain('New authorized body');
  expect(adapter.appendReadOnlyContent).toHaveBeenCalledOnce();
  expect(reader.element.getAttribute('aria-busy')).toBe('false');
  reader.dispose();
});


it('reports a still-loading comment target without scanning a partial document as stale', async () => {
  loader.mockReturnValue(new Promise(() => {}));
  const reader = mount('Loading source');
  reader.element.setAttribute('x-canvas-document', 'body');
  reader.element.setAttribute('aria-busy', 'true');
  expect(revealCanvasDocumentAnchor(reader.element.parentElement, { anchor_quote: 'Later passage' })).toEqual({ state: 'loading' });
  reader.dispose();
});
