// Bounded paging for large text so no view ever holds the full content in one
// DOM node. Pages are exact slices (join('') === original); a page only
// changes bytes when the user edits it, and then keeps its line-ending style.
export const TEXT_PAGE_CHARS = 16000;

function safeCut(text, start, end) {
  if (end >= text.length) return text.length;
  // Prefer the last line break inside the window, but not so early that
  // pages become tiny; never split a surrogate pair or a CRLF.
  const floor = start + Math.floor((end - start) * 0.5);
  let cut = -1;
  for (let index = end - 1; index >= floor; index -= 1) {
    const code = text.charCodeAt(index);
    if (code === 10) { cut = index + 1; break; }
  }
  if (cut === -1) cut = end;
  const prev = text.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  if (text.charCodeAt(cut - 1) === 13 && text.charCodeAt(cut) === 10) cut -= 1;
  return cut > start ? cut : end;
}

export function paginateText(text = '', pageChars = TEXT_PAGE_CHARS) {
  const value = String(text ?? '');
  if (!value) return [''];
  const pages = [];
  let start = 0;
  while (start < value.length) {
    const cut = safeCut(value, start, Math.min(value.length, start + pageChars));
    pages.push(value.slice(start, cut));
    start = cut;
  }
  return pages;
}

// Textareas report newlines as LF. A page keeps its original style on edit
// only when it was consistently CRLF; mixed or LF pages are saved as LF.
export function pageEolStyle(page = '') {
  const crlf = (page.match(/\r\n/g) || []).length;
  if (!crlf) return 'lf';
  const bareLf = (page.match(/\n/g) || []).length - crlf;
  const bareCr = (page.match(/\r(?!\n)/g) || []).length;
  return bareLf === 0 && bareCr === 0 ? 'crlf' : 'mixed';
}

export function normalizeForTextarea(page = '') {
  return page.replace(/\r\n?/g, '\n');
}

// Value to store for a page after the textarea reports `edited`.
export function applyPageEdit(original = '', edited = '') {
  if (normalizeForTextarea(original) === edited) return original;
  return pageEolStyle(original) === 'crlf' ? edited.replace(/\n/g, '\r\n') : edited;
}

export function lineNumberOffsets(pages) {
  let total = 0;
  return pages.map((page) => {
    const start = total;
    total += (page.match(/\r\n|\r|\n/g) || []).length;
    return start;
  });
}
