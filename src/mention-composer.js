import { createCanvasReferencePill, parseCanvasChatReference } from './canvas/chat-references.js';
const CANVAS_LINK_RE = /\[((?:\\.|[^\]\\])+)\]\((https?:\/\/[^\s)]+)\)/g;
const CANONICAL_MENTION_RE = /@\[([^\]]+)\]\(mention:(agent|person):([^)]+)\)/g;

function tokenFor(node) {
  return node?.nodeType === 1 && node.matches?.('[data-mention-token]')
    ? String(node.dataset.mentionToken || '')
    : '';
}

export function canonicalActorMentions(value = '') {
  const mentions = [];
  for (const match of String(value).matchAll(CANONICAL_MENTION_RE)) {
    mentions.push({ label: match[1], type: match[2], npub: match[3] });
  }
  return mentions;
}

export function createMentionPill(doc, mention) {
  const label = String(mention?.label || mention?.npub || '').trim();
  const type = String(mention?.type || 'person').trim();
  const npub = String(mention?.npub || mention?.id || '').trim();
  const canonical = `@[${label}](mention:${type}:${npub})`;
  const pill = doc.createElement('span');
  pill.className = `mention-composer-pill mention-composer-pill-${type}`;
  pill.contentEditable = 'false';
  pill.dataset.mentionToken = canonical;
  pill.dataset.mentionType = type;
  pill.dataset.mentionNpub = npub;
  pill.dataset.mentionLabel = label;
  pill.setAttribute('role', 'button');
  pill.setAttribute('tabindex', '-1');
  pill.setAttribute('aria-label', `Mention ${label}`);
  pill.textContent = `@${label}`;
  return pill;
}

export function serializeMentionComposerState(root) {
  const actorMentions = [];
  const serialize = (node) => {
    if (node.nodeType === 3) {
      const value = node.nodeValue || '';
      actorMentions.push(...canonicalActorMentions(value));
      return value;
    }
    const token = tokenFor(node);
    if (token) {
      const type = String(node.dataset?.mentionType || '').trim();
      const npub = String(node.dataset?.mentionNpub || '').trim();
      const label = String(node.dataset?.mentionLabel || '').trim();
      if (['agent', 'person'].includes(type) && npub) actorMentions.push({ label, type, npub });
      return token;
    }
    if (node.nodeType !== 1) return '';
    if (node.tagName === 'BR') return '\n';
    const value = [...node.childNodes].map(serialize).join('');
    return node !== root && node.tagName === 'DIV' ? `${value}\n` : value;
  };
  return {
    value: [...(root?.childNodes || [])].map(serialize).join('').replace(/\n$/, ''),
    actorMentions,
  };
}

export function serializeMentionComposer(root) {
  return serializeMentionComposerState(root).value;
}

export function hydrateMentionComposer(root, value = '') {
  if (!root?.ownerDocument) return;
  const doc = root.ownerDocument;
  const fragment = doc.createDocumentFragment();
  let cursor = 0;
  const matches = [
    ...[...String(value).matchAll(CANONICAL_MENTION_RE)].map(match => ({ match, actor: true })),
    ...[...String(value).matchAll(CANVAS_LINK_RE)].filter(match => parseCanvasChatReference(match[2])).map(match => ({ match, actor: false })),
  ].sort((a, b) => a.match.index - b.match.index);
  for (const { match, actor } of matches) {
    if (match.index < cursor) continue;
    if (match.index > cursor) fragment.append(doc.createTextNode(String(value).slice(cursor, match.index)));
    fragment.append(actor
      ? createMentionPill(doc, { label: match[1], type: match[2], npub: match[3] })
      : createCanvasReferencePill(doc, { label: match[1].replace(/\\(.)/g, '$1'), url: match[2], token: match[0] }));
    cursor = match.index + match[0].length;
  }
  if (cursor < String(value).length) fragment.append(doc.createTextNode(String(value).slice(cursor)));
  root.replaceChildren(fragment);
}

function textNodes(root) {
  const nodes = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

export function composerCaretOffset(root) {
  const selection = root?.ownerDocument?.getSelection?.();
  if (!selection?.rangeCount) return serializeMentionComposer(root).length;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.endContainer)) return serializeMentionComposer(root).length;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.endContainer, range.endOffset);
  const wrapper = root.ownerDocument.createElement('div');
  wrapper.append(before.cloneContents());
  return wrapper.textContent.length;
}

