import { describe, expect, it } from 'vitest';
import { scopesManagerMixin } from '../src/scopes-manager.js';
import { channelsManagerMixin } from '../src/channels-manager.js';
import { taskBoardStateMixin } from '../src/task-board-state.js';

function navigationStore() {
  const store = Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(taskBoardStateMixin),
    ...Object.getOwnPropertyDescriptors(channelsManagerMixin),
    ...Object.getOwnPropertyDescriptors(scopesManagerMixin),
  });
  return Object.assign(store, {
    session: { npub: 'reader' },
    currentWorkspace: { workspaceId: 'workspace', pgMe: { actor: { id: 'actor', npub: 'reader' } } },
    personalScopeOrder: { workspace_id: 'workspace', actor_id: 'actor', scope_ids: ['apps', 'prt', 'other'] },
    scopes: [
      { record_id: 'other', title: 'Other', level: 'l1', parent_id: null },
      { record_id: 'prt', title: 'PRT', level: 'l1', parent_id: null },
      { record_id: 'apps', title: 'Petes Applications', level: 'l1', parent_id: null },
      { record_id: 'new', title: 'Unordered', level: 'l1', parent_id: null },
    ],
    channels: [
      { record_id: 'second', title: 'Second', scope_id: 'prt', position: 2 },
      { record_id: 'first', title: 'First', scope_id: 'prt', position: 1 },
    ],
    tasks: [], scopePickerQuery: '',
  });
}
const ids = rows => rows.map(row => row.record_id);
const sidebarIds = store => ids(store.sidebarScopeChannelGroups.map(group => group.scope));
const boardIds = store => store.taskBoards.filter(board => store.scopes.some(scope => scope.record_id === board.id)).map(board => board.id);
const deckIds = store => store.flightDeckScopeOptions.filter(board => store.scopes.some(scope => scope.record_id === board.id)).map(board => board.id);

describe('personal scope order on connected navigation projections', () => {
  it('applies the saved sibling order across management, sidebar and pickers without reparenting or changing channel positions', () => {
    const store = navigationStore();
    const before = structuredClone({ scopes: store.scopes, channels: store.channels });
    const expected = ['apps', 'prt', 'other', 'new'];
    expect(ids(store.scopeTree)).toEqual(expected);
    expect(sidebarIds(store)).toEqual(expected);
    expect(ids(store.scopePickerFlat)).toEqual(expected);
    expect(ids(store.scopePickerFlatFor(''))).toEqual(expected);
    expect(boardIds(store)).toEqual(expected);
    expect(deckIds(store)).toEqual(expected);
    expect(ids(store.sidebarScopeChannelGroups[1].channels)).toEqual(['first', 'second']);
    expect({ scopes: store.scopes, channels: store.channels }).toEqual(before);
    store.personalScopeOrder = { ...store.personalScopeOrder, scope_ids: ['other', 'apps', 'prt'] };
    expect(sidebarIds(store)).toEqual(['other', 'apps', 'prt', 'new']);
    expect(deckIds(store)).toEqual(['other', 'apps', 'prt', 'new']);
    store.scopePickerQuery = 'p';
    expect(ids(store.scopePickerFlat)).toEqual(['apps', 'prt']);
  });

  it.each(['actor_id', 'workspace_id'])('ignores a stale or foreign %s on every projection', key => {
    const store = navigationStore();
    store.personalScopeOrder[key] = 'other';
    expect(sidebarIds(store)).toEqual(['other', 'prt', 'apps', 'new']);
    expect(ids(store.scopePickerFlat)).toEqual(['other', 'prt', 'apps', 'new']);
    // Existing alphabetical fallback remains intact for board/Deck selectors.
    expect(boardIds(store)).toEqual(['other', 'apps', 'prt', 'new']);
    expect(deckIds(store)).toEqual(['other', 'apps', 'prt', 'new']);
  });

  it('retains saved parent links and special navigation while only ordering siblings in the management tree', () => {
    const store = navigationStore();
    store.scopes.push(
      { record_id: 'child', title: 'Child', level: 'l2', parent_id: 'apps' },
      { record_id: 'dm', title: 'DMs', level: 'l1', pg_kind: 'dm' },
      { record_id: 'deleted', title: 'Deleted', level: 'l1', record_state: 'deleted' },
    );
    store.personalScopeOrder.scope_ids = ['child', 'apps', 'deleted', 'prt', 'other'];
    expect(ids(store.scopeTree)).toEqual(['apps', 'prt', 'other', 'new', 'dm']);
    expect(ids(store.scopeTree[0].children)).toEqual(['child']);
    expect(sidebarIds(store)).toEqual(['dm', 'apps', 'prt', 'other', 'new', 'child']);
    expect(store.flightDeckScopeOptions[0].id).toBe('__all__');
    expect(store.flightDeckScopeOptions[1].id).toBe('dm');
    expect(store.scopes.find(scope => scope.record_id === 'prt').parent_id).toBeNull();
  });
});
