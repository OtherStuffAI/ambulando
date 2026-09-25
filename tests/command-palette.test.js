import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { commandPaletteMixin, createCommandPaletteState } from '../src/command-palette.js';
import { ALL_TASK_BOARD_ID } from '../src/task-board-state.js';

const indexPath = path.resolve(import.meta.dirname, '..', 'index.html');
const indexSource = fs.readFileSync(indexPath, 'utf-8');
const stylesPath = path.resolve(import.meta.dirname, '..', 'src', 'styles.css');
const stylesSource = fs.readFileSync(stylesPath, 'utf-8');
const originalWindow = globalThis.window;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
});

function stubWindow(windowMock) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: windowMock,
  });
}

function applyPalette(store) {
  Object.defineProperties(store, Object.getOwnPropertyDescriptors(commandPaletteMixin));
  return store;
}

function createStore(overrides = {}) {
  return applyPalette({
    ...createCommandPaletteState(),
    isLoggedIn: true,
    selectedBoardId: null,
    selectedBoardScope: null,
    scopes: [],
    scopesMap: new Map(),
    selectedBoardLabel: 'Scope board',
    channels: [],
    documents: [],
    session: { npub: 'npub-me' },
    workspaceOwnerNpub: 'npub-owner',
    botNpub: 'npub-bot',
    defaultAgentNpub: 'npub-agent',
    commandPaletteIndex: [],
    navSection: 'status',
    getChannelLabel: (channel) => channel.title || channel.label || channel.record_id,
    getSenderName: (npub) => (npub === 'npub-agent' ? 'agent-b' : npub),
    getScopeBreadcrumb: (scopeId) => `Business > ${scopeId}`,
    scopeLevelLabel: (level) => String(level || '').toUpperCase(),
    getTaskBoardLabel: (record) => `Scope ${record.scope_id}`,
    getFlightDeckReportTypeLabel: () => 'Report',
    getReportMetricLabel: () => 'Metric',
    refreshCommandPaletteIndex: vi.fn(async () => {}),
    refreshScopes: vi.fn(async () => {}),
    refreshTasks: vi.fn(async () => {}),
    refreshChannels: vi.fn(async () => {}),
    refreshDocuments: vi.fn(async () => {}),
    refreshDirectories: vi.fn(async () => {}),
    refreshFlows: vi.fn(async () => {}),
    refreshApprovals: vi.fn(async () => {}),
    refreshReports: vi.fn(async () => {}),
    persistSelectedBoardId: vi.fn(),
    validateSelectedBoardId: vi.fn(),
    normalizeTaskFilterTags: vi.fn(),
    clearSelectedTasks: vi.fn(),
    closeTaskDetail: vi.fn(async () => {}),
    closeDocEditor: vi.fn(),
    navigateTo: vi.fn(),
    openTaskDetail: vi.fn(),
    openDoc: vi.fn(),
    navigateToFolder: vi.fn(),
    selectChannel: vi.fn(async () => {}),
    openThread: vi.fn(),
    openFlowEditor: vi.fn(),
    openReportModalById: vi.fn(),
    syncRoute: vi.fn(),
    openNewChannelModal: vi.fn(),
    createBotDm: vi.fn(async () => {}),
    createDocument: vi.fn(async () => {}),
    addTask: vi.fn(async () => ({ record_id: 'task-new' })),
    buildTaskBoardAssignment: vi.fn((scopeId) => ({ scope_id: scopeId, group_ids: ['group-default'] })),
    handleInlineImagePaste: vi.fn(async () => {}),
    containsInlineImageUploadToken: vi.fn((value) => String(value || '').includes('[ Uploading image')),
    filterFlightDeckScopeOptions: vi.fn(() => []),
    isFlightDeckScopeOptionActive: vi.fn(() => false),
    selectWorkContextScope: vi.fn(),
    recentFocusAreas: [],
    $nextTick: (fn) => fn(),
    ...overrides,
  });
}

function captureCommandPaletteKeydown(store) {
  let handler = null;
  stubWindow({
    addEventListener: vi.fn((eventName, callback) => {
      if (eventName === 'keydown') handler = callback;
    }),
    setTimeout: vi.fn((callback) => { callback(); return 1; }),
    clearTimeout: vi.fn(),
  });
  store.initCommandPaletteShortcuts();
  return (key, overrides = {}) => {
    const event = {
      key,
      code: `Digit${key}`,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
      ...overrides,
    };
    handler(event);
    return event;
  };
}

