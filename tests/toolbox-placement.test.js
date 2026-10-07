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
    closePersonalWappsOverlay: vi.fn(), openMessageActivity: vi.fn(), openTowerUsage: vi.fn(), openPersonalWapp: vi.fn() };
  Object.defineProperties(s, Object.getOwnPropertyDescriptors(toolboxMixin));
  return s;
}
beforeEach(async () => { await getSharedDb().app_settings.clear(); });

it('defaults existing entries to Apps, deduplicates IDs and preserves launcher fields', () => {
  const s = store(); s.visiblePersonalWapps.push(s.visiblePersonalWapps[0]);
  expect(s.visibleApps.map(app => app.placementId)).toEqual(['wapp:artifact', 'napplet:message-activity', 'napplet:tower-usage']);
  expect(s.visibleApps[0]).toMatchObject({ launch_url: 'https://app.invalid/', sort_order: 5 });
});

it('persists each type across recreated stores without losing settings or concurrent partitions', async () => {
  await saveSettings({ backendUrl: 'https://tower.invalid' });
  const s = store();
  await s.setAppPlacement(s.toolboxApps[0], false);
  await s.setAppPlacement(s.toolboxApps[1], false);
  const restored = store(); restored.appPlacementPreferences = (await getSettings()).appPlacements;
  expect(restored.visibleApps.map(row => row.placementId)).toEqual(['napplet:tower-usage']);
  restored.currentWorkspaceKey = 'tower/workspace-b'; expect(restored.visibleApps).toHaveLength(3);
  restored.currentWorkspaceKey = s.currentWorkspaceKey;
  restored.currentPgActorId = 'bob'; expect(restored.visibleApps).toHaveLength(3);
  await Promise.all([
    saveAppPlacement(s.appPlacementPartition, 'wapp:other', false),
    saveAppPlacement(restored.appPlacementPartition, 'napplet:message-activity', false),
  ]);
  const settings = await getSettings();
  expect(settings.backendUrl).toBe('https://tower.invalid');
  expect(settings.appPlacements[s.appPlacementPartition]).toEqual({
    'wapp:artifact': { shown: false, visibility: 'everywhere' }, 'napplet:message-activity': { shown: false, visibility: 'everywhere' }, 'wapp:other': false,
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
  expect(s.visibleApps).toHaveLength(3);
  s.currentWorkspaceKey = 'tower/workspace-a'; expect(s.visibleApps.map(app => app.appType)).toEqual(['Napplet', 'Napplet']);
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
  expect(s.visibleApps).toHaveLength(3); expect(s.appPlacementNotice).toBe('');
  expect((await getSettings()).appPlacements[partition]['napplet:message-activity'].shown).toBe(false);
});


it.each(['WApp', 'Napplet'])('enforces %s scope/channel restrictions across context changes and reload, while keeping entries editable', async type => {
  const s = store();
  s.scopes = [{ record_id: 'scope-a' }, { record_id: 'scope-b' }];
  s.wappPublishingDestinationGroups = [{ scope_id: 'scope-a', channels: [{ channel_id: 'channel-a' }, { channel_id: 'channel-a2' }] }];
  const app = s.toolboxApps.find(app => app.appType === type);
  s.prepareAppPlacementEditor(app);
  s.personalWappFormTitle = app.title;
  s.personalWappFormIconUrl = 'https://app.invalid/custom.png';
  s.personalAppFormVisibility = 'scope'; s.personalAppFormScopeId = 'scope-a';
  await s.saveAppEditorPlacement(app.placementId);
  s.pgContextScopeId = 'scope-a'; expect(s.visibleApps.some(row => row.placementId === app.placementId)).toBe(true);
  s.pgContextSelectedChannelId = 'channel-a2'; expect(s.visibleApps.some(row => row.placementId === app.placementId)).toBe(true);
  s.pgContextScopeId = 'scope-b'; expect(s.visibleApps.some(row => row.placementId === app.placementId)).toBe(false);
  expect(s.toolboxApps.some(row => row.placementId === app.placementId)).toBe(true);
  s.personalAppFormVisibility = 'channel'; s.personalAppFormChannelId = 'channel-a';
  await s.saveAppEditorPlacement(app.placementId);
  s.appPlacementPreferences = (await getSettings()).appPlacements;
  s.pgContextSelectedChannelId = 'channel-a'; expect(s.visibleApps.some(row => row.placementId === app.placementId)).toBe(true);
  s.pgContextSelectedChannelId = 'channel-a2'; expect(s.visibleApps.some(row => row.placementId === app.placementId)).toBe(false);
  s.pgContextSelectedChannelId = 'channel-a'; s.wappPublishingDestinationGroups = [];
  expect(s.visibleApps.some(row => row.placementId === app.placementId)).toBe(false);
  s.prepareAppPlacementEditor(app); expect(s.personalAppFormChannelId).toBe('channel-a');
  s.currentPgActorId = 'other'; expect(s.appPlacement(app).visibility).toBe('everywhere');
  s.currentPgActorId = 'alice'; s.currentWorkspaceKey = 'other'; expect(s.appPlacement(app).visibility).toBe('everywhere');
});

it('migrates legacy hidden bool on edit without losing hidden state and moves napplet ahead of WApps', async () => {
  const s = store(); const app = s.toolboxApps.find(app => app.appType === 'Napplet');
  await saveAppPlacement(s.appPlacementPartition, app.placementId, false);
  s.appPlacementPreferences = (await getSettings()).appPlacements;
  s.prepareAppPlacementEditor(app); expect(s.personalAppFormShown).toBe(false);
  s.personalWappFormTitle = app.title;
  s.personalWappFormIconUrl = 'https://app.invalid/icon.png'; s.personalAppFormPosition = 1;
  await s.saveAppEditorPlacement(app.placementId);
  expect(s.toolboxApps[0]).toMatchObject({ placementId: app.placementId, icon_url: 'https://app.invalid/icon.png' });
  expect(s.visibleApps.map(app => app.appType)).toEqual(['WApp', 'Napplet']);
});

 it('persists custom napplet title without changing identity, metadata or other viewers', async () => {
  const s = store(), app = s.toolboxApps.find(app => app.appType === 'Napplet');
  s.prepareAppPlacementEditor(app);
  s.personalWappFormTitle = '  My activity  '; s.personalWappFormIconUrl = 'icon.png';
  s.personalAppFormShown = false; s.personalAppFormVisibility = 'channel'; s.personalAppFormChannelId = 'channel-a';
  await s.saveAppEditorPlacement(app.placementId);
  const restored = store(); restored.appPlacementPreferences = (await getSettings()).appPlacements;
  expect(restored.toolboxApps.find(app => app.appType === 'Napplet')).toMatchObject({ title: 'My activity', placementId: 'napplet:message-activity', icon_url: 'icon.png' });
  expect(restored.appPlacement(app)).toMatchObject({ shown: false, visibility: 'channel', channelId: 'channel-a', displayTitle: 'My activity' });
  expect(restored.messageActivityDisplayTitle).toBe('My activity');
  restored.currentPgActorId = 'bob'; expect(restored.messageActivityDisplayTitle).toBe('Message activity');
  restored.currentPgActorId = 'alice'; restored.currentWorkspaceKey = 'another'; expect(restored.messageActivityDisplayTitle).toBe('Message activity');
  s.personalWappFormTitle = '  ';
  await expect(s.saveAppEditorPlacement(app.placementId)).rejects.toThrow('Title is required');
  expect((await getSettings()).appPlacements[s.appPlacementPartition][app.placementId].displayTitle).toBe('My activity');
});

it('launches Tower Usage everywhere by default and keeps its editor identity separate', async () => {
  const s = store(), app = s.toolboxApps.find(row => row.placementId === 'napplet:tower-usage');
  expect(app.title).toBe('Tower Usage');
  for (const scope of ['scope-a', 'scope-b', null]) {
    s.pgContextScopeId = scope; s.openApp(app);
  }
  expect(s.openTowerUsage).toHaveBeenCalledTimes(3);
  s.prepareAppPlacementEditor(app);
  expect(s.personalAppEditingPlacementId).toBe('napplet:tower-usage');
  s.personalWappFormTitle = 'Storage'; s.personalWappFormIconUrl = '';
  await s.saveAppEditorPlacement(s.personalAppEditingPlacementId);
  expect(s.toolboxApps.find(row => row.placementId === app.placementId).title).toBe('Storage');
  expect(s.messageActivityDisplayTitle).toBe('Message activity');
  await s.setAppPlacement(app, false); s.openApp(app);
  expect(s.openTowerUsage).toHaveBeenCalledTimes(3);
});
