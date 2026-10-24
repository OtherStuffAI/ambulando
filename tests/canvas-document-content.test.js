// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createTiptapEditorAdapter } from '../src/docs/editor/tiptap-editor-adapter.js';
import { markdownToProseMirrorDoc } from '../src/docs/editor/markdown-to-prosemirror.js';

it('progressive readers preserve complete rich content, block identities and selection without editable updates', () => {
  const markdown = Array.from({ length: 12 }, (_, i) => `## Heading ${i}\n\n**Bold** and [link](https://example.com).\n\n- One\n- Two\n\n| A | B |\n| --- | --- |\n| C | D |\n\n\`\`\`js\nconst n = ${i};\n\`\`\`\n\n`).join('');
  const state = markdownToProseMirrorDoc(markdown);
  const fullMount = document.createElement('div'), partialMount = document.createElement('div');
  document.body.append(fullMount, partialMount);
  const onUpdate = vi.fn();
  const reference = createTiptapEditorAdapter({ element: fullMount, editable: false, editorState: state });
  const reader = createTiptapEditorAdapter({ element: partialMount, editable: false, editorState: { ...state, content: state.content.slice(0, 16) }, onUpdate });
  reader.editor.commands.setTextSelection({ from: 2, to: 6 });
  for (let i = 16; i < state.content.length; i += 16) reader.appendReadOnlyContent(state.content.slice(i, i + 16));
  expect(reader.getJSON()).toEqual(reference.getJSON());
  expect(reader.editor.state.selection).toMatchObject({ from: 2, to: 6 });
  expect(onUpdate).not.toHaveBeenCalled();
  expect(reader.editor.extensionManager.extensions.map(extension => extension.name)).not.toContain('placeholder');
  reader.destroy(); reference.destroy();
});

it('does not offer progressive mutation on an editable composer/editor', () => {
  const element = document.createElement('div'); document.body.append(element);
  const editor = createTiptapEditorAdapter({ element, editable: true, editorState: markdownToProseMirrorDoc('Editable') });
  expect(() => editor.appendReadOnlyContent([{ type: 'paragraph' }])).toThrow('only available to readers');
  expect(editor.editor.extensionManager.extensions.map(extension => extension.name)).toContain('placeholder');
  editor.destroy();
});
