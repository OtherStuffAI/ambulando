import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/api.js', () => ({ getTowerPgStorageUsage: vi.fn() }));
import { getTowerPgStorageUsage } from '../src/api.js';
import { formatStorageBytes, normalizeStorageUsage, towerUsageMixin } from '../src/tower-usage.js';
function snapshot(workspaceId = 'a', bytes = 2048) {
  return { workspace_id: workspaceId, collected_at: '2026-10-07T08:00:00Z', total_bytes: bytes, coverage: 'partial',
    total_description: 'Partial subtotal excludes unknown stores.', categories: [
      { id: 'objects', bytes, status: 'partial', measurement: 'registered_bytes', reason: 'Linked objects only.' },
      { id: 'database', bytes: 0, status: 'partial', measurement: 'logical_estimate', reason: 'Estimate.' },
    ] };
}
function store(id = 'a') {
  const s = { currentWorkspace: { workspaceId: id, directHttpsUrl: 'https://tower.invalid', appNpub: 'app' }, session: { npub: 'alice' }, currentViewerNpub: 'alice' };
  Object.defineProperties(s, Object.getOwnPropertyDescriptors(towerUsageMixin)); return s;
}
beforeEach(() => vi.resetAllMocks());
it('formats measured zero and binary units, keeping missing/invalid bytes unavailable', () => {
  expect(formatStorageBytes(0)).toBe('0 B'); expect(formatStorageBytes(2048)).toBe('2 KiB');
  expect(formatStorageBytes(1024 ** 3)).toBe('1 GiB');
  for (const value of [null, undefined, -1, NaN, '0']) expect(formatStorageBytes(value)).toBe('Unavailable');
});
it('includes all required categories and rejects wrong-workspace or contradictory totals', () => {
  const data = normalizeStorageUsage(snapshot(), 'a');
  expect(data.categories.map(row => row.id)).toEqual(['objects', 'database', 'graph', 'git', 'grasp', 'other']);
  expect(data.categories[1].bytes).toBe(0); expect(data.categories[2].bytes).toBeNull();
  expect(data.categories[2].reason).toContain('does not provide');
  expect(() => normalizeStorageUsage(snapshot('b'), 'a')).toThrow();
  expect(() => normalizeStorageUsage({ ...snapshot(), total_bytes: 123 }, 'a')).toThrow();
});
it('passes exact endpoint/workspace, presents partial state and refreshes', async () => {
  const s = store(); getTowerPgStorageUsage.mockResolvedValue(snapshot());
  await s.openTowerUsage(); expect(s.towerUsageStatus).toBe('partial');
  expect(getTowerPgStorageUsage).toHaveBeenCalledWith('a', expect.objectContaining({ baseUrl: 'https://tower.invalid', appNpub: 'app' }));
  expect(s.towerUsageCollectedLabel).not.toBe('Not collected');
  await s.refreshTowerUsage(); expect(getTowerPgStorageUsage).toHaveBeenCalledTimes(2);
});
it('clears old bytes immediately on workspace/viewer changes and ignores stale responses', async () => {
  const s = store(); let resolveOld;
  getTowerPgStorageUsage.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(snapshot('b', 10));
  const old = s.openTowerUsage();
  s.currentWorkspace = { ...s.currentWorkspace, workspaceId: 'b' };
  expect(s.towerUsageCurrentSnapshot).toBeNull();
  await s.syncTowerUsageContext(); resolveOld(snapshot()); await old;
  expect(s.towerUsageCurrentSnapshot.total_bytes).toBe(10);
  s.currentViewerNpub = 'bob'; expect(s.towerUsageCurrentSnapshot).toBeNull();
  expect(s.towerUsageRows.every(row => row.bytes === null)).toBe(true);
});
it.each([401, 403, 404, 503])('handles HTTP %i without inventing zero', async status => {
  const s = store(); getTowerPgStorageUsage.mockRejectedValue({ status }); await s.openTowerUsage();
  expect(s.towerUsageStatus).toBe([401, 403].includes(status) ? 'unauthorized' : 'unavailable');
  expect(s.towerUsageRows.every(row => row.bytes === null && row.reason)).toBe(true);
});
it('distinguishes measured empty from unmeasured and no workspace', async () => {
  const s = store(); getTowerPgStorageUsage.mockResolvedValue(snapshot('a', 0)); await s.openTowerUsage();
  expect(s.towerUsageStatus).toBe('empty'); expect(s.towerUsageCurrentSnapshot.total_bytes).toBe(0);
  getTowerPgStorageUsage.mockResolvedValue({ ...snapshot(), total_bytes: null, categories: [] });
  await s.refreshTowerUsage(); expect(s.towerUsageStatus).toBe('unavailable');
  s.currentWorkspace = {}; await s.refreshTowerUsage(); expect(s.towerUsageStatus).toBe('empty');
  expect(s.towerUsageCurrentSnapshot).toBeNull();
});
it('aborts and discards work when closed', async () => {
  const s = store(); let finish;
  getTowerPgStorageUsage.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const work = s.openTowerUsage(); const signal = getTowerPgStorageUsage.mock.calls[0][1].signal;
  s.closeTowerUsage(); expect(signal.aborted).toBe(true); finish(snapshot()); await work;
  expect(s.towerUsageCurrentSnapshot).toBeNull();
});

it('resizes without collecting and resets presentation on close', async () => {
  const s = store(); getTowerPgStorageUsage.mockResolvedValue(snapshot());
  await s.openTowerUsage(); const current = s.towerUsageCurrentSnapshot;
  s.toggleTowerUsagePresentation(); expect(s.towerUsageFull).toBe(true);
  expect(s.towerUsageCurrentSnapshot).toBe(current);
  await s.openTowerUsage(); expect(getTowerPgStorageUsage).toHaveBeenCalledTimes(1);
  s.towerUsageMenuOpen = true; const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  // DOM focus behavior is covered through the Apps launcher browser test.
  s.dismissTowerUsageMenu = () => { s.towerUsageMenuOpen = false; };
  s.handleTowerUsageEscape(event); expect(s.towerUsageOpen).toBe(true);
  s.handleTowerUsageEscape(event); expect(s.towerUsageOpen).toBe(false);
  expect(s.towerUsageFull).toBe(false); expect(s.towerUsageMenuOpen).toBe(false);
});
it('does not amplify a pending read or collect while closed', async () => {
  const s = store(); let finish;
  await s.refreshTowerUsage(); expect(getTowerPgStorageUsage).not.toHaveBeenCalled();
  getTowerPgStorageUsage.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const work = s.openTowerUsage(); await s.refreshTowerUsage();
  expect(getTowerPgStorageUsage).toHaveBeenCalledTimes(1);
  s.toggleTowerUsagePresentation(); finish(snapshot()); await work;
  expect(s.towerUsageCurrentSnapshot.total_bytes).toBe(2048);
  s.closeTowerUsage();
});
