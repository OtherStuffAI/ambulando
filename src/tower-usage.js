import { getTowerPgStorageUsage } from './api.js';
import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';

const STORES = [
  ['objects', 'S3 / object storage'], ['database', 'Database'], ['graph', 'Graph'],
  ['git', 'Git / Forgejo'], ['grasp', 'GRASP'], ['other', 'Other stores'],
];
export function formatStorageBytes(value) {
  if (value === null || value === undefined || !Number.isSafeInteger(value) || value < 0) return 'Unavailable';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length);
  return `${(value / 1024 ** exponent).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[exponent - 1]}`;
}
function usageContextKey(store) {
  const context = resolveTowerPgWorkspaceContext(store);
  return JSON.stringify([context.baseUrl, context.workspaceId, context.appNpub, store.currentViewerNpub || context.sessionNpub, context.generation]);
}
export function normalizeStorageUsage(payload, workspaceId) {
  if (payload?.workspace_id !== workspaceId || !Number.isFinite(Date.parse(payload?.collected_at))) throw new Error('Tower returned an invalid workspace usage snapshot.');
  const seen = new Set();
  const categories = STORES.map(([id, label]) => {
    const rows = (Array.isArray(payload.categories) ? payload.categories : []).filter(row => row?.id === id);
    const row = rows.length === 1 ? rows[0] : null;
    const bytes = row?.bytes;
    const valid = Number.isSafeInteger(bytes) && bytes >= 0 && ['measured', 'partial'].includes(row?.status)
      && ['registered_bytes', 'logical_estimate'].includes(row?.measurement);
    seen.add(id);
    return { id, label, bytes: valid ? bytes : null, measurement: valid ? row.measurement : 'unavailable',
      reason: String(row?.reason || 'Tower does not provide this measurement.'), status: valid ? row.status : 'unavailable' };
  });
  // Include future supported stores without quietly omitting their coverage.
  for (const row of Array.isArray(payload.categories) ? payload.categories : []) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    const valid = Number.isSafeInteger(row.bytes) && row.bytes >= 0 && ['measured', 'partial'].includes(row.status)
      && ['registered_bytes', 'logical_estimate'].includes(row.measurement);
    categories.push({ ...row, label: String(row.label || row.id), bytes: valid ? row.bytes : null,
      measurement: valid ? row.measurement : 'unavailable', reason: String(row.reason || 'Coverage not described by Tower.') });
  }
  // Keep Tower's subtotal authoritative. Reject a contradictory response rather than fabricate a total.
  const measured = categories.filter(row => row.bytes !== null);
  const sum = measured.reduce((total, row) => total + row.bytes, 0);
  const expected = measured.length && Number.isSafeInteger(sum) ? sum : null;
  if (payload.total_bytes !== expected) throw new Error('Tower returned inconsistent usage totals.');
  return { ...payload, categories, total_bytes: expected, coverage: 'partial',
    total_description: String(payload.total_description || 'Incomplete coverage: unavailable stores are excluded.') };
}

export const towerUsageMixin = {
  towerUsageOpen: false,
  towerUsageStatus: 'idle',
  towerUsageSnapshot: null,
  towerUsageError: '',
  towerUsageContext: '',
  _towerUsageRequest: 0,
  _towerUsageAbort: null,
  _towerUsageOpener: null,
  formatStorageBytes,
  get towerUsageDisplayTitle() { return this.toolboxApps?.find(app => app.placementId === 'napplet:tower-usage')?.title || 'Tower Usage'; },
  get towerUsageCurrentContext() { return usageContextKey(this); },
  get towerUsageRows() {
    const snapshot = this.towerUsageContext === this.towerUsageCurrentContext ? this.towerUsageSnapshot : null;
    return snapshot?.categories || STORES.map(([id, label]) => ({ id, label, bytes: null, measurement: 'unavailable', reason: this.towerUsageError || 'No measurement collected for this workspace.' }));
  },
  get towerUsageCurrentSnapshot() {
    return this.towerUsageContext === this.towerUsageCurrentContext ? this.towerUsageSnapshot : null;
  },
  get towerUsageCollectedLabel() {
    const value = this.towerUsageCurrentSnapshot?.collected_at;
    return value ? new Date(value).toLocaleString() : 'Not collected';
  },
  openTowerUsage({ opener } = {}) {
    this._towerUsageOpener = opener || (typeof document !== 'undefined' ? document.activeElement : null);
    this.towerUsageOpen = true;
    return this.refreshTowerUsage();
  },
  closeTowerUsage() {
    this.towerUsageOpen = false;
    this._towerUsageRequest++;
    this._towerUsageAbort?.abort();
    this._towerUsageAbort = null;
    this.towerUsageSnapshot = null;
    const opener = this._towerUsageOpener;
    if (opener?.isConnected) opener.focus();
    this._towerUsageOpener = null;
  },
  trapTowerUsageFocus(event) {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll('button:not([disabled])')];
    const first = controls[0], last = controls.at(-1);
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  },
  syncTowerUsageContext() {
    if (this.towerUsageOpen && this.towerUsageContext !== this.towerUsageCurrentContext) return this.refreshTowerUsage();
  },
  async refreshTowerUsage() {
    const key = this.towerUsageCurrentContext;
    const request = ++this._towerUsageRequest;
    this._towerUsageAbort?.abort();
    const controller = new AbortController();
    this._towerUsageAbort = controller;
    this.towerUsageContext = key;
    this.towerUsageSnapshot = null;
    this.towerUsageError = '';
    this.towerUsageStatus = 'loading';
    const context = resolveTowerPgWorkspaceContext(this);
    if (!context.workspaceId || !context.baseUrl) {
      this.towerUsageStatus = 'empty';
      this.towerUsageError = 'Select a Tower workspace to collect usage.';
      return;
    }
    try {
      const payload = await getTowerPgStorageUsage(context.workspaceId, { baseUrl: context.baseUrl, appNpub: context.appNpub, signal: controller.signal });
      if (!this.towerUsageOpen || request !== this._towerUsageRequest || key !== this.towerUsageCurrentContext) return;
      this.towerUsageSnapshot = normalizeStorageUsage(payload, context.workspaceId);
      this.towerUsageStatus = this.towerUsageSnapshot.total_bytes === null ? 'unavailable' : this.towerUsageSnapshot.total_bytes === 0 ? 'empty' : 'partial';
    } catch (error) {
      if (!this.towerUsageOpen || request !== this._towerUsageRequest || key !== this.towerUsageCurrentContext) return;
      this.towerUsageStatus = [401, 403].includes(error?.status) ? 'unauthorized' : 'unavailable';
      this.towerUsageError = this.towerUsageStatus === 'unauthorized'
        ? 'Workspace management permission is required to view workspace-wide storage usage.'
        : 'Tower usage is unavailable. This Tower may not support storage measurements yet. Try refreshing.';
    } finally {
      if (request === this._towerUsageRequest) this._towerUsageAbort = null;
    }
  },
};
