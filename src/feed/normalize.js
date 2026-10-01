// Pure, worker-safe normalization. Feed markup is reduced to inert text; no
// HTML, image, iframe or media resource is ever attached to the document.
export const FEED_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, pages: 5, items: 500, timeout: 10000, concurrency: 4, poll: 300000, backoff: 3600000 });
export function safeFeedUrl(value) {
  if (typeof value !== 'string' || [...value].some(c => c === '\\' || c.charCodeAt(0) <= 32)) throw new Error('unsafe_url');
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('unsafe_url');
  return u.href;
}
export function publicFeedUrl(value) { const u = new URL(safeFeedUrl(value)); u.hash = ''; return u.href; }
export function feedEndpoint(base, endpoint, feedId = '') {
  const b = new URL(safeFeedUrl(base));
  if (b.pathname !== '/' || b.search || b.hash || b.hostname.endsWith('.fips')) throw new Error('unsupported_source_transport');
  const expected = feedId ? `/feed/${feedId}` : '/feed/list';
  if ((feedId && (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(feedId) || feedId === 'list')) || endpoint !== expected) throw new Error('unsafe_endpoint');
  return new URL(endpoint, b).href;
}
export function nextFeedUrl(value, initial, privateSource) {
  const u = new URL(safeFeedUrl(value)), first = new URL(initial);
  if (u.hash) throw new Error('unsafe_page');
  if (privateSource && (u.origin !== first.origin || u.pathname !== first.pathname || [...u.searchParams.keys()].some(k => !['cursor', 'limit'].includes(k)))) throw new Error('unsafe_page');
  return u.href;
}
function entities(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, x) => {
    if (x[0] === '#') { const n = x[1].toLowerCase() === 'x' ? parseInt(x.slice(2), 16) : Number(x.slice(1)); return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''; }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[x.toLowerCase()];
  });
}
function inertFeedText(value = '') {
  return entities(String(value).replace(/<(script|style|iframe|object|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 32000);
}
function string(value, required = false) { if (typeof value !== 'string' || (required && !value.trim())) throw new Error('invalid_feed'); return value; }
function date(value, required = false) { if (value == null && !required) return ''; if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || (required && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))) throw new Error('invalid_date'); return value; }
function attachments(rows = []) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid_attachments');
  return rows.map(a => {
    const row = { url: safeFeedUrl(a.url), mime_type: string(a.mime_type, true), title: a.title == null ? '' : string(a.title) };
    for (const k of ['size_in_bytes', 'duration_in_seconds']) { if (a[k] != null) { if (!Number.isFinite(a[k]) || a[k] < 0) throw new Error('invalid_attachment'); row[k] = a[k]; } }
    return row;
  });
}
function unique(items) { const ids = new Set(); for (const i of items) { if (ids.has(i.id)) throw new Error('duplicate_item_id'); ids.add(i.id); } return items; }
function normalizeJsonFeed(raw, privateSource = false) {
  if (raw?.version !== 'https://jsonfeed.org/version/1.1' || !Array.isArray(raw.items) || raw.items.length > FEED_LIMITS.items) throw new Error('unsupported_feed');
  const title = string(raw.title);
  if (privateSource) safeFeedUrl(raw.feed_url);
  const items = raw.items.map(i => {
    for (const k of ['content_text', 'content_html', 'summary']) if (i[k] != null && typeof i[k] !== 'string') throw new Error('invalid_feed');
    const id = string(i.id, true); if (id.length > 2048) throw new Error('invalid_item_id');
    if (privateSource && typeof i.content_text !== 'string' && typeof i.content_html !== 'string') throw new Error('invalid_feed');
    return { id, title: i.title == null && !privateSource ? '' : string(i.title), url: i.url == null && !privateSource ? '' : safeFeedUrl(i.url),
      text: inertFeedText(i.content_text ?? i.content_html ?? ''), summary: inertFeedText(i.summary ?? ''), published: date(i.date_published, privateSource), modified: date(i.date_modified), attachments: attachments(i.attachments) };
  });
  return { title, items: unique(items), next_url: raw.next_url == null ? '' : safeFeedUrl(raw.next_url) };
}
// Bounded XML tokenizer: no DTD/entity expansion, XInclude, resolution or DOM.
function xmlTree(xml) {
  if (/<!DOCTYPE|<!ENTITY|<\s*xi:|xmlns[^=]*=\s*['"]http:\/\/www.w3.org\/2001\/XInclude/i.test(xml)) throw new Error('unsafe_xml');
  const root = { name: '', children: [], text: '', attrs: {} }, stack = [root]; let pos = 0, count = 0;
  const tokens = /<!--[\s\S]*?-->|<\?xml[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g; let match;
  while ((match = tokens.exec(xml))) {
    if (match.index !== pos) throw new Error('malformed_xml'); pos = tokens.lastIndex; const t = match[0], parent = stack.at(-1);
    if (t.startsWith('<!--') || t.startsWith('<?xml')) continue;
    if (t.startsWith('<![CDATA[')) { parent.text += t.slice(9, -3); continue; }
    if (!t.startsWith('<')) { if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(t)) throw new Error('unsafe_xml_entity'); parent.text += entities(t); continue; }
    if (t.startsWith('</')) { const m = /^<\/([\w:.-]+)\s*>$/.exec(t); if (!m || stack.length === 1 || stack.pop().name !== m[1]) throw new Error('malformed_xml'); continue; }
    const m = /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*)(\/?)>$/.exec(t);
    if (!m || ++count > 20000 || stack.length > 32) throw new Error('malformed_xml');
    const node = { name: m[1], children: [], text: '', attrs: {} }; const attrs = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a;
    while ((a = attrs.exec(m[2]))) { if (Object.hasOwn(node.attrs, a[1])) throw new Error('malformed_xml'); node.attrs[a[1]] = entities(a[2] ?? a[3]); }
    parent.children.push(node); if (!m[3]) stack.push(node);
  }
  if (pos !== xml.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw new Error('malformed_xml');
  return root.children[0];
}
const child = (n, k) => n.children.find(c => c.name === k);
const value = (n, k) => child(n, k)?.text.trim() || '';
function normalizeRss(xml) {
  const root = xmlTree(xml), channel = child(root, 'channel');
  if (root.name !== 'rss' || !channel) throw new Error('unsupported_feed');
  const nodes = channel.children.filter(n => n.name === 'item'); if (nodes.length > FEED_LIMITS.items) throw new Error('feed_too_large');
  const items = nodes.map(n => {
    const link = value(n, 'link'), guid = value(n, 'guid');
    // Fail visibly instead of claiming stable historical mapping for weak IDs.
    if (!guid && !link) throw new Error('rss_stable_id_required');
    const enclosure = child(n, 'enclosure'); let media = [];
    if (enclosure) { const a = enclosure.attrs; media = attachments([{ url: a.url, mime_type: a.type, ...(a.length != null ? { size_in_bytes: Number(a.length) } : {}) }]); }
    return { id: guid || safeFeedUrl(link), title: value(n, 'title'), url: link ? safeFeedUrl(link) : '', text: inertFeedText(value(n, 'description')), summary: '', published: date(value(n, 'pubDate') || undefined), modified: '', attachments: media };
  });
  return { title: value(channel, 'title'), items: unique(items), next_url: '' };
}
export function normalizeFeed(text, format, privateSource = false) {
  if (new TextEncoder().encode(text).byteLength > FEED_LIMITS.bytes) throw new Error('feed_too_large');
  return format === 'rss' ? normalizeRss(text) : normalizeJsonFeed(JSON.parse(text), privateSource);
}
