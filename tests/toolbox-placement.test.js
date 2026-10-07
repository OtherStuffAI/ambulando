import { beforeEach, expect, it, vi } from 'vitest';
import { getSharedDb, getSettings, saveSettings, saveAppPlacement } from '../src/db.js';
import { toolboxMixin } from '../src/toolbox-manager.js';
import { parseRouteLocation } from '../src/route-helpers.js';
import { buildFlightDeckDocumentTitle } from '../src/page-title.js';
import { sectionLiveQueryMixin } from '../src/section-live-queries.js';

function store() {
  const s = { currentWorkspaceKey: 'tower/workspace-a', currentPgActorId: 'alice',
    currentViewerNpub: 'npubAlice',
    visiblePersonalWapps: [{ record_id: 'artifact', title: 'Artifacts', launch_url: 'https://app.invalid/', sort_order: 5 }],
    closePersonalWappsOverlay: vi.fn(), openMessageActivity: vi.fn(), openPersonalWapp: vi.fn() };
  Object.defineProperties(s, Object.getOwnPropertyDescriptors(toolboxMixin));
  return s;
}
beforeEach(async () => { await getSharedDb().app_settings.clear(); });

it('defaults existing entries to Apps, deduplicates IDs and preserves launcher fields', () => {
  const s = store(); s.visiblePersonalWapps.push(s.visiblePersonalWapps[0]);
  expect(s.visibleApps.map(app => app.placementId)).toEqual(['wapp:artifact', 'napplet:message-activity']);
  expect(s.visibleApps[0]).toMatchObject({ launch_url: 'https://app.invalid/', sort_order: 5 });
});

it('persists each type across recreated stores without losing settings or concurrent partitions', async () => {
  await saveSettings({ backendUrl: 'https://tower.invalid' });
  const s = store();
  await s.setAppPlacement(s.toolboxApps[0], false);
  await s.setAppPlacement(s.toolboxApps[1], false);
  const restored = store(); restored.appPlacementPreferences = (await getSettings()).appPlacements;
  expect(restored.visibleApps).toEqual([]);
  restored.currentWorkspaceKey = 'tower/workspace-b'; expect(restored.visibleApps).toHaveLength(2);
  restored.currentWorkspaceKey = s.currentWorkspaceKey;
  restored.currentPgActorId = 'bob'; expect(restored.visibleApps).toHaveLength(2);
  await Promise.all([
    saveAppPlacement(s.appPlacementPartition, 'wapp:other', false),
    saveAppPlacement(restored.appPlacementPartition, 'napplet:message-activity', false),
  ]);
  const settings = await getSettings();
  expect(settings.backendUrl).toBe('https://tower.invalid');
  expect(settings.appPlacements[s.appPlacementPartition]).toEqual({
    'wapp:artifact': false, 'napplet:message-activity': false, 'wapp:other': false,
  });
  expect(settings.appPlacements[restored.appPlacementPartition]['napplet:message-activity']).toBe(false);
});

it('routes each launch through the existing behavior and rejects hidden or missing registrations', async () => {
  const s = store(); const [wapp, napplet] = s.toolboxApps;
  s.openApp(wapp); expect(s.openPersonalWapp).toHaveBeenCalledWith(wapp);
  s.openApp(napplet); expect(s.openMessageActivity).toHaveBeenCalledOnce();
  await s.setAppPlacement(napplet, false); s.openApp(napplet);
  expect(s.openMessageActivity).toHaveBeenCalledOnce();
  s.visiblePersonalWapps = []; s.openApp(wapp); expect(s.openPersonalWapp).toHaveBeenCalledOnce();
});

it('publishes saved preferences from the shared live query after context changes', async () => {
  const s = store(); Object.assign(s, sectionLiveQueryMixin);
  const listeners = new Map();
  s.createLiveSubscription = (query, next) => { listeners.set(query, next); return query; };
  s.stopLiveSubscription = vi.fn();
  s.startSharedLiveQueries();
  await saveAppPlacement(s.appPlacementPartition, 'wapp:artifact', false);
  s.currentWorkspaceKey = 'tower/workspace-b';
  for (const [query, next] of listeners) {
    const value = await query(); if (!Array.isArray(value)) next(value);
  }
  expect(s.visibleApps).toHaveLength(2);
  s.currentWorkspaceKey = 'tower/workspace-a'; expect(s.visibleApps.map(app => app.appType)).toEqual(['Napplet']);
  s.stopSharedLiveQueries();
});

it('keeps Toolbox as a reloadable workspace route and titled page', () => {
  expect(parseRouteLocation('https://deck.invalid/team/toolbox?scopeid=scope')).toMatchObject({
    section: 'toolbox', workspaceSlug: 'team', params: { scopeid: 'scope' },
  });
  expect(parseRouteLocation('https://deck.invalid/toolbox').section).toBe('toolbox');
  expect(buildFlightDeckDocumentTitle({ section: 'toolbox', workspaceLabel: 'Team' })).toContain('Toolbox | Team');
});

it('retains the saved placement when storage fails and can retry', async () => {
  await saveSettings({ backendUrl: 'https://tower.invalid' });
  const s = store(), app = s.toolboxApps[0];
  const fail = vi.spyOn(getSharedDb().app_settings, 'update').mockRejectedValueOnce(new Error('Storage unavailable'));
  await s.setAppPlacement(app, false);
  expect(s.isAppPlaced(app)).toBe(true);
  expect(s.appPlacementError).toBe('Storage unavailable');
  expect(s.appPlacementSaving).toBe(false);
  fail.mockRestore();
  await s.setAppPlacement(app, false); expect(s.isAppPlaced(app)).toBe(false);
});

it('finishes an in-flight save only in its captured workspace partition', async () => {
  const s = store(), partition = s.appPlacementPartition;
  const saving = s.setAppPlacement(s.toolboxApps[1], false);
  s.currentWorkspaceKey = 'tower/workspace-b';
  await saving;
  expect(s.visibleApps).toHaveLength(2); expect(s.appPlacementNotice).toBe('');
  expect((await getSettings()).appPlacements[partition]['napplet:message-activity']).toBe(false);
});
