// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createTiptapEditorAdapter } from '../src/docs/editor/tiptap-editor-adapter.js';
import { markdownToProseMirrorDoc } from '../src/docs/editor/markdown-to-prosemirror.js';
import { validateDocumentContentModelRoundTrip } from '../src/docs/editor/document-content-integrity.js';
import { shortRichDocumentFixture } from './fixtures/short-rich-document.js';
import { richBreakDocumentFixture } from './fixtures/rich-break-document.js';
import { documentEditorSemanticTokens } from '../src/docs/editor/document-content-integrity.js';

it('keeps native pasted breaks, underline, shared marks and meaningful edits on repeated reopen', () => {
  const element = document.createElement('div');
  document.body.append(element);
  const adapter = createTiptapEditorAdapter({ element, editorState: richBreakDocumentFixture() });
  try {
    const expected = documentEditorSemanticTokens(adapter.getJSON());
    for (let cycle = 0; cycle < 4; cycle++) {
      const saved = adapter.getContentModel();
      expect(validateDocumentContentModelRoundTrip(saved)).toEqual({ ok: true });
      adapter.setContent(JSON.parse(JSON.stringify(saved.editor_state)));
      expect(documentEditorSemanticTokens(adapter.getJSON())).toEqual(expected);
      adapter.setContent(markdownToProseMirrorDoc(saved.content));
      expect(documentEditorSemanticTokens(adapter.getJSON())).toEqual(expected);
      expect(element.querySelector('u a, a u')).not.toBeNull();
      expect(element.querySelectorAll('br').length).toBeGreaterThan(10);
    }
    adapter.editor.commands.setTextSelection(2);
    adapter.editor.commands.insertContent('revised ');
    const saved = adapter.getContentModel();
    expect(validateDocumentContentModelRoundTrip(saved)).toEqual({ ok: true });
    const edited = documentEditorSemanticTokens(saved.editor_state);
    expect(edited).not.toEqual(expected);
    adapter.setContent(markdownToProseMirrorDoc(saved.content));
    expect(documentEditorSemanticTokens(adapter.getJSON())).toEqual(edited);
  } finally {
    adapter.destroy();
    element.remove();
  }
});

it('keeps native Tiptap heading/list formatting and exact text after rich and Markdown reopens', () => {
  const element = document.createElement('div');
  document.body.append(element);
  const adapter = createTiptapEditorAdapter({ element, editorState: shortRichDocumentFixture() });
  const withoutIds = (state) => JSON.parse(JSON.stringify(state, (key, value) => key === 'fdBlockId' ? undefined : value));
  try {
    // Let Tiptap apply its normal trailing editing paragraph before comparing.
    adapter.setContent(adapter.getJSON());
    const original = withoutIds(adapter.getJSON());
    for (let cycle = 0; cycle < 3; cycle++) {
      const model = adapter.getContentModel();
      expect(validateDocumentContentModelRoundTrip(model)).toEqual({ ok: true });
      adapter.setContent(model.editor_state);
      expect(withoutIds(adapter.getJSON())).toEqual(original);
      adapter.setContent(markdownToProseMirrorDoc(model.content, { contentBlocks: model.content_blocks }));
      expect(withoutIds(adapter.getJSON())).toEqual(original);
      expect(element.querySelector('h2').textContent).toBe('Phase 1: Preparation\u00a0');
      expect(element.querySelector('ol').getAttribute('start')).toBe('10');
      expect(element.querySelector('strong').textContent).toBe('Deliverables:\u00a0');
    }
  } finally {
    adapter.destroy();
    element.remove();
  }
});

it('registers one link extension with Flight Deck link behavior', async () => {
  const { Editor } = await import('@tiptap/core');
  const { createFlightDeckTiptapExtensions } = await import('../src/docs/editor/prosemirror-flightdeck-schema.js');
  const editor = new Editor({ element: document.createElement('div'), extensions: createFlightDeckTiptapExtensions() });
  try {
    const links = editor.extensionManager.extensions.filter(extension => extension.name === 'link');
    expect(links).toHaveLength(1);
    expect(links[0].options).toMatchObject({ openOnClick: false, autolink: true, linkOnPaste: true });
    editor.commands.setContent('<p><a href="https://example.com">linked</a></p>');
    expect(editor.getJSON().content[0].content[0].marks).toContainEqual(expect.objectContaining({ type: 'link', attrs: expect.objectContaining({ href: 'https://example.com' }) }));
  } finally { editor.destroy(); }
});

it('changes native editability without reporting a content update, while real edits still update', () => {
  const element = document.createElement('div');
  document.body.append(element);
  const updates = [];
  const adapter = createTiptapEditorAdapter({ element, document: { content: 'Preserved draft' }, onUpdate: model => updates.push(model.content) });
  try {
    adapter.setEditable(false);
    adapter.setEditable(true);
    expect(updates).toEqual([]);
    expect(adapter.getContentModel().content).toBe('Preserved draft');
    adapter.editor.commands.insertContent('Edited ');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('Edited');
  } finally {
    adapter.destroy();
    element.remove();
  }
});

it('renders document references with the same navigation metadata as chat and task references', () => {
  const element = document.createElement('div'); document.body.append(element);
  const adapter = createTiptapEditorAdapter({ element, document: { content: '@[Target](mention:document:target-doc) and @[Thread](mention:message:target-message) plus [Plain](mention:doc:plain-doc)' } });
  try {
    const doc = element.querySelector('.mention-link[data-mention-id="target-doc"]');
    expect(doc).not.toBeNull();
    expect(doc.dataset.mentionType).toBe('document');
    expect(doc.getAttribute('role')).toBe('link');
    expect(doc.getAttribute('tabindex')).toBe('0');
    expect(element.querySelector('.mention-link[data-mention-id="target-message"]').dataset.mentionType).toBe('message');
    expect(element.querySelector('a.mention-link[data-mention-id="plain-doc"]').dataset.mentionType).toBe('doc');
    expect(adapter.getContentModel().content).toContain('[Plain](mention:doc:plain-doc)');
    expect(adapter.getContentModel().content).toContain('@[Target](mention:document:target-doc)');
  } finally { adapter.destroy(); element.remove(); }
});
