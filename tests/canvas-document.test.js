// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { registerCanvasDocument } from '../src/canvas/document.js';

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
  expect(adapter.setContent).toHaveBeenCalledWith(expect.objectContaining({ type: 'doc' }), { preserveSelection: true });
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
