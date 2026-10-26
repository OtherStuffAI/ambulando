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
    [composer]: [...(store.textPasteUndo?.[composer] || []), { draft_id: draft.draft_id, signature: current }],
  };
  return true;
}

// Undo removes the paste itself; the untouched composer and selection stay put.
export function undoTextPasteConversion(store, event, composer) {
  if (!TEXT_COMPOSERS.has(composer)) return false;
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || String(event.key).toLowerCase() !== 'z') return false;
  const entries = store.textPasteUndo?.[composer] || [];
  const entry = entries.at(-1);
  if (!entry) return false;
  if (serializeMentionComposer(event.currentTarget) !== entry.signature) {
    forgetTextPasteUndo(store, composer);
    return false;
  }
  store.textPasteUndo = { ...store.textPasteUndo, [composer]: entries.slice(0, -1) };
  if (!store.getChatFileDrafts(composer).some((item) => item.draft_id === entry.draft_id)) return false;
  event.preventDefault();
  store.removeChatFileDraft(entry.draft_id, composer);
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
