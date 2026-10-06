// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createTiptapEditorAdapter } from '../src/docs/editor/tiptap-editor-adapter.js';
import { visibleWikiIntegrityText } from '../src/docs/editor/wiki-visible-text.js';

it('preserves multiline rendered separators and normalizes only the link, even when prose repeats the live title', () => {
  const editor = document.createElement('div');
  editor.innerHTML = '<p>Repeated live title</p><p><span data-wiki-title="Saved">Repeated live title</span></p><p>Third paragraph<br>Tail</p>';
  Object.defineProperty(editor, 'innerText', { value: 'Repeated live title\n\nRepeated live title\n\nThird paragraph\nTail' });
  expect(visibleWikiIntegrityText(editor)).toBe('Repeated live title\n\nSaved\n\nThird paragraph\nTail');
  expect(editor.textContent).toBe('Repeated live titleRepeated live titleThird paragraphTail');
});
it('preserves an entire long multiline draft across several dynamic wiki labels', () => {
  const editor = document.createElement('div');
  const paragraphs = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with full prose and punctuation.`);
  for (const text of paragraphs) { const p = document.createElement('p'); p.textContent = text; editor.append(p); }
  const link = document.createElement('span'); link.dataset.wikiTitle = 'Original'; link.textContent = 'Long renamed title'; editor.children[200].append(' ', link);
  const rendered = paragraphs.map((text, i) => i === 200 ? `${text} Long renamed title` : text).join('\n\n');
  Object.defineProperty(editor, 'innerText', { value: rendered });
  expect(visibleWikiIntegrityText(editor)).toBe(rendered.replace('Long renamed title', 'Original'));
  expect(visibleWikiIntegrityText(editor).split('\n\n')).toHaveLength(400);
});

it('activates a stored wiki ID on first click even when its target is absent from rendered pages', () => {
  const element = document.createElement('div'); document.body.append(element);
  const open = vi.fn(), error = vi.fn();
  const adapter = createTiptapEditorAdapter({ element, document: { content: '[Saved page](wiki:missing-rendered)' },
    wiki: { resolve: () => ({ state: 'unavailable', title: 'Saved page' }), open, error, create: vi.fn(), pages: () => [], isEditing: () => false, isBusy: () => false } });
  try {
    element.querySelector('[data-wiki-id="missing-rendered"]').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(open).toHaveBeenCalledWith('missing-rendered');
    expect(error).not.toHaveBeenCalled();
  } finally { adapter.destroy(); element.remove(); }
});
