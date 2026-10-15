import { describe, expect, it } from 'vitest';
import { cleanSharedUrl, cleanSharedText, isNoteToSelf } from '../src/note-to-self.js';
import { resolveChannelLabel } from '../src/channel-labels.js';

describe('Note to self', () => {
  it('recognizes normalized single participants and labels only the viewer’s self conversation', () => {
    const channel = { kind: 'dm', participant_npubs: ['me', 'me'] };
    expect(isNoteToSelf(channel, 'me')).toBe(true);
    expect(isNoteToSelf(channel, 'other')).toBe(false);
    expect(resolveChannelLabel(channel, { sessionNpub: 'me' })).toBe('Note to self');
    expect(isNoteToSelf({ ...channel, participant_npubs: ['me', 'other'] }, 'me')).toBe(false);
  });
  it('cleans multiple links in prose while retaining playback and unknown parameters', () => {
    expect(cleanSharedText('Watch (https://youtu.be/dQw4w9WgXcQ?si=abc&t=42&list=PL123&index=2). Also https://example.com/x?utm_source=mail&q=a%20b&ref=keep#part!'))
      .toBe('Watch (https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42&list=PL123&index=2). Also https://example.com/x?q=a%20b&ref=keep#part!');
  });
  it.each(['sig=abc', 'X-Amz-Signature=abc', 'token=abc', 'X-Goog-Credential=abc'])('leaves signed links byte-for-byte intact (%s)', signature => {
    const url = `https://example.com/a?utm_source=x&${signature}&q=a%20b`;
    expect(cleanSharedUrl(url)).toBe(url);
  });
  it('does not canonicalize lookalike hosts or ambiguous short URLs', () => {
    expect(cleanSharedUrl('https://youtu.be.evil.test/dQw4w9WgXcQ?si=keep')).toBe('https://youtu.be.evil.test/dQw4w9WgXcQ?si=keep');
    expect(cleanSharedUrl('https://youtu.be/dQw4w9WgXcQ?v=other&t=1')).toBe('https://youtu.be/dQw4w9WgXcQ?v=other&t=1');
    expect(cleanSharedText('[article](https://example.com/wiki/Thing_(name)?utm_source=x)')).toBe('[article](https://example.com/wiki/Thing_(name))');
  });
});
