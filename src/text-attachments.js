// Automatic text attachments: pure rules shared by the composer, the editor
// modal and tests. Lengths are Unicode code points; bytes are exact UTF-8.
export const TEXT_ATTACHMENT_PASTE_LIMIT = 2500;
export const TEXT_ATTACHMENT_INLINE_LIMIT = 10000;
export const TEXT_ATTACHMENT_INLINE_BYTE_LIMIT = 40000;
export const TEXT_ATTACHMENT_CONTENT_TYPE = 'text/plain; charset=utf-8';
export const TEXT_ATTACHMENT_BASE_NAME = 'Pasted text';
export const TEXT_ATTACHMENT_VERSION = 1;

const encoder = new TextEncoder();

export function codePointLength(text = '') {
  const value = String(text ?? '');
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

export function utf8ByteLength(text = '') {
  return encoder.encode(String(text ?? '')).byteLength;
}

export function lineCount(text = '') {
  const value = String(text ?? '');
  if (!value) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10) lines += 1;
    else if (code === 13) {
      if (value.charCodeAt(index + 1) === 10) index += 1;
      lines += 1;
    }
  }
  return lines;
}

// Whether a paste becomes a .txt attachment. `inlineLength` is the composer's
// current code-point count and `selectedLength` the part the paste replaces.
export function shouldConvertPasteToAttachment({ pasted = '', inlineLength = 0, selectedLength = 0 } = {}) {
  const pastedLength = codePointLength(pasted);
  if (pastedLength === 0) return false;
  if (pastedLength > TEXT_ATTACHMENT_PASTE_LIMIT) return true;
  return Math.max(0, inlineLength - selectedLength) + pastedLength > TEXT_ATTACHMENT_INLINE_LIMIT;
}

// Next free "Pasted text.txt", "Pasted text 2.txt", … among current names.
export function nextPastedTextName(existingNames = []) {
  const taken = new Set((existingNames || []).map((name) => String(name || '').toLowerCase()));
  let counter = 1;
  for (;;) {
    const name = counter === 1 ? `${TEXT_ATTACHMENT_BASE_NAME}.txt` : `${TEXT_ATTACHMENT_BASE_NAME} ${counter}.txt`;
    if (!taken.has(name.toLowerCase())) return name;
    counter += 1;
  }
}

export function normalizeTextAttachmentName(name = '', fallback = `${TEXT_ATTACHMENT_BASE_NAME}.txt`) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Filename sanitation intentionally removes ASCII control characters.
  const cleaned = String(name ?? '').replace(/[\u0000-\u001f\u007f/\\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return /\.[A-Za-z0-9]{1,8}$/.test(cleaned) ? cleaned : `${cleaned}.txt`;
}

// Blob/File from a string encodes UTF-8 verbatim: no BOM, CRLF preserved.
export function textToAttachmentFile(text, filename) {
  const name = normalizeTextAttachmentName(filename);
  const FileCtor = globalThis.File;
  const parts = [String(text ?? '')];
  const options = { type: TEXT_ATTACHMENT_CONTENT_TYPE };
  return typeof FileCtor === 'function' ? new FileCtor(parts, name, options) : Object.assign(new Blob(parts, options), { name });
}

export function textAttachmentMarker({ source = 'paste', text = '' } = {}) {
  return { v: TEXT_ATTACHMENT_VERSION, source, chars: codePointLength(text), lines: lineCount(text) };
}

export function isTextAttachment(attachment = {}) {
  if (attachment?.text_attachment?.v === TEXT_ATTACHMENT_VERSION) return true;
  const type = String(attachment?.content_type || '').toLowerCase();
  return attachment?.kind === 'file' && type.startsWith('text/plain');
}

// First non-empty line, bounded in code points, for compact cards.
export function firstLinePreview(text = '', maxChars = 120) {
  const value = String(text ?? '');
  const head = value.length > 4096 ? value.slice(0, 4096) : value;
  const line = head.split(/\r\n|\r|\n/).find((candidate) => candidate.trim()) || '';
  const points = Array.from(line.trim());
  return points.length > maxChars ? `${points.slice(0, maxChars).join('')}…` : points.join('');
}

export function formatByteSize(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// Truncate typed/inserted text to the inline cap without splitting a
// surrogate pair. Returns { text, truncated }.
export function clampToInlineLimit(text = '', limit = TEXT_ATTACHMENT_INLINE_LIMIT) {
  const points = Array.from(String(text ?? ''));
  if (points.length <= limit) return { text: String(text ?? ''), truncated: false };
  return { text: points.slice(0, limit).join(''), truncated: true };
}

export function inlineCounterState(text = '') {
  const used = codePointLength(text);
  const bytes = utf8ByteLength(text);
  return {
    used,
    bytes,
    limit: TEXT_ATTACHMENT_INLINE_LIMIT,
    near: used >= TEXT_ATTACHMENT_INLINE_LIMIT * 0.9,
    over: used > TEXT_ATTACHMENT_INLINE_LIMIT || bytes > TEXT_ATTACHMENT_INLINE_BYTE_LIMIT,
  };
}

// Attachment object for message metadata. Additive marker only; no content.
export function buildTextAttachmentRecord({ storageObjectId, filename, text, sizeBytes, sha256Hex, source = 'paste' }) {
  return {
    kind: 'file',
    storage_object_id: storageObjectId,
    filename: normalizeTextAttachmentName(filename),
    content_type: TEXT_ATTACHMENT_CONTENT_TYPE,
    size_bytes: sizeBytes ?? utf8ByteLength(text),
    ...(sha256Hex ? { sha256_hex: sha256Hex } : {}),
    text_attachment: textAttachmentMarker({ source, text }),
  };
}