describe('command palette launchers', () => {
  it('opens from the Flight Deck logo instead of routing the logo directly', () => {
    expect(indexSource).toContain("@click=\"if ($store.chat.isLoggedIn) $store.chat.openCommandPalette()\"");
    expect(indexSource).not.toContain('mobile-radar');
  });

  it('renders quick launch items as compact favorites with icon shortcut labels', () => {
    expect(indexSource).toContain('command-palette-results-quick');
    expect(indexSource).toContain('command-palette-group-quick');
    expect(indexSource).toContain('command-palette-result-icon-svg');
    expect(indexSource).toContain('getCommandPaletteIconSvg(item.icon || item.group)');
    expect(indexSource).toContain('command-palette-result-icon-key');
    expect(indexSource).not.toContain('command-palette-result-key');
    expect(stylesSource).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(stylesSource).toContain('.command-palette-group-quick .command-palette-result-icon-key');
    expect(stylesSource).not.toContain('min-height: 9.25rem;');
  });

  it('renders a compact visual shortcut overlay near the top right', () => {
    expect(indexSource).toContain('showCommandPaletteShortcutOverlay && !$store.chat.showCommandPalette');
    expect(indexSource).toContain('commandPaletteShortcutOverlayItems');
    expect(indexSource).toContain('Command palette shortcuts');
    expect(stylesSource).toContain('.command-shortcut-overlay');
    expect(stylesSource).toContain('top: 0.85rem;');
    expect(stylesSource).toContain('right: 0.85rem;');
  });

  it('uses SVG icons for command palette items', () => {
    const store = createStore();

    expect(store.getCommandPaletteIconSvg('bot')).toContain('<svg');
    expect(store.getCommandPaletteIconSvg('bot')).toContain('<rect');
    expect(store.getCommandPaletteIconSvg('missing')).toContain('<path d="M9 18l6-6-6-6">');
  });

  it('renders a two-line New Work description field with image paste handling', () => {
    expect(indexSource).toContain('x-model="$store.chat.commandPaletteNewWorkDescription"');
    expect(indexSource).toContain('rows="2"');
    expect(indexSource).toContain('@paste="$store.chat.handleCommandPaletteNewWorkDescriptionPaste($event)"');
  });

  it('registers Command/Super+J to open the palette in capture phase', () => {
    let handler = null;
    const windowMock = {
      addEventListener: vi.fn((eventName, callback) => {
        if (eventName === 'keydown') handler = callback;
      }),
    };
    stubWindow(windowMock);
    const openCommandPalette = vi.fn();
    const store = createStore();
    store.openCommandPalette = openCommandPalette;

    store.initCommandPaletteShortcuts();
    handler({
      key: 'j',
      code: 'KeyJ',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
    });

    expect(windowMock.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(openCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('keeps Command/Super+K as a best-effort shortcut', () => {
    let handler = null;
    const preventDefault = vi.fn();
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        if (eventName === 'keydown') handler = callback;
      }),
    });
    const store = createStore();
    store.openCommandPalette = vi.fn();

    store.initCommandPaletteShortcuts();
    handler({
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      target: { closest: () => ({ tagName: 'INPUT' }) },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(store.openCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('supports Ctrl+Shift+K as a fallback shortcut', () => {
    let handler = null;
    const preventDefault = vi.fn();
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        if (eventName === 'keydown') handler = callback;
      }),
    });
    const store = createStore();
    store.openCommandPalette = vi.fn();

    store.initCommandPaletteShortcuts();
    handler({
      key: 'k',
      code: 'KeyK',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
      target: { closest: () => ({ tagName: 'TEXTAREA' }) },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(store.openCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('supports Ctrl+J inside editable fields', () => {
    let handler = null;
    const preventDefault = vi.fn();
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        if (eventName === 'keydown') handler = callback;
      }),
    });
    const store = createStore();
    store.openCommandPalette = vi.fn();

    store.initCommandPaletteShortcuts();
    handler({
      key: 'j',
      code: 'KeyJ',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      target: { closest: () => ({ tagName: 'INPUT' }) },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(store.openCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('does not open for plain K in editable fields', () => {
    let handler = null;
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        if (eventName === 'keydown') handler = callback;
      }),
    });
    const store = createStore();
    store.openCommandPalette = vi.fn();

    store.initCommandPaletteShortcuts();
    handler({
      key: 'k',
      code: 'KeyK',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      target: { closest: () => ({ tagName: 'INPUT' }) },
      preventDefault: vi.fn(),
    });

    expect(store.openCommandPalette).not.toHaveBeenCalled();
  });

  it('shows the visual shortcut overlay after holding Super for about two seconds', () => {
    const handlers = {};
    let scheduledTimer = null;
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        handlers[eventName] = callback;
      }),
      setTimeout: vi.fn((callback, delay) => {
        scheduledTimer = { callback, delay };
        return 7;
      }),
      clearTimeout: vi.fn((timer) => clearTimeout(timer)),
    });
    const store = createStore();

    store.initCommandPaletteShortcuts();
    handlers.keydown({
      key: 'Meta',
      code: 'MetaLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
    });

    expect(scheduledTimer.delay).toBe(2000);
    expect(store.showCommandPaletteShortcutOverlay).toBe(false);
    scheduledTimer.callback();
    expect(store.showCommandPaletteShortcutOverlay).toBe(true);
  });

  it('cancels the visual shortcut overlay when Super is released before the hold delay', () => {
    const handlers = {};
    let scheduledTimer = null;
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        handlers[eventName] = callback;
      }),
      setTimeout: vi.fn((callback, delay) => {
        scheduledTimer = { callback, delay };
        return 7;
      }),
      clearTimeout: vi.fn((timer) => clearTimeout(timer)),
    });
    const store = createStore();

    store.initCommandPaletteShortcuts();
    handlers.keydown({
      key: 'Meta',
      code: 'MetaLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
    });
    handlers.keyup({
      key: 'Meta',
      code: 'MetaLeft',
    });
    scheduledTimer.callback();

    expect(store.showCommandPaletteShortcutOverlay).toBe(false);
  });

  it('dismisses the visual shortcut overlay on blur', () => {
    const handlers = {};
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        handlers[eventName] = callback;
      }),
    });
    const store = createStore({ showCommandPaletteShortcutOverlay: true });

    store.initCommandPaletteShortcuts();
    handlers.blur();

    expect(store.showCommandPaletteShortcutOverlay).toBe(false);
  });

  it('hides the visual shortcut overlay when the palette opens from Super+K', () => {
    let handler = null;
    const preventDefault = vi.fn();
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        if (eventName === 'keydown') handler = callback;
      }),
    });
    const store = createStore({ showCommandPaletteShortcutOverlay: true });
    store.openCommandPalette = vi.fn();

    store.initCommandPaletteShortcuts();
    handler({
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(store.showCommandPaletteShortcutOverlay).toBe(false);
    expect(store.openCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('executes quick launch items with number keys while the palette is open', async () => {
    let handler = null;
    const preventDefault = vi.fn();
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => {
        if (eventName === 'keydown') handler = callback;
      }),
    });
    const store = createStore({ showCommandPalette: true });
    store.executeCommandPaletteItem = vi.fn(async () => {});

    store.initCommandPaletteShortcuts();
    handler({
      key: '2',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(store.executeCommandPaletteItem).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Scope Switcher',
      shortcutKey: '2',
    }));
  });

  it('leaves number 5 as ordinary palette input', () => {
    let handler = null;
    const preventDefault = vi.fn();
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => { if (eventName === 'keydown') handler = callback; }),
      setTimeout: vi.fn((callback) => { callback(); return 1; }),
      clearTimeout: vi.fn(),
    });
    const store = createStore({ showCommandPalette: true });
    store.initCommandPaletteShortcuts();
    handler({ key: '5', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(store.showCommandPalette).toBe(true);
  });

  it('does not run root quick-launch numbers while choosing a scope', () => {
    let handler = null;
    stubWindow({
      addEventListener: vi.fn((eventName, callback) => { if (eventName === 'keydown') handler = callback; }),
      setTimeout: vi.fn((callback) => { callback(); return 1; }),
      clearTimeout: vi.fn(),
    });
    const store = createStore({ showCommandPalette: true, commandPaletteMode: 'scope' });
    store.executeCommandPaletteItem = vi.fn();
    store.initCommandPaletteShortcuts();
    handler({ key: '2', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, preventDefault: vi.fn() });
    expect(store.executeCommandPaletteItem).not.toHaveBeenCalled();
  });

  it('supports the full Super+K, 2, 3 sequence without selecting on scope-mode entry', async () => {
    const options = ['Alpha', 'Beta', 'Gamma'].map((label, index) => ({ id: `scope-${index + 1}`, label }));
    const selectWorkContextScope = vi.fn();
    const store = createStore({
      filterFlightDeckScopeOptions: vi.fn(() => options),
      selectWorkContextScope,
    });
    store.refreshCommandPaletteIndex = vi.fn(async () => {});
    const keydown = captureCommandPaletteKeydown(store);

    keydown('k', { code: 'KeyK', metaKey: true });
    keydown('2');
    expect(store.commandPaletteMode).toBe('scope');
    expect(selectWorkContextScope).not.toHaveBeenCalled();

    keydown('3');
    await vi.waitFor(() => expect(selectWorkContextScope).toHaveBeenCalledWith('scope-3'));
    expect(store.showCommandPalette).toBe(false);
  });

  it('maps visible scope shortcuts as 1 through 9 then 0 and leaves later scopes unassigned', () => {
    const options = Array.from({ length: 12 }, (_, index) => ({ id: `scope-${index + 1}`, label: `Scope ${index + 1}` }));
    const store = createStore({
      showCommandPalette: true,
      commandPaletteMode: 'scope',
      filterFlightDeckScopeOptions: vi.fn(() => options),
    });

    expect(store.commandPaletteScopeItems.map((item) => item.shortcutKey)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '', '',
    ]);
  });

  it('uses filtered visible order and treats an unassigned digit as a no-op', async () => {
    const allOptions = Array.from({ length: 12 }, (_, index) => ({ id: `scope-${index + 1}`, label: `Team ${index + 1}` }));
    const selectWorkContextScope = vi.fn();
    const store = createStore({
      showCommandPalette: true,
      commandPaletteMode: 'scope',
      commandPaletteQuery: '1',
      filterFlightDeckScopeOptions: vi.fn((query) => allOptions.filter((item) => item.label.includes(query))),
      selectWorkContextScope,
    });
    const keydown = captureCommandPaletteKeydown(store);

    expect(store.commandPaletteScopeItems.map((item) => item.scopeId)).toEqual(['scope-1', 'scope-10', 'scope-11', 'scope-12']);
    keydown('2');
    await vi.waitFor(() => expect(selectWorkContextScope).toHaveBeenCalledWith('scope-10'));

    store.showCommandPalette = true;
    store.commandPaletteMode = 'scope';
    store.commandPaletteQuery = '1';
    selectWorkContextScope.mockClear();
    const event = keydown('9');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(selectWorkContextScope).not.toHaveBeenCalled();
  });

  it('ignores scope number shortcuts during composition or with modifiers and outside scope mode', () => {
    const selectWorkContextScope = vi.fn();
    const store = createStore({
      showCommandPalette: true,
      commandPaletteMode: 'scope',
      filterFlightDeckScopeOptions: vi.fn(() => [{ id: 'scope-1', label: 'Alpha' }]),
      selectWorkContextScope,
    });
    const keydown = captureCommandPaletteKeydown(store);

    for (const overrides of [
      { isComposing: true },
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      const event = keydown('1', overrides);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    store.commandPaletteMode = 'root';
    store.commandPaletteQuery = 'filtering disables root shortcuts';
    const outsideEvent = keydown('1');
    expect(outsideEvent.preventDefault).not.toHaveBeenCalled();
    expect(selectWorkContextScope).not.toHaveBeenCalled();
  });
});

