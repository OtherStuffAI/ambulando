// @vitest-environment jsdom
import { expect, it } from 'vitest';
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
