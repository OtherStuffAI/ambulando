// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { channelsManagerMixin } from '../src/channels-manager.js';
const makeStore = (workspaceId = 'workspace-a') => ({
  ...channelsManagerMixin, sidebarScopeExpansion: {}, currentWorkspace: { workspaceId },
  selectedChannelId: 'selected', pgContextSelectedChannelId: 'selected',
});
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it('defaults expanded, persists reloads and preserves the selected channel', () => {
  const s = makeStore();
  expect(s.isSidebarScopeExpanded('scope')).toBe(true);
  s.toggleSidebarScope('scope');
  expect(makeStore().isSidebarScopeExpanded('scope')).toBe(false);
  expect(s.selectedChannelId).toBe('selected');
  expect(s.pgContextSelectedChannelId).toBe('selected');
  s.toggleSidebarScope('scope');
  expect(makeStore().isSidebarScopeExpanded('scope')).toBe(true);
});
it('isolates stable workspace and scope IDs across switches and renamed scopes', () => {
  const s = makeStore(); s.toggleSidebarScope('scope');
  expect(s.isSidebarScopeExpanded('other')).toBe(true);
  s.currentWorkspace = { workspaceId: 'workspace-b' };
  expect(s.isSidebarScopeExpanded('scope')).toBe(true);
  s.currentWorkspace = { workspaceId: 'workspace-a', name: 'Renamed' };
  expect(s.isSidebarScopeExpanded('scope')).toBe(false);
});
it.each(['{', 'null', '0', '"false"', '{}', '[]'])('treats malformed or unexpected storage %s as expanded', value => {
  const s = makeStore(); localStorage.setItem(s.sidebarScopePreferenceKey('scope'), value);
  expect(s.isSidebarScopeExpanded('scope')).toBe(true);
});
it('continues toggling in memory when storage access throws', () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const s = makeStore();
  expect(s.isSidebarScopeExpanded('scope')).toBe(true);
  s.toggleSidebarScope('scope'); expect(s.isSidebarScopeExpanded('scope')).toBe(false);
  s.toggleSidebarScope('scope'); expect(s.isSidebarScopeExpanded('scope')).toBe(true);
});
it('does not save an ambiguous preference without workspace or scope identity', () => {
  const s = makeStore(''); s.toggleSidebarScope('scope');
  expect(s.sidebarScopePreferenceKey('scope')).toBe('');
  expect(s.sidebarScopeExpansion).toEqual({});
  expect(s.isSidebarScopeExpanded('scope')).toBe(true);
});
