import { liveQuery } from 'dexie';
import { getWorkspaceDb } from '../db.js';
import { privatePreferenceContext, preferenceStorageKey, queuePrivatePreference } from '../private-preference-store.js';
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

const subscriptions = new WeakMap();

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
  nostrViewerBaseUrl: DEFAULT_VIEWER,
  nostrViewerDraft: DEFAULT_VIEWER,
  nostrViewerContext: '',
  getNostrViewerBaseUrl() {
    try { return privatePreferenceContext(this).key === this.nostrViewerContext ? this.nostrViewerBaseUrl : DEFAULT_VIEWER; } catch { return DEFAULT_VIEWER; }
  },
  nostrViewerError: '',
  nostrViewerStatus: '',
  readLegacyNostrViewer(contextKey) {
    try {
      const ownerKey = `${STORAGE_KEY}:owner`;
      const owner = localStorage.getItem(ownerKey);
      if (owner && owner !== contextKey) return null;
      localStorage.setItem(ownerKey, contextKey);
      const value = localStorage.getItem(STORAGE_KEY);
      return value ? normalizeNostrViewer(value) : null;
    } catch { return null; }
  },
  disposeNostrViewer() {
    subscriptions.get(this)?.subscription?.unsubscribe();
    subscriptions.delete(this);
    this.nostrViewerBaseUrl = DEFAULT_VIEWER;
    this.nostrViewerDraft = DEFAULT_VIEWER;
    this.nostrViewerContext = '';
    this.nostrViewerStatus = '';
    this.nostrViewerError = '';
  },
  async activateNostrViewer() {
    let context;
    try { context = privatePreferenceContext(this); } catch { this.disposeNostrViewer(); return; }
    if (subscriptions.get(this)?.key === context.key) return;
    this.disposeNostrViewer();
    this.nostrViewerContext = context.key;
    const entry = { key: context.key };
    subscriptions.set(this, entry);
    const db = getWorkspaceDb();
    entry.subscription = liveQuery(() => db.private_preferences.get(preferenceStorageKey(context))).subscribe({
      next: state => {
        if (subscriptions.get(this) !== entry) return;
        try { if (privatePreferenceContext(this).key !== context.key) return; } catch { return; }
        let value = DEFAULT_VIEWER;
        try { value = normalizeNostrViewer(state?.pending?.at(-1)?.value ?? state?.row?.value ?? ''); } catch { /* Invalid remote URLs never become navigation targets. */ }
        const changed = this.nostrViewerBaseUrl !== value;
        this.nostrViewerBaseUrl = value;
        if (changed) this.nostrViewerDraft = value;
        this.nostrViewerStatus = state?.error || (state?.pending?.length ? 'Saved; waiting to synchronize with Tower.' : state?.ready ? 'Synchronized with your workspace across devices.' : 'Connect to Tower to load your saved preference.');
      },
      error: () => { if (subscriptions.get(this) === entry) this.nostrViewerError = 'Could not load your saved preference.'; },
    });
  },
  async saveNostrViewer(value = this.nostrViewerDraft) {
    this.nostrViewerError = ''; this.nostrViewerStatus = '';
    try {
      const normalized = normalizeNostrViewer(value);
      const context = privatePreferenceContext(this);
      await this.activateNostrViewer();
      await queuePrivatePreference(getWorkspaceDb(), context, normalized);
      this.nostrViewerDraft = normalized;
      this.nostrViewerStatus = 'Saved; waiting to synchronize with Tower.';
      void this.getTowerSyncService()?.ensureLoaded('private-preferences').catch(() => {});
      return true;
    } catch (error) {
      this.nostrViewerError = error instanceof TypeError ? 'Enter a valid absolute HTTP(S) URL.' : error.message;
      return false;
    }
  },
};
