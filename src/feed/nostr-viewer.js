import { nip19 } from 'nostr-tools';

const DEFAULT_VIEWER = 'https://njump.me/';
const STORAGE_KEY = 'ambulando:nostr-viewer';

export function normalizeNostrViewer(value = '') {
  const input = String(value).trim();
  if (!input) return DEFAULT_VIEWER;
  if (!/^https?:\/\//i.test(input) || (/[\s\\]/.test(input) || [...input].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) throw new Error('Enter an absolute HTTP(S) URL without credentials, query or fragment.');
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || input.includes('?') || input.includes('#')) throw new Error('Enter an absolute HTTP(S) URL without credentials, query or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}

function readViewer() {
  try { return normalizeNostrViewer(localStorage.getItem(STORAGE_KEY) || ''); } catch { return DEFAULT_VIEWER; }
}

export function nostrViewerUrl(value, base) {
  let url;
  try { url = new URL(value); } catch { return value; }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'njump.me' || url.port || url.username || url.password || url.search || url.hash) return value;
  const identifier = url.pathname.slice(1);
  try {
    const decoded = nip19.decode(identifier);
    if (!['nevent', 'npub', 'note', 'nprofile', 'naddr'].includes(decoded.type)) return value;
    return normalizeNostrViewer(base) + identifier;
  } catch { return value; }
}

export const nostrViewerMixin = {
  nostrViewerBaseUrl: readViewer(),
  nostrViewerDraft: readViewer(),
  nostrViewerError: '',
  nostrViewerStatus: '',
  saveNostrViewer(value = this.nostrViewerDraft) {
    this.nostrViewerError = ''; this.nostrViewerStatus = '';
    try {
      const normalized = normalizeNostrViewer(value);
      localStorage.setItem(STORAGE_KEY, normalized);
      this.nostrViewerBaseUrl = normalized;
      this.nostrViewerDraft = normalized;
      this.nostrViewerStatus = 'Nostr viewer saved on this device.';
      return true;
    } catch (error) {
      this.nostrViewerError = error instanceof TypeError ? 'Enter a valid absolute HTTP(S) URL.' : error.message;
      return false;
    }
  },
};
