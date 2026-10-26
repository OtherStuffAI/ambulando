// Composer glue for automatic text attachments: paste conversion, undo, the
// typing cap and the near-limit counter. Pure rules live in text-attachments.js.
import { insertPlainTextAtSelection, serializeMentionComposer } from './mention-composer.js';
import {
  TEXT_ATTACHMENT_INLINE_LIMIT,
  clampToInlineLimit,
  codePointLength,
  inlineCounterState,
  nextPastedTextName,
  shouldConvertPasteToAttachment,
  textToAttachmentFile,
} from './text-attachments.js';

const TEXT_COMPOSERS = new Set(['message', 'thread']);

function selectedLength(el) {
  const selection = el?.ownerDocument?.getSelection?.();
  if (!selection?.rangeCount || selection.isCollapsed) return 0;
  return el.contains(selection.getRangeAt(0).commonAncestorContainer) ? codePointLength(selection.toString()) : 0;
}

export function updateComposerCounter(store, composer, value) {
  if (!TEXT_COMPOSERS.has(composer)) return;
  const next = inlineCounterState(value);
  const previous = store.composerCounter?.[composer];
  if (previous && previous.used === next.used && previous.near === next.near && previous.over === next.over) return;
  store.composerCounter = { ...(store.composerCounter || {}), [composer]: next };
}

// Returns true when the paste was turned into an attachment and consumed.
export function convertPasteToTextAttachment(store, event, composer) {
  if (!TEXT_COMPOSERS.has(composer)) return false;
  const el = event.currentTarget;
  const pasted = event.clipboardData?.getData('text/plain') || '';
  if (!pasted) return false;
  const current = serializeMentionComposer(el);
  if (!shouldConvertPasteToAttachment({
    pasted,
    inlineLength: codePointLength(current),
    selectedLength: selectedLength(el),
  })) return false;
  event.preventDefault();
  const existing = store.getChatFileDrafts(composer).map((draft) => draft.filename);
  const file = textToAttachmentFile(pasted, nextPastedTextName(existing));
  const draft = store.addChatFileDraft(file, composer, { textAttachment: { source: 'paste', text: pasted } });
  // The composer text and selection are untouched; remember how to undo.
  store.textPasteUndo = {
    ...(store.textPasteUndo || {}),
    [composer]: { draft_id: draft.draft_id, text: pasted, signature: current },
  };
  return true;
}

// Ctrl/Cmd+Z straight after a conversion restores the text and drops the file.
export function undoTextPasteConversion(store, event, composer) {
  if (!TEXT_COMPOSERS.has(composer)) return false;
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || String(event.key).toLowerCase() !== 'z') return false;
  const entry = store.textPasteUndo?.[composer];
  const el = event.currentTarget;
  if (!entry || serializeMentionComposer(el) !== entry.signature) return false;
  const draft = store.getChatFileDrafts(composer).find((item) => item.draft_id === entry.draft_id);
  store.textPasteUndo = { ...store.textPasteUndo, [composer]: null };
  if (!draft) return false;
  const projected = codePointLength(entry.signature) - selectedLength(el) + codePointLength(entry.text);
  if (projected > TEXT_ATTACHMENT_INLINE_LIMIT) {
    store.error = 'Pasted text is too long to restore inline. Keep it as an attachment.';
    return false;
  }
  event.preventDefault();
  store.removeChatFileDraft(entry.draft_id, composer);
  insertPlainTextAtSelection(el, entry.text);
  store.syncMentionComposerModel(el);
  return true;
}

export function forgetTextPasteUndo(store, composer) {
  if (store.textPasteUndo?.[composer]) store.textPasteUndo = { ...store.textPasteUndo, [composer]: null };
}

// Block typing past the cap. Composition (IME) is never interrupted: the
// counter and the send guard cover it instead of dropping composed text.
export function guardInlineTyping(event, composer) {
  if (!TEXT_COMPOSERS.has(composer) || event.isComposing) return false;
  const type = String(event.inputType || '');
  if (!type.startsWith('insert') || type === 'insertCompositionText') return false;
  const el = event.currentTarget;
  const data = type === 'insertLineBreak' || type === 'insertParagraph' ? '\n' : (event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
  if (!data) return false;
  const total = codePointLength(serializeMentionComposer(el)) - selectedLength(el);
  const room = TEXT_ATTACHMENT_INLINE_LIMIT - total;
  if (codePointLength(data) <= room) return false;
  event.preventDefault();
  if (room > 0 && type !== 'insertLineBreak' && type !== 'insertParagraph') {
    insertPlainTextAtSelection(el, clampToInlineLimit(data, room).text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}
