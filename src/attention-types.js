import { liveQuery } from 'dexie';
import { getWorkspaceDb } from './db.js';
import { ATTENTION_TYPES_KEY, privatePreferenceContext, preferenceStorageKey, queuePrivatePreference } from './private-preference-store.js';

export const ATTENTION_TYPES = ['chat', 'document', 'task', 'file', 'other'];
export function parseAttentionTypes(value) {
  try {
    const data = JSON.parse(value);
    if (data && data.version === 1 && Array.isArray(data.disabled) && data.disabled.every(type => typeof type === 'string')) return data;
  } catch { /* Missing or unsupported values preserve the compatible default. */ }
  return null;
}
export function attentionTypeEnabled(value, type) {
  return !ATTENTION_TYPES.includes(type) || !parseAttentionTypes(value)?.disabled.includes(type);
}
export function toggleAttentionType(value, type, enabled) {
  if (!ATTENTION_TYPES.includes(type)) throw new Error('Unknown attention type');
  const data = parseAttentionTypes(value);
  if (value && !data) throw new Error('This saved preference uses an unsupported format. Update the app before changing it.');
  const next = data || { version: 1, disabled: [] };
  return JSON.stringify({ ...next, disabled: enabled ? next.disabled.filter(item => item !== type) : [...new Set([...next.disabled, type])] });
}
export function notificationAttentionType(item) {
  const kind = item?.target?.kind;
  if (['thread', 'message', 'channel', 'dm', 'chat'].includes(kind)) return 'chat';
  if (['doc', 'doc_comment', 'document', 'document_comment'].includes(kind)) return 'document';
  if (['task', 'task_comment'].includes(kind)) return 'task';
  if (['file', 'file_comment'].includes(kind)) return 'file';
  return 'other';
}
export function filterDeckAttention(rows, value) {
  return rows.filter(row => !row.isUnread || attentionTypeEnabled(value, row.inboxKind));
}
const subscriptions = new WeakMap();
export const attentionTypesMixin = {
  attentionTypes: ATTENTION_TYPES,
  attentionTypesValue: '',
  attentionTypesContext: '',
  attentionTypesReady: false,
  attentionTypesStatus: '',
  attentionTypesError: '',
  getAttentionTypesValue() {
    try { return privatePreferenceContext(this).key === this.attentionTypesContext ? this.attentionTypesValue : ''; } catch { return ''; }
  },
  isAttentionTypeEnabled(type) { return attentionTypeEnabled(this.getAttentionTypesValue(), type); },
  disposeAttentionTypes() {
    subscriptions.get(this)?.subscription?.unsubscribe();
    subscriptions.delete(this);
    this.attentionTypesContext = ''; this.attentionTypesValue = ''; this.attentionTypesReady = false;
    this.attentionTypesStatus = ''; this.attentionTypesError = '';
  },
  activateAttentionTypes() {
    let context;
    try { context = { ...privatePreferenceContext(this), preferenceKey: ATTENTION_TYPES_KEY }; } catch { this.disposeAttentionTypes(); return; }
    if (subscriptions.get(this)?.key === context.key) return;
    this.disposeAttentionTypes();
    this.attentionTypesContext = context.key;
    const entry = { key: context.key }; subscriptions.set(this, entry);
    entry.subscription = liveQuery(() => getWorkspaceDb().private_preferences.get(preferenceStorageKey(context))).subscribe({
      next: state => {
        if (subscriptions.get(this) !== entry) return;
        try { if (privatePreferenceContext(this).key !== context.key) return; } catch { return; }
        this.attentionTypesValue = state?.pending?.at(-1)?.value ?? state?.row?.value ?? '';
        this.attentionTypesReady = !!state?.ready;
        this.attentionTypesStatus = state?.error || (state?.pending?.length ? 'Saved on this device; waiting to synchronize with Tower.' : state?.ready ? 'Synced privately across devices for this workspace identity.' : 'Connect to Tower to load your saved choices.');
        this.projectNotificationInbox?.();
      },
      error: () => { this.attentionTypesError = 'Could not load your saved attention types.'; },
    });
  },
  async setAttentionType(type, enabled) {
    this.attentionTypesError = '';
    try {
      const context = { ...privatePreferenceContext(this), preferenceKey: ATTENTION_TYPES_KEY };
      await queuePrivatePreference(getWorkspaceDb(), context, value => toggleAttentionType(value, type, enabled));
      void this.requestTowerSyncFamily?.('private-preferences').catch(() => {});
    } catch (error) { this.attentionTypesError = error.message; }
  },
};
