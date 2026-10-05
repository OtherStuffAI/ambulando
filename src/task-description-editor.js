import { mergeAttributes } from '@tiptap/core';
import { createTiptapEditorAdapter } from './docs/editor/tiptap-editor-adapter.js';
import { createFlightDeckTiptapExtensions } from './docs/editor/prosemirror-flightdeck-schema.js';
import { markdownToProseMirrorDoc } from './docs/editor/markdown-to-prosemirror.js';

function referenceAttributes(type, id) {
  return {
    href: '#',
    class: 'mention-link',
    'data-mention-type': type,
    'data-mention-id': id,
  };
}

// Task-specific presentation keeps the shared document schema and Markdown
// serialization intact while using Flight Deck's existing reference routing.
export function createTaskDescriptionEditor({ description = '', ...options } = {}) {
  const extensions = createFlightDeckTiptapExtensions({ placeholder: 'Add a description...' }).map(extension => {
    if (extension.name === 'fdMention') return extension.extend({
      renderHTML({ HTMLAttributes }) {
        return ['a', mergeAttributes(HTMLAttributes, referenceAttributes(
          HTMLAttributes.mentionType, HTMLAttributes.mentionId,
        )), 0];
      },
    });
    if (extension.name === 'link') return extension.configure({
      isAllowedUri: (url, context) => /^mention:[a-z]+:[^\s]+$/i.test(url) || context.defaultValidate(url),
    }).extend({
      renderHTML({ HTMLAttributes }) {
        const reference = String(HTMLAttributes.href || '').match(/^mention:([^:]+):(.+)$/);
        if (!reference) return this.parent({ HTMLAttributes });
        return ['a', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes,
          referenceAttributes(reference[1], reference[2])), 0];
      },
    });
    return extension;
  });
  const adapter = createTiptapEditorAdapter({
    ...options,
    document: { content: description },
    extensions,
    onPaste: (event, editor) => {
      if (options.onPaste?.(event, editor) === true) return true;
      // Keep native rich HTML paste; plain Markdown uses the same parser as
      // initial load so headings, lists and reference links remain formatted.
      if (event.clipboardData?.getData('text/html')) return false;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return false;
      event.preventDefault();
      editor.commands.insertContent(markdownToProseMirrorDoc(text).content);
      return true;
    },
  });
  return {
    ...adapter,
    // Native editor instances must not pass through Alpine's deep proxy.
    getEditor() {
      return adapter.editor;
    },
    setDescription(value) {
      adapter.setContent(markdownToProseMirrorDoc(value), { preserveSelection: true });
    },
  };
}