export function composerMentionQueryAtSelection(root) {
  const selection = root?.ownerDocument?.getSelection?.();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.endContainer)) return null;

  let prefixLength = 0;
  let trailingEditableText = '';
  const appendText = (value) => {
    trailingEditableText += value;
    const newlineIndex = Math.max(
      trailingEditableText.lastIndexOf('\n'),
      trailingEditableText.lastIndexOf('\r'),
    );
    if (newlineIndex >= 0) trailingEditableText = trailingEditableText.slice(newlineIndex + 1);
  };
  const visitBeforeCaret = (node) => {
    if (node === range.endContainer) {
      if (node.nodeType === 3) {
        const value = (node.nodeValue || '').slice(0, range.endOffset);
        prefixLength += value.length;
        appendText(value);
      } else {
        for (let index = 0; index < Math.min(range.endOffset, node.childNodes?.length || 0); index += 1) {
          visitWholeNode(node.childNodes[index]);
        }
      }
      return true;
    }
    if (node.nodeType === 3) {
      visitWholeNode(node);
      return false;
    }
    if (node.nodeType === 1 && (tokenFor(node) || node.tagName === 'BR')) {
      visitWholeNode(node);
      return false;
    }
    if (node.nodeType === 1 && node !== root && node.tagName === 'DIV') trailingEditableText = '';
    for (const child of (node.childNodes || [])) {
      if (visitBeforeCaret(child)) return true;
    }
    return false;
  };
  function visitWholeNode(node) {
    if (node.nodeType === 3) {
      const value = node.nodeValue || '';
      prefixLength += value.length;
      appendText(value);
      return;
    }
    if (node.nodeType !== 1) {
      for (const child of (node.childNodes || [])) visitWholeNode(child);
      return;
    }
    if (tokenFor(node) || node.tagName === 'BR') {
      prefixLength += node.textContent?.length || 0;
      trailingEditableText = '';
      return;
    }
    if (node.tagName === 'DIV') trailingEditableText = '';
    for (const child of node.childNodes) visitWholeNode(child);
  }
  if (!visitBeforeCaret(root)) return null;

  const atIndex = trailingEditableText.lastIndexOf('@');
  if (atIndex < 0 || (atIndex > 0 && !/\s/.test(trailingEditableText[atIndex - 1]))) return null;
  return {
    query: trailingEditableText.slice(atIndex + 1),
    start: prefixLength - (trailingEditableText.length - atIndex),
    end: prefixLength,
  };
}

function boundaryForOffset(root, offset) {
  let remaining = Math.max(0, offset);
  for (const node of textNodes(root)) {
    const length = node.nodeValue?.length || 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
  }
  return { node: root, offset: root.childNodes.length };
}

export function replaceComposerTextRange(root, start, end, replacement) {
  const doc = root.ownerDocument;
  const range = doc.createRange();
  const startBoundary = boundaryForOffset(root, start);
  const endBoundary = boundaryForOffset(root, end);
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  range.deleteContents();
  const nodes = Array.isArray(replacement) ? replacement : [replacement];
  let last = null;
  for (const node of nodes) {
    last = typeof node === 'string' ? doc.createTextNode(node) : node;
    range.insertNode(last);
    range.setStartAfter(last);
    range.collapse(true);
  }
  const selection = doc.getSelection?.();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function insertMentionAtComposerSelection(root, mention, trailingText = '') {
  if (!root?.ownerDocument) return false;
  const offset = composerCaretOffset(root);
  const value = serializeMentionComposer(root);
  const suffix = String(trailingText || '');
  const needsLeadingSpace = offset > 0 && !/\s/.test(value[offset - 1] || '');
  const needsMentionSpace = !suffix && (offset >= value.length || !/\s/.test(value[offset] || ''));
  const needsSuffixSpace = suffix && offset < value.length && !/\s/.test(value[offset] || '') && !/\s$/.test(suffix);
  const pill = createMentionPill(root.ownerDocument, mention);
  replaceComposerTextRange(root, offset, offset, [
    ...(needsLeadingSpace ? [' '] : []),
    pill,
    ...(suffix ? [suffix] : []),
    ...(needsMentionSpace || needsSuffixSpace ? [' '] : []),
  ]);
  root.focus();
  return true;
}

export function insertPlainTextAtSelection(root, text) {
  const doc = root?.ownerDocument;
  const selection = doc?.getSelection?.();
  if (!selection?.rangeCount) {
    root.append(doc.createTextNode(String(text || '')));
    return;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const node = doc.createTextNode(String(text || ''));
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function removeAdjacentMentionPill(root, direction = 'backward') {
  const selection = root?.ownerDocument?.getSelection?.();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  let candidate = null;
  if (range.startContainer === root) {
    const index = range.startOffset + (direction === 'backward' ? -1 : 0);
    candidate = root.childNodes[index];
  } else if (range.startContainer.nodeType === 3) {
    const atEdge = direction === 'backward'
      ? range.startOffset === 0
      : range.startOffset === (range.startContainer.nodeValue?.length || 0);
    if (atEdge) candidate = direction === 'backward'
      ? range.startContainer.previousSibling
      : range.startContainer.nextSibling;
  }
  if (!tokenFor(candidate)) return false;
  const nextRange = root.ownerDocument.createRange();
  nextRange.setStartBefore(candidate);
  nextRange.collapse(true);
  candidate.remove();
  selection.removeAllRanges();
  selection.addRange(nextRange);
  return true;
}
