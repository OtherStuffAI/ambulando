// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createTaskDescriptionEditor } from '../src/task-description-editor.js';

const description = '# Outcome\n\nReadable **brief** with [guide](https://example.com/guide), @[Task](mention:task:dependency), @[Reviewer](mention:person:npub1fixture) and [Document](mention:doc:document).\n\n- Preserve rich formatting\n- Keep references\n\n## Acceptance\n\nFinal paragraph.';

describe('task description Tiptap Markdown', () => {
  it('renders headings, lists, ordinary links and routed canonical references across Markdown reopens', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const adapter = createTaskDescriptionEditor({ element, description });
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        expect(element.querySelector('h1').textContent).toBe('Outcome');
        expect(element.querySelector('h2').textContent).toBe('Acceptance');
        expect(element.querySelectorAll('li')).toHaveLength(2);
        expect(element.querySelector('a[href="https://example.com/guide"]').textContent).toBe('guide');
        expect(element.querySelector('a[data-mention-type="task"]').dataset.mentionId).toBe('dependency');
        expect(element.querySelector('a[data-mention-type="person"]').textContent).toBe('Reviewer');
        expect(element.querySelector('a[data-mention-type="doc"]').dataset.mentionId).toBe('document');
        const saved = adapter.getContentModel().content;
        expect(saved).toContain('@[Task](mention:task:dependency)');
        expect(saved).toContain('[Document](mention:doc:document)');
        adapter.setDescription(saved);
      }
    } finally { adapter.destroy(); element.remove(); }
  });

  it('serializes formatting edits without writing on mount or external model synchronization', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const updates = [];
    const adapter = createTaskDescriptionEditor({ element, description, onUpdate: model => updates.push(model.content) });
    try {
      expect(updates).toHaveLength(0);
      adapter.editor.commands.setTextSelection(2);
      adapter.editor.commands.insertContent('Revised ');
      expect(updates.at(-1)).toContain('Revised');
      adapter.setDescription(updates.at(-1));
      expect(element.querySelector('h1').textContent).toContain('Revised');
      expect(updates).toHaveLength(1);
      adapter.setDescription('## Remote correction\n\n[Retained link](https://example.com)');
      expect(element.querySelector('h2').textContent).toBe('Remote correction');
      expect(updates).toHaveLength(1);
    } finally { adapter.destroy(); element.remove(); }
  });
});

it('parses plain Markdown paste while retaining native rich HTML paste', () => {
  const element = document.createElement('div');
  document.body.append(element);
  const adapter = createTaskDescriptionEditor({ element, description: 'Start here.' });
  const event = { preventDefault: () => {}, clipboardData: { getData: type => type === 'text/plain' ? '## Pasted heading\n\n- Pasted list\n\n@[Dependency](mention:task:dependency)' : '' } };
  try {
    adapter.editor.view.someProp('handlePaste', fn => fn(adapter.editor.view, event));
    expect(element.querySelector('h2').textContent).toBe('Pasted heading');
    expect(element.querySelector('li').textContent).toBe('Pasted list');
    expect(element.querySelector('a[data-mention-id="dependency"]')).not.toBeNull();
    expect(adapter.getContentModel().content).toContain('@[Dependency](mention:task:dependency)');
  } finally { adapter.destroy(); element.remove(); }
});
