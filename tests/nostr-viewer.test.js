import { describe, it, expect, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import { normalizeNostrViewer, nostrViewerUrl, nostrViewerMixin } from '../src/feed/nostr-viewer.js';
import { subscribedReaderMixin } from '../src/feed/reader-manager.js';
const npub = nip19.npubEncode('ab'.repeat(32));
const nevent = nip19.neventEncode({ id: 'cd'.repeat(32), author: 'ab'.repeat(32), kind: 1 });
describe('Nostr viewer', () => {
  it('defaults, trims, normalizes slashes and retains prefixes', () => {
    expect(normalizeNostrViewer('')).toBe('https://njump.me/');
    expect(normalizeNostrViewer(' https://viewer.example/event/// ')).toBe('https://viewer.example/event/');
    expect(normalizeNostrViewer('http://localhost:8080/prefix')).toBe('http://localhost:8080/prefix/');
  });
  it.each(['javascript:alert(1)', 'data:text/html,x', '//host', 'https://', 'https://user:pass@host/', 'https://host/?x', 'https://host/#x', 'https://host/a\nb', 'https://host/\\x'])('rejects unsafe base %s', value => {
    expect(() => normalizeNostrViewer(value)).toThrow();
  });
  it('preserves complete identifiers and unrelated URLs', () => {
    for (const id of [npub, nevent]) expect(nostrViewerUrl(`https://njump.me/${id}`, 'https://viewer.example/event/')).toBe(`https://viewer.example/event/${id}`);
    for (const url of ['https://example.com/article', `https://njump.me.evil/${nevent}`, 'https://njump.me/about', `https://njump.me/${nevent}?x=1`]) expect(nostrViewerUrl(url, 'https://viewer.example/')).toBe(url);
  });
  it('opens the supplied exact Canopy event route from a cached njump link', () => {
    // Source message: 021da359-cf13-4bb6-a5ba-08c57aa9f4d2.
    const identifier = 'nevent1qvzqqqqqqypzqwau4dlr62c854gzwgrdtcvnsylszsrgstd26p2pywy62zm8h2fwqqs9t9ngv4ll5urt44z6x3d7x9uxjfpyp0x42qxssqqqvl5fdt6yufq027s6g';
    const expected = 'https://canopy.winn.cloud/event/nevent1qvzqqqqqqypzqwau4dlr62c854gzwgrdtcvnsylszsrgstd26p2pywy62zm8h2fwqqs9t9ngv4ll5urt44z6x3d7x9uxjfpyp0x42qxssqqqvl5fdt6yufq027s6g';
    const open = vi.fn(); vi.stubGlobal('window', { open });
    const store = { ...subscribedReaderMixin, nostrViewerBaseUrl: 'https://canopy.winn.cloud/event/' };
    store.openFeedItem({ url: `https://njump.me/${identifier}` });
    expect(open).toHaveBeenCalledExactlyOnceWith(expected, '_blank', 'noopener,noreferrer');
    expect(normalizeNostrViewer('')).toBe('https://njump.me/');
    vi.unstubAllGlobals();
  });
  it('rejects invalid edits before writing or changing the current choice', async () => {
    const store = { ...nostrViewerMixin, nostrViewerBaseUrl: 'https://viewer.example/event/' };
    expect(await store.saveNostrViewer('javascript:alert(1)')).toBe(false);
    expect(store.nostrViewerBaseUrl).toBe('https://viewer.example/event/');
  });
  it('opens cached links immediately using current preference, once and safely', () => {
    const open = vi.fn(); vi.stubGlobal('window', { open });
    const store = { ...subscribedReaderMixin, nostrViewerBaseUrl: 'https://viewer.example/event/' };
    const cached = { url: `https://njump.me/${nevent}` };
    store.openFeedItem(cached);
    expect(open).toHaveBeenLastCalledWith(`https://viewer.example/event/${nevent}`, '_blank', 'noopener,noreferrer');
    store.nostrViewerBaseUrl = 'https://njump.me/'; store.openFeedItem(cached);
    expect(open).toHaveBeenLastCalledWith(cached.url, '_blank', 'noopener,noreferrer');
    store.openFeedItem({ url: 'https://example.com/article' });
    expect(open).toHaveBeenLastCalledWith('https://example.com/article', '_blank', 'noopener,noreferrer');
    store.openFeedItem({ url: 'javascript:alert(1)' }); expect(open).toHaveBeenCalledTimes(3);
    expect(cached.url).toBe(`https://njump.me/${nevent}`); vi.unstubAllGlobals();
  });
});
