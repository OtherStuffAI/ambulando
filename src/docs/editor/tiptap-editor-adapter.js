import { FlightDeckWikiLink, createWikiPicker } from './wiki-extension.js';
import { Editor } from '@tiptap/core';
import { createFlightDeckTiptapExtensions } from './prosemirror-flightdeck-schema.js';
import { resolveDocumentProseMirrorState } from './markdown-to-prosemirror.js';
import { prosemirrorToFlightDeckContentModel } from './prosemirror-to-flightdeck.js';

export function createTiptapEditorAdapter({
  element,
  document,
  editorState,
  editable = true,
  onEditIntent = () => {},
  onUpdate = () => {},
  onPaste = () => false,
  onKeydown = () => false,
  extensions,
  wiki,
  placeholder = 'Start writing...',
} = {}) {
  if (!element) throw new Error('Tiptap editor adapter requires a mount element.');
  const editor = new Editor({
    element,
    editable,
    extensions: extensions || createFlightDeckTiptapExtensions({ placeholder }).map((extension) => extension.name === 'fdWikiLink' && wiki ? FlightDeckWikiLink.configure(wiki) : extension).concat(wiki ? [createWikiPicker(wiki)] : []),
    content: editorState || resolveDocumentProseMirrorState(document || {}),
    editorProps: {
      handlePaste: (_view, event) => onPaste(event, editor) === true,
      handleDOMEvents: {
        beforeinput: () => {
          onEditIntent('input');
          return false;
        },
        pointerdown: (_view, event) => {
          if (event.target.closest?.('[data-wiki-title]')) return false;
          onEditIntent('pointer');
          return false;
        },
        focus: () => {
          onEditIntent('focus');
          return false;
        },
        keydown: (_view, event) => {
          onEditIntent('keyboard');
          return onKeydown(event, editor) === true;
        },
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      onUpdate(prosemirrorToFlightDeckContentModel(activeEditor.getJSON()), activeEditor);
    },
  });

  return {
    editor,
    refreshWikiLinks() {
      editor.view.dispatch(editor.state.tr.setMeta('wikiRefresh', true));
    },
    getJSON() {
      return editor.getJSON();
    },
    getContentModel() {
      return prosemirrorToFlightDeckContentModel(editor.getJSON());
    },
    setEditable(nextEditable) {
      editor.setEditable(Boolean(nextEditable));
    },
    setContent(editorState, { emitUpdate = false, preserveSelection = false } = {}) {
      const selection = preserveSelection
        ? { from: editor.state.selection.from, to: editor.state.selection.to }
        : null;
      editor.commands.setContent(editorState || { type: 'doc', content: [] }, { emitUpdate });
      if (selection) {
        const maxPosition = Math.max(1, editor.state.doc.content.size);
        editor.commands.setTextSelection({
          from: Math.min(Math.max(1, selection.from), maxPosition),
          to: Math.min(Math.max(1, selection.to), maxPosition),
        });
      }
    },
    destroy() {
      editor.destroy();
    },
  };
}
