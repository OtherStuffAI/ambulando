// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { captureDocumentDomSelection, captureDocumentPreviewSelection } from '../src/docs/comment-selection.js';
import { getSchema } from '@tiptap/core';
import { createFlightDeckTiptapExtensions } from '../src/docs/editor/prosemirror-flightdeck-schema.js';

function select(node, from = 0, to = node.textContent.length) {
  const range = document.createRange(); range.setStart(node, from); range.setEnd(node, to);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection;
}
describe('document selection comments', () => {
  it('captures formatted table header/body text with source row coordinates', () => {
    document.body.innerHTML = '<section><div data-doc-selection-block="0"><table><thead><tr><th><strong>Header</strong></th></tr></thead><tbody><tr><td><a href="https://example.com">Body text</a></td></tr></tbody></table></div></section>';
    const surface = document.querySelector('section'), blocks = [{ id: 'table', start_line: 5 }];
    expect(captureDocumentPreviewSelection(surface, blocks, select(document.querySelector('strong').firstChild))).toMatchObject({ anchor_quote: 'Header', anchor_line_number: 5, anchor_block_id: 'table' });
    expect(captureDocumentPreviewSelection(surface, blocks, select(document.querySelector('a').firstChild, 0, 4))).toMatchObject({ anchor_quote: 'Body', anchor_line_number: 7 });
    expect(captureDocumentPreviewSelection(document.createElement('div'), blocks)).toBeNull();
  });
  it('maps the native range even when a read-only editor has an empty stale selection', () => {
    document.body.innerHTML = '<div><strong>Header</strong></div>';
    const schema = getSchema(createFlightDeckTiptapExtensions({ editable: false }));
    const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Header' }] }] });
    const editor = { view: { dom: document.querySelector('div'), posAtDOM: (_node, offset) => offset + 1 }, state: { doc, selection: { from: 1, to: 1 } } };
    const selection = select(document.querySelector('strong').firstChild, 1, 5);
    expect(captureDocumentDomSelection(editor, selection)).toMatchObject({ anchor_quote: 'eade', anchor_start_offset: 2, anchor_end_offset: 6 });
  });
});
