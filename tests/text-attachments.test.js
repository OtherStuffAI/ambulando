import { describe, expect, it } from 'vitest';
import {
  buildTextAttachmentRecord,
  clampToInlineLimit,
  codePointLength,
  firstLinePreview,
  inlineCounterState,
  lineCount,
  nextPastedTextName,
  normalizeTextAttachmentName,
  shouldConvertPasteToAttachment,
  textToAttachmentFile,
  utf8ByteLength,
} from '../src/text-attachments.js';

describe('text attachment rules', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('a😀b')).toBe(3);
    expect(codePointLength('😀'.repeat(2500))).toBe(2500);
  });

  it('converts at exactly 2501 code points but not 2500', () => {
    expect(shouldConvertPasteToAttachment({ pasted: 'x'.repeat(2500) })).toBe(false);
    expect(shouldConvertPasteToAttachment({ pasted: 'x'.repeat(2501) })).toBe(true);
    expect(shouldConvertPasteToAttachment({ pasted: '😀'.repeat(2500) })).toBe(false);
    expect(shouldConvertPasteToAttachment({ pasted: '😀'.repeat(2501) })).toBe(true);
  });

  it('converts when the inline total would pass 10000, accounting for the replaced selection', () => {
    expect(shouldConvertPasteToAttachment({ pasted: 'x'.repeat(100), inlineLength: 9900 })).toBe(false);
    expect(shouldConvertPasteToAttachment({ pasted: 'x'.repeat(101), inlineLength: 9900 })).toBe(true);
    expect(shouldConvertPasteToAttachment({ pasted: 'x'.repeat(500), inlineLength: 9900, selectedLength: 400 })).toBe(false);
    expect(shouldConvertPasteToAttachment({ pasted: '' })).toBe(false);
  });

  it('numbers repeated pasted files', () => {
    expect(nextPastedTextName([])).toBe('Pasted text.txt');
    expect(nextPastedTextName(['Pasted text.txt'])).toBe('Pasted text 2.txt');
    expect(nextPastedTextName(['Pasted text.txt', 'pasted text 2.txt'])).toBe('Pasted text 3.txt');
    expect(nextPastedTextName(['Pasted text 2.txt'])).toBe('Pasted text.txt');
  });

  it('sanitizes editable filenames', () => {
    expect(normalizeTextAttachmentName('  notes ')).toBe('notes.txt');
    expect(normalizeTextAttachmentName('a/b\\c.log')).toBe('a b c.log');
    expect(normalizeTextAttachmentName('   ')).toBe('Pasted text.txt');
    expect(normalizeTextAttachmentName('..')).toBe('Pasted text.txt');
  });

  it('keeps exact UTF-8 bytes and CRLF in the file', async () => {
    const text = 'héllo\r\nwörld 😀\r\n\u0000tail';
    const file = textToAttachmentFile(text, 'x.txt');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(text)));
    expect(file.type.replace(/\s/g, '')).toBe('text/plain;charset=utf-8');
    expect(bytes.byteLength).toBe(utf8ByteLength(text));
    expect(bytes[0]).not.toBe(0xef);
  });

  it('counts lines across CRLF, CR and LF', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\r\nb\nc\rd')).toBe(4);
  });

  it('bounds the first-line preview without splitting code points', () => {
    expect(firstLinePreview('\n\n  hello  \nworld')).toBe('hello');
    const preview = firstLinePreview('😀'.repeat(500), 10);
    expect(Array.from(preview)).toHaveLength(11);
    expect(firstLinePreview('x'.repeat(4_000_000), 5)).toBe('xxxxx…');
  });

  it('clamps typed text to the inline cap on a code point boundary', () => {
    const result = clampToInlineLimit('😀'.repeat(10001));
    expect(result.truncated).toBe(true);
    expect(codePointLength(result.text)).toBe(10000);
    expect(clampToInlineLimit('abc').truncated).toBe(false);
  });

  it('reports counter and byte guard state', () => {
    expect(inlineCounterState('x'.repeat(8999)).near).toBe(false);
    expect(inlineCounterState('x'.repeat(9000)).near).toBe(true);
    expect(inlineCounterState('x'.repeat(10001)).over).toBe(true);
    expect(inlineCounterState('😀'.repeat(10000)).over).toBe(false);
    expect(inlineCounterState('€'.repeat(10000)).bytes).toBe(30000);
  });

  it('builds an additive attachment record with no content', () => {
    const record = buildTextAttachmentRecord({ storageObjectId: 'o1', filename: 'Pasted text', text: 'a\r\nb', sha256Hex: 'ab' });
    expect(record).toEqual({
      kind: 'file',
      storage_object_id: 'o1',
      filename: 'Pasted text.txt',
      content_type: 'text/plain; charset=utf-8',
      size_bytes: 4,
      sha256_hex: 'ab',
      text_attachment: { v: 1, source: 'paste', chars: 4, lines: 2 },
    });
  });
});
