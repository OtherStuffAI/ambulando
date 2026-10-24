import { FlightDeckWikiLink, createWikiPicker } from './wiki-extension.js';
import { Editor } from '@tiptap/core';
import { DOMParser, Fragment } from '@tiptap/pm/model';
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
    extensions: extensions || createFlightDeckTiptapExtensions({ placeholder, editable }).map((extension) => extension.name === 'fdWikiLink' && wiki ? FlightDeckWikiLink.configure(wiki) : extension).concat(wiki ? [createWikiPicker(wiki)] : []),
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
      // Save can run in the same turn as native beforeinput/DOM mutations.
      editor.view.domObserver.flush();
      return prosemirrorToFlightDeckContentModel(editor.getJSON());
    },
    getVisibleContentModel() {
      // Recovery only: retain lists, marks and code instead of Markdown-parsing
      // rendered plain text. Never use this to bypass the save integrity guard.
      const surface = editor.view.dom.cloneNode(true);
      surface.querySelectorAll('.ProseMirror-trailingBreak, .ProseMirror-separator').forEach(node => node.remove());
      for (const item of surface.querySelectorAll('li[data-checked]')) {
        // Task NodeViews omit the schema's identifying data-type attribute.
        item.dataset.type = 'taskItem';
        item.querySelector(':scope > label')?.remove();
      }
      for (const link of surface.querySelectorAll('[data-wiki-title]')) {
        // NodeView title is a live tooltip, not the saved fallback label.
        link.setAttribute('title', link.dataset.wikiTitle);
        link.textContent = link.dataset.wikiTitle;
      }
      for (const image of surface.querySelectorAll('img[data-fd-storage-object-id]')) {
        // Hydration changes src for presentation; recover the storage identity.
        image.setAttribute('src', `storage://${image.dataset.fdStorageObjectId}`);
      }
      return prosemirrorToFlightDeckContentModel(DOMParser.fromSchema(editor.schema)
        .parse(surface, { preserveWhitespace: 'full' }).toJSON());
    },
    appendReadOnlyContent(nodes) {
      if (editor.isEditable) throw new Error('Progressive content is only available to readers.');
      // Append at the document end; existing selections and block identities map
      // through the transaction and no editable draft/update callback is made.
      const fragment = Fragment.fromArray(nodes.map(node => editor.schema.nodeFromJSON(node)));
      editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, fragment)
        .setMeta('preventUpdate', true).setMeta('addToHistory', false));
    },
    setEditable(nextEditable) {
      // Access changes do not modify content or create a new recovery draft.
      editor.setEditable(Boolean(nextEditable), false);
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