describe('command palette defaults and search', () => {
  it('keeps the four quick launch favorites first before typing', () => {
    const store = createStore({
      selectedBoardScope: { record_id: 'scope-a', title: 'Apollo' },
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Apollo' }]]),
    });

    const titles = store.commandPaletteFlatResults.map((item) => item.title);

    expect(titles.slice(0, 4)).toEqual(["What's on", 'Scope Switcher', 'New Work', 'Quick Doc']);
    expect(store.commandPaletteFlatResults.slice(0, 4).map((item) => item.shortcutKey)).toEqual(['1', '2', '3', '4']);
  });

  it('keeps visual shortcut overlay labels aligned with quick launch actions', () => {
    const store = createStore();

    expect(store.commandPaletteShortcutOverlayItems).toEqual([
      { id: 'palette', keys: ['Super', 'K'], label: 'Palette' },
      { id: 'quick:whats-on', keys: ['Palette', '1'], label: 'Flight Deck all scopes' },
      { id: 'quick:scope-switcher', keys: ['Palette', '2'], label: 'Scope Switcher' },
      { id: 'quick:new-work', keys: ['Palette', '3'], label: 'Quick Task / New Work' },
      { id: 'quick:quick-doc', keys: ['Palette', '4'], label: 'Quick Doc' },
    ]);
  });

  it('shows the six most recent indexed records below quick launch before typing', () => {
    const store = createStore();
    store.commandPaletteIndex = Array.from({ length: 7 }, (_, index) => ({
      id: `task:${index}`,
      group: 'task',
      groupLabel: 'Tasks',
      title: `Task ${index}`,
      action: 'open-task',
      recordId: `task-${index}`,
      updatedTs: Date.parse(`2026-05-0${index + 1}T00:00:00Z`),
    }));

    expect(store.commandPaletteFlatResults.map((item) => item.title)).toEqual([
      "What's on",
      'Scope Switcher',
      'New Work',
      'Quick Doc',
      'Task 6',
      'Task 5',
      'Task 4',
      'Task 3',
      'Task 2',
      'Task 1',
    ]);
    expect(store.commandPaletteGroups.map((group) => group.label)).toEqual(['Shortcuts', 'Recent']);
  });

  it('groups searched enabled records and omits disabled surface results', () => {
    const store = createStore();
    store.commandPaletteIndex = store.buildCommandPaletteIndex({
      scopes: [{ record_id: 'scope-a', title: 'Apollo scope', level: 'l2', updated_at: '2026-05-05T00:00:00Z' }],
      directories: [{ record_id: 'dir-a', title: 'Apollo folder', updated_at: '2026-05-05T00:00:00Z' }],
      documents: [{ record_id: 'doc-a', title: 'Apollo plan', content: 'orbit', updated_at: '2026-05-05T00:00:00Z' }],
      tasks: [{ record_id: 'task-a', title: 'Apollo task', scope_id: 'scope-a', updated_at: '2026-05-05T00:00:00Z' }],
      channels: [{ record_id: 'chan-a', title: 'Apollo chat', scope_id: 'scope-a', updated_at: '2026-05-05T00:00:00Z' }],
      messages: [
        { record_id: 'msg-root', channel_id: 'chan-a', body: 'Apollo thread', updated_at: '2026-05-05T00:00:00Z' },
        { record_id: 'msg-reply', channel_id: 'chan-a', parent_message_id: 'msg-root', body: 'Reply', updated_at: '2026-05-05T00:00:00Z' },
      ],
      flows: [{ record_id: 'flow-a', title: 'Apollo flow', scope_id: 'scope-a', updated_at: '2026-05-05T00:00:00Z' }],
      approvals: [{ record_id: 'approval-a', title: 'Apollo approval', status: 'pending', updated_at: '2026-05-05T00:00:00Z' }],
      reports: [{ record_id: 'report-a', title: 'Apollo metric', updated_at: '2026-05-05T00:00:00Z' }],
    });
    store.commandPaletteQuery = 'apollo';

    const groupLabels = store.commandPaletteGroups.map((group) => group.label);

    expect(groupLabels).toEqual([
      'Scopes',
      'Docs',
      'Tasks',
      'Chat channels',
      'Chat threads',
    ]);
    expect(groupLabels).not.toEqual(expect.arrayContaining(['Flows', 'Approvals', 'Flight Deck']));
  });

  it('highlights query terms in escaped result snippets', () => {
    const store = createStore({ commandPaletteQuery: 'apollo' });
    expect(store.getCommandPaletteSubtitleHtml({ subtitle: '<Apollo> launch' })).toBe('&lt;<mark>Apollo</mark>&gt; launch');
  });

  it('prepends up to five ranked local matches while retaining ordinary type-ahead results', () => {
    const store = createStore({
      commandPaletteIndex: [
        { id: 'task:body', group: 'task', groupLabel: 'Tasks', title: 'Later', subtitle: 'Task body', searchText: 'Task body', recordId: 'body', updatedTs: 3 },
        { id: 'doc:prefix', group: 'doc', groupLabel: 'Docs', title: 'Task plan', subtitle: 'Document', recordId: 'prefix', updatedTs: 2 },
        { id: 'task:exact', group: 'task', groupLabel: 'Tasks', title: 'Task', subtitle: 'Task', recordId: 'exact', updatedTs: 1 },
      ],
    });
    store.commandPaletteQuery = 'task';
    store.handleCommandPaletteQueryInput();

    expect(store.commandPaletteGroups[0]).toMatchObject({
      id: 'search-local',
      label: 'Search results',
      items: [{ recordId: 'exact' }, { recordId: 'prefix' }, { recordId: 'body' }],
    });
    expect(store.commandPaletteGroups.slice(1).map((group) => group.label)).toEqual(['Shortcuts']);
    expect(store.commandPaletteFlatResults.map((item) => item.id)).toEqual(['task:exact', 'doc:prefix', 'task:body', 'quick:new-work']);
  });

  it('starts local free-text matching with the first typed character and caps results at five', () => {
    const store = createStore({
      commandPaletteIndex: Array.from({ length: 7 }, (_, index) => ({
        id: `task:${index}`,
        group: 'task',
        groupLabel: 'Tasks',
        title: `A task ${index}`,
        recordId: String(index),
        updatedTs: index,
      })),
    });
    store.commandPaletteQuery = 'a';
    store.handleCommandPaletteQueryInput();

    expect(store.commandPaletteLocalResults).toHaveLength(5);
    expect(store.commandPaletteGroups[0].id).toBe('search-local');
  });

  it('traverses the combined visible order and clears the query before closing', async () => {
    const store = createStore({
      showCommandPalette: true,
      commandPaletteIndex: [
        { id: 'task:a', group: 'task', groupLabel: 'Tasks', title: 'Apollo', recordId: 'a', action: 'open-task' },
        { id: 'task:b', group: 'task', groupLabel: 'Tasks', title: 'Apollo beta', recordId: 'b', action: 'open-task' },
      ],
    });
    store.commandPaletteQuery = 'apollo';
    store.handleCommandPaletteQueryInput();
    store.commandPaletteActiveId = 'task:a';
    store.moveCommandPaletteSelection(1);
    expect(store.commandPaletteActiveId).toBe('task:b');
    await store.selectCommandPaletteActiveItem();
    expect(store.openTaskDetail).toHaveBeenCalledWith('b');

    store.showCommandPalette = true;
    store.commandPaletteQuery = 'apollo';
    store.handleCommandPaletteEscape();
    expect(store.commandPaletteQuery).toBe('');
    expect(store.showCommandPalette).toBe(true);
    store.handleCommandPaletteEscape();
    expect(store.showCommandPalette).toBe(false);
  });

  it('opens scope mode from quick launch 2 and filters real store scope options', async () => {
    const options = [
      { id: 'all', label: 'All', meta: 'Everything' },
      { id: 'scope-ops', label: 'Operations', meta: 'Scope · 4 channels' },
      { id: 'scope-product', label: 'Product', meta: 'Scope · 2 channels' },
    ];
    const store = createStore({
      showCommandPalette: true,
      selectedBoardId: 'scope-ops',
      recentFocusAreas: [{ id: 'scope-product' }],
      filterFlightDeckScopeOptions: vi.fn((query) => options.filter((item) => item.label.toLowerCase().includes(String(query).toLowerCase()))),
      isFlightDeckScopeOptionActive: vi.fn((board) => board.id === 'scope-ops'),
    });

    await store.executeCommandPaletteItem(store.commandPaletteQuickLaunchItems[1]);
    expect(store.commandPaletteMode).toBe('scope');
    expect(store.commandPaletteScopeItems.map((item) => item.title)).toEqual(['All', 'Operations', 'Product']);
    expect(store.commandPaletteRecentScopeItems.map((item) => item.title)).toEqual(['Product']);
    expect(store.commandPaletteScopeItems.find((item) => item.title === 'Operations').active).toBe(true);

    store.commandPaletteQuery = 'prod';
    store.handleCommandPaletteQueryInput();
    expect(store.commandPaletteScopeItems.map((item) => item.title)).toEqual(['Product']);
  });

  it('navigates scope mode with arrows and selects through the canonical context path', async () => {
    const selectWorkContextScope = vi.fn();
    const store = createStore({
      showCommandPalette: true,
      commandPaletteMode: 'scope',
      filterFlightDeckScopeOptions: vi.fn(() => [
        { id: 'scope-a', label: 'Alpha' },
        { id: 'scope-b', label: 'Beta' },
      ]),
      selectWorkContextScope,
    });

    store.commandPaletteActiveId = 'scope-picker:scope-a';
    store.moveCommandPaletteSelection(1);
    expect(store.commandPaletteActiveId).toBe('scope-picker:scope-b');
    await store.selectCommandPaletteActiveItem();
    expect(selectWorkContextScope).toHaveBeenCalledWith('scope-b');
    expect(store.showCommandPalette).toBe(false);
  });

  it('returns from scope mode before closing and restores launcher focus on close', () => {
    const focus = vi.fn();
    const store = createStore({ showCommandPalette: true, commandPaletteMode: 'scope', commandPaletteReturnFocusTarget: { focus } });
    store.handleCommandPaletteEscape();
    expect(store.commandPaletteMode).toBe('root');
    expect(store.showCommandPalette).toBe(true);
    store.handleCommandPaletteEscape();
    expect(store.showCommandPalette).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  });

  it('routes desktop and mobile scope launchers into the same palette mode', () => {
    expect(indexSource.match(/openCommandPaletteScopeSwitcher\(\$event\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(indexSource).toContain('class="mobile-scope-trigger"');
    expect(indexSource).toContain('class="board-picker-typeahead-input channel-row-scope-input"');
    expect(indexSource).toContain('class="command-palette-scope-grid"');
    expect(indexSource).toContain('class="command-palette-scope-tile-key"');
    expect(stylesSource).toContain('.command-palette-scope-tile-key');
  });
});

describe('command palette actions', () => {
  it('opens the exact cross-scope channel instead of the target scope default', async () => {
    const calls = [];
    const store = createStore({
      selectedBoardId: 'scope-current',
      selectedChannelId: 'channel-current',
      refreshChannels: vi.fn(async function refreshChannels() {
        calls.push('refresh');
        this.channels = [
          { record_id: 'channel-word5', scope_id: 'scope-target' },
          { record_id: 'channel-book-of-sand', scope_id: 'scope-target' },
        ];
        if (this.selectedChannelId !== 'channel-book-of-sand') {
          this.selectedChannelId = 'channel-word5';
        }
      }),
      navigateTo: vi.fn(function navigateTo(section, options = {}) {
        calls.push(['navigate', section, options]);
        this.navSection = section;
        if (options.skipChatChannelSelection !== true) this.selectedChannelId = 'channel-word5';
      }),
      selectChannel: vi.fn(async function selectChannel(channelId, options) {
        calls.push(['select', channelId, options]);
        this.selectedChannelId = channelId;
      }),
      syncRoute: vi.fn(function syncRoute() {
        calls.push(['route', this.selectedBoardId, this.selectedChannelId]);
      }),
    });

    await store.runCommandPaletteAction({
      action: 'open-channel',
      channelId: 'channel-book-of-sand',
      scopeId: 'scope-target',
    });

    expect(store.selectedBoardId).toBe('scope-target');
    expect(store.selectedChannelId).toBe('channel-book-of-sand');
    expect(store.navigateTo).toHaveBeenCalledWith('chat', {
      syncRoute: false,
      skipChatChannelSelection: true,
    });
    expect(store.selectChannel).toHaveBeenCalledWith('channel-book-of-sand', { syncRoute: false });
    expect(calls.at(-1)).toEqual(['route', 'scope-target', 'channel-book-of-sand']);
  });

  it('opens the exact same-scope channel', async () => {
    const store = createStore({
      selectedBoardId: 'scope-a',
      selectedChannelId: 'channel-first',
      selectChannel: vi.fn(async function selectChannel(channelId) {
        this.selectedChannelId = channelId;
      }),
    });

    await store.runCommandPaletteAction({
      action: 'open-channel',
      channelId: 'channel-second',
      scopeId: 'scope-a',
    });

    expect(store.selectedChannelId).toBe('channel-second');
    expect(store.selectChannel).toHaveBeenCalledWith('channel-second', { syncRoute: false });
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });

  it('retains the requested channel while an async refresh reconciles scope defaults', async () => {
    let releaseRefresh;
    const refreshPending = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const store = createStore({
      selectedBoardId: 'scope-current',
      selectedChannelId: 'channel-current',
      refreshChannels: vi.fn(async function refreshChannels() {
        expect(this.selectedChannelId).toBe('channel-target');
        await refreshPending;
        this.selectedChannelId = 'channel-default';
      }),
      selectChannel: vi.fn(async function selectChannel(channelId) {
        this.selectedChannelId = channelId;
      }),
    });

    const navigation = store.runCommandPaletteAction({
      action: 'open-channel',
      channelId: 'channel-target',
      scopeId: 'scope-target',
    });
    await Promise.resolve();

    expect(store.selectedChannelId).toBe('channel-target');
    expect(store.selectChannel).not.toHaveBeenCalled();

    releaseRefresh();
    await navigation;

    expect(store.selectedChannelId).toBe('channel-target');
    expect(store.selectChannel).toHaveBeenCalledWith('channel-target', { syncRoute: false });
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });

  it('selects a scope and stays on the current Flight Deck surface', async () => {
    const store = createStore();

    await store.runCommandPaletteAction({
      action: 'select-scope',
      recordId: 'scope-a',
      scopeId: 'scope-a',
      title: 'Apollo',
    });

    expect(store.refreshScopes).toHaveBeenCalledTimes(1);
    expect(store.selectedBoardId).toBe('scope-a');
    expect(store.persistSelectedBoardId).toHaveBeenCalledWith('scope-a');
    expect(store.navigateTo).toHaveBeenCalledWith('status', { syncRoute: false });
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });

  it('selects a scope from tasks and stays on the task board', async () => {
    const store = createStore({
      navSection: 'tasks',
      showTaskDetail: true,
    });

    await store.runCommandPaletteAction({
      action: 'select-scope',
      recordId: 'scope-a',
      scopeId: 'scope-a',
      title: 'Marketing',
    });

    expect(store.selectedBoardId).toBe('scope-a');
    expect(store.clearSelectedTasks).toHaveBeenCalledTimes(1);
    expect(store.closeTaskDetail).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.navigateTo).toHaveBeenCalledWith('tasks', { syncRoute: false });
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });

  it('selects a scope from docs and stays on scoped docs', async () => {
    const store = createStore({
      navSection: 'docs',
      currentFolderId: 'folder-old',
    });

    await store.runCommandPaletteAction({
      action: 'select-scope',
      recordId: 'scope-a',
      scopeId: 'scope-a',
      title: 'Marketing',
    });

    expect(store.refreshDirectories).toHaveBeenCalledTimes(1);
    expect(store.refreshDocuments).toHaveBeenCalledTimes(1);
    expect(store.closeDocEditor).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.currentFolderId).toBeNull();
    expect(store.navigateTo).toHaveBeenCalledWith('docs', { syncRoute: false });
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });

  it('opens or creates a DM with the configured primary agent', async () => {
    const store = createStore({
      channels: [{
        record_id: 'chan-agent',
        participant_npubs: ['npub-me', 'npub-agent'],
      }],
    });

    await store.runCommandPaletteAction({ action: 'primary-agent-chat' });

    expect(store.refreshChannels).toHaveBeenCalledTimes(1);
    expect(store.navigateTo).toHaveBeenCalledWith('chat', { syncRoute: false });
    expect(store.selectChannel).toHaveBeenCalledWith('chan-agent');
    expect(store.createBotDm).not.toHaveBeenCalled();
  });

  it('creates a quick doc in the resolved default scope', async () => {
    const store = createStore({
      selectedBoardScope: { record_id: 'scope-a', title: 'Apollo' },
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Apollo' }]]),
    });

    await store.runCommandPaletteAction({ action: 'quick-doc' });

    expect(store.selectedBoardId).toBe('scope-a');
    expect(store.refreshDirectories).toHaveBeenCalledTimes(1);
    expect(store.refreshDocuments).toHaveBeenCalledTimes(1);
    expect(store.createDocument).toHaveBeenCalledWith('Untitled document', { scopeId: 'scope-a' });
  });

  it('opens a New Work modal and creates a scoped task through the existing task path', async () => {
    const store = createStore({
      selectedBoardScope: { record_id: 'scope-a', title: 'Apollo' },
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Apollo' }]]),
    });

    await store.runCommandPaletteAction({ action: 'new-work' });
    store.commandPaletteNewWorkTitle = 'Draft launch checklist';
    store.commandPaletteNewWorkDescription = 'Use the notes from today.';
    await store.createCommandPaletteNewWork();

    expect(store.showCommandPaletteNewWorkModal).toBe(false);
    expect(store.selectedBoardId).toBe('scope-a');
    expect(store.newTaskTitle).toBe('Draft launch checklist');
    expect(store.addTask).toHaveBeenCalledWith({ description: 'Use the notes from today.' });
    expect(store.navigateTo).toHaveBeenCalledWith('tasks', { syncRoute: false });
    expect(store.openTaskDetail).toHaveBeenCalledWith('task-new');
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });

  it('pastes images into the New Work description with the selected board groups', async () => {
    const pasteEvent = { type: 'paste' };
    const store = createStore({
      selectedBoardScope: { record_id: 'scope-a', title: 'Apollo' },
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Apollo', group_ids: ['group-scope'] }]]),
      buildTaskBoardAssignment: vi.fn(() => ({ scope_id: 'scope-a', group_ids: ['group-board'] })),
    });

    await store.runCommandPaletteAction({ action: 'new-work' });
    await store.handleCommandPaletteNewWorkDescriptionPaste(pasteEvent);

    expect(store.handleInlineImagePaste).toHaveBeenCalledWith(pasteEvent, {
      modelKey: 'commandPaletteNewWorkDescription',
      ownerNpub: 'npub-owner',
      accessGroupIds: ['group-board'],
      fileLabel: 'task',
    });
  });

  it('uses the configured default New Work board while keeping the modal board selectable', async () => {
    const store = createStore({
      selectedBoardScope: { record_id: 'scope-a', title: 'Apollo' },
      commandPaletteNewWorkDefaultScopeId: 'scope-b',
      scopesMap: new Map([
        ['scope-a', { record_id: 'scope-a', title: 'Apollo' }],
        ['scope-b', { record_id: 'scope-b', title: 'Operator A Scratch' }],
      ]),
    });

    await store.runCommandPaletteAction({ action: 'new-work' });
    expect(store.commandPaletteNewWorkScopeId).toBe('scope-b');

    store.commandPaletteNewWorkScopeId = 'scope-a';
    store.commandPaletteNewWorkTitle = 'Override board';
    await store.createCommandPaletteNewWork();

    expect(store.selectedBoardId).toBe('scope-a');
  });

  it('routes all-scope task board shortcuts through the all board', async () => {
    const store = createStore();

    await store.runCommandPaletteAction({
      action: 'all-tasks',
      scopeId: ALL_TASK_BOARD_ID,
    });

    expect(store.selectedBoardId).toBe(ALL_TASK_BOARD_ID);
    expect(store.refreshScopes).not.toHaveBeenCalled();
    expect(store.navigateTo).toHaveBeenCalledWith('tasks');
  });

  it('opens scoped records after applying their scope context', async () => {
    const store = createStore();

    await store.runCommandPaletteAction({
      action: 'open-task',
      recordId: 'task-a',
      scopeId: 'scope-a',
    });

    expect(store.refreshScopes).toHaveBeenCalledTimes(1);
    expect(store.selectedBoardId).toBe('scope-a');
    expect(store.refreshTasks).toHaveBeenCalledTimes(1);
    expect(store.navigateTo).toHaveBeenCalledWith('tasks', { syncRoute: false });
    expect(store.openTaskDetail).toHaveBeenCalledWith('task-a');
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });
});
