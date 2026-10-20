import { isDmChannel, normalizeDmParticipants } from './dm-scope.js';

export function isNoteToSelf(channel, npub) {
  const participants = normalizeDmParticipants(channel?.participant_npubs);
  return Boolean(npub && isDmChannel(channel) && participants.length === 1 && participants[0] === npub);
}

// Keep raw query components intact: URLSearchParams re-encoding can invalidate
// signatures even when the functional values are unchanged.
export function cleanSharedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return value; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return value;
  const parts = url.search.slice(1).split('&').filter(Boolean);
  const keys = parts.map(part => { try { return decodeURIComponent(part.split('=')[0]).toLowerCase(); } catch { return ''; } });
  if (keys.some(key => /^(?:x-amz-|x-goog-)/.test(key) || ['signature', 'sig', 'token', 'policy', 'key-pair-id', 'hmac'].includes(key))) return value;
  const youtube = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(url.hostname.toLowerCase());
  const remove = key => /^utm_/.test(key) || ['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid'].includes(key) || (youtube && ['si', 'feature'].includes(key));
  const kept = parts.filter((_, index) => !remove(keys[index]));
  const short = ['youtu.be', 'www.youtu.be'].includes(url.hostname.toLowerCase()) && !url.port;
  const id = short ? url.pathname.slice(1) : '';
  if (short && /^[A-Za-z0-9_-]{11}$/.test(id) && !keys.includes('v')) {
    return `https://www.youtube.com/watch?v=${id}${kept.length ? '&' + kept.join('&') : ''}${url.hash}`;
  }
  // Preserve original spelling/encoding outside the removed query items.
  const base = value.split(/[?#]/, 1)[0];
  return base + (kept.length ? '?' + kept.join('&') : '') + url.hash;
}

export function cleanSharedText(text) {
  return String(text).replace(/https?:\/\/[^\s<>"\p{Cc}]+/gu, match => {
    // Delimiters belong to surrounding prose/Markdown. Balanced URL parentheses
    // remain part of a URL (e.g. Wikipedia article names).
    let url = match, suffix = '';
    while (/[.,!;:]$/.test(url) || (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length)) {
      suffix = url.slice(-1) + suffix; url = url.slice(0, -1);
    }
    return cleanSharedUrl(url) + suffix;
  });
}

export async function sanitizeNoteImage(file) {
  // Re-encoding pixels removes EXIF, GPS, XMP, IPTC and source text chunks.
  // Animated images are refused instead of silently dropping their frames.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ascii = new TextDecoder('latin1').decode(bytes);
  if (file.type === 'image/gif' || ascii.includes('acTL') || ascii.includes('ANIM')) throw new Error('Choose a still image; animated images cannot be sanitized without losing frames.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image decoding is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Image sanitization failed; original was not uploaded.');
    return new File([blob], `${String(file.name || 'image').replace(/\.[^.]*$/, '')}.png`, { type: 'image/png' });
  } finally { bitmap.close(); }
}
