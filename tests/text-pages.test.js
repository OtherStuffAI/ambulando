import { describe, expect, it } from 'vitest';
import { applyPageEdit, normalizeForTextarea, paginateText, pageEolStyle, TEXT_PAGE_CHARS } from '../src/text-pages.js';

describe('text paging', () => {
  it('round-trips a 3.94MB multi-line log exactly in bounded pages', () => {
    const line = '2026-10-26T10:00:00Z INFO worker-7 processed batch 12345 ok\r\n';
    const log = line.repeat(Math.ceil(3_940_000 / line.length));
    const pages = paginateText(log);
    expect(pages.join('')).toBe(log);
    expect(Math.max(...pages.map((page) => page.length))).toBeLessThanOrEqual(TEXT_PAGE_CHARS);
    expect(pages.every((page) => !page.startsWith('\n'))).toBe(true);
  });

  it('splits a pathological single line without splitting surrogate pairs', () => {
    const text = '😀'.repeat(200_000) + 'x';
    const pages = paginateText(text);
    expect(pages.join('')).toBe(text);
    for (const page of pages) {
      const first = page.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      const last = page.charCodeAt(page.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(pages.length).toBeGreaterThan(10);
  });

  it('never separates CRLF across pages', () => {
    const text = `${'a'.repeat(TEXT_PAGE_CHARS - 1)}\r\n${'b'.repeat(100)}`;
    const pages = paginateText(text);
    expect(pages.join('')).toBe(text);
    expect(pages[0].endsWith('\r')).toBe(false);
  });

  it('handles empty text and keeps unedited pages byte-exact', () => {
    expect(paginateText('')).toEqual(['']);
    const page = 'a\r\nb\r\n';
    expect(applyPageEdit(page, normalizeForTextarea(page))).toBe(page);
  });

  it('restores CRLF only for consistently-CRLF pages that were edited', () => {
    expect(pageEolStyle('a\r\nb')).toBe('crlf');
    expect(pageEolStyle('a\nb')).toBe('lf');
    expect(pageEolStyle('a\r\nb\nc')).toBe('mixed');
    expect(applyPageEdit('a\r\nb', 'a\nbX')).toBe('a\r\nbX');
    expect(applyPageEdit('a\nb', 'a\nbX')).toBe('a\nbX');
    expect(applyPageEdit('a\r\nb\nc', 'a\nb\ncX')).toBe('a\nb\ncX');
  });
});
