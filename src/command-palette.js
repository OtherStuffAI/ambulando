import {
  getChannelsByOwner,
  getDirectoriesByOwner,
  getDocumentsByOwner,
  getMessagesByChannel,
  getReportsByOwner,
  getScopesByOwner,
  getTasksByOwner,
} from './db.js';
import { isFlightDeckSurfaceDisabled } from './disabled-surfaces.js';
import { ALL_TASK_BOARD_ID } from './task-board-state.js';

const COMMAND_GROUP_LABELS = Object.freeze({
  shortcut: 'Shortcuts',
  scope: 'Scopes',
  doc: 'Docs',
  task: 'Tasks',
  channel: 'Chat channels',
  thread: 'Chat threads',
  command: 'Commands',
  report: 'Flight Deck',
  workroom: 'Workrooms',
});

const COMMAND_GROUP_ORDER = Object.freeze([
  'shortcut',
  'scope',
  'doc',
  'task',
  'channel',
  'thread',
  'command',
  'report',
  'workroom',
]);

const MAX_GROUP_RESULTS = 8;
const MAX_RECENT_RESULTS = 6;
const COMMAND_PALETTE_SHORTCUT_OVERLAY_DELAY_MS = 2000;
const COMMAND_PALETTE_SCOPE_SHORTCUT_KEYS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
const QUICK_DOC_SCOPE_STORAGE_KEY = 'flightdeck:quick-doc-default-scope-id';
const NEW_WORK_SCOPE_STORAGE_KEY = 'flightdeck:new-work-default-scope-id';
const SUPER_MODIFIER_KEYS = new Set(['meta', 'os', 'super', 'hyper']);
const COMMAND_PALETTE_ICON_SVG = {
  flightdeck: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.07 4.93A10 10 0 0 0 4.93 19.07"></path><path d="M4.93 4.93a10 10 0 0 1 14.14 14.14"></path><path d="M8.46 8.46a5 5 0 0 1 7.08 0"></path><path d="M15.54 15.54a5 5 0 0 1-7.08 0"></path><circle cx="12" cy="12" r="2"></circle></svg>',
  bot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M8 12h8"></path><path d="M12 8v8"></path></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path></svg>',
  scope: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M3 12h3"></path><path d="M18 12h3"></path><path d="M12 3v3"></path><path d="M12 18v3"></path><circle cx="12" cy="12" r="8"></circle></svg>',
  default: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg>',
};

function readStoredScopeId(key) {
  if (typeof window === 'undefined' || !window.localStorage) return '';
  return String(window.localStorage.getItem(key) || '').trim();
}

export function createCommandPaletteState() {
  return {
    showCommandPalette: false,
    commandPaletteMode: 'root',
    commandPaletteQuery: '',
    commandPaletteActiveId: '',
    commandPaletteIndex: [],
    commandPaletteLoading: false,
    commandPaletteNotice: '',
    commandPaletteLocalResults: [],
    commandPaletteGlobalResults: [],
    commandPaletteLocalLoading: false,
    commandPaletteGlobalLoading: false,
    commandPaletteLocalError: '',
    commandPaletteGlobalError: '',
    commandPaletteSearchTimer: null,
    commandPaletteSearchAbort: null,
    commandPaletteSearchRequestId: 0,
    commandPaletteShortcutHandler: null,
    commandPaletteShortcutKeyupHandler: null,
    commandPaletteShortcutBlurHandler: null,
    commandPaletteShortcutOverlayTimer: null,
    showCommandPaletteShortcutOverlay: false,
    commandPaletteQuickDocScopeId: readStoredScopeId(QUICK_DOC_SCOPE_STORAGE_KEY),
    commandPaletteNewWorkDefaultScopeId: readStoredScopeId(NEW_WORK_SCOPE_STORAGE_KEY),
    showCommandPaletteNewWorkModal: false,
    commandPaletteNewWorkTitle: '',
    commandPaletteNewWorkDescription: '',
    commandPaletteNewWorkScopeId: '',
    commandPaletteReturnFocusTarget: null,
  };
}

function scopeIdFromRecord(record = {}) {
  return record.scope_id
    ?? record.scope_l5_id
    ?? record.scope_l4_id
    ?? record.scope_l3_id
    ?? record.scope_l2_id
    ?? record.scope_l1_id
    ?? null;
}

function recordUpdatedTs(record = {}) {
  return Date.parse(record.updated_at || record.generated_at || '') || 0;
}

function compactText(parts = []) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesCommandPaletteQuery(item, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const haystack = compactText([
    item.title,
    item.subtitle,
    item.groupLabel,
    item.kindLabel,
    item.searchText,
  ]).toLowerCase();
  return needle.split(/\s+/).every((part) => haystack.includes(part));
}

function commandPaletteMatchRank(item, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle || !matchesCommandPaletteQuery(item, needle)) return needle ? null : 0;
  const title = String(item?.title || '').trim().toLowerCase();
  if (title === needle) return 0;
  if (title.startsWith(needle)) return 1;
  if (new RegExp(`(?:^|\\s)${escapeRegExp(needle)}(?:\\s|$)`).test(title)) return 2;
  if (title.includes(needle)) return 3;
  return 4;
}

function sortCommandPaletteMatches(query) {
  return (left, right) => commandPaletteMatchRank(left, query) - commandPaletteMatchRank(right, query)
    || sortByFreshness(left, right);
}

function commandPaletteRecordKey(item = {}) {
  if (item.identityKey) return item.identityKey;
  const recordId = String(item.recordId || item.threadId || item.channelId || '').trim();
  const group = String(item.group || '').trim();
  return recordId ? `${group}:${recordId}` : String(item.id || '');
}

function mergeCommandPaletteResults(localItems = [], serverItems = [], excludedKeys = new Set()) {
  const merged = [];
  const seen = new Set(excludedKeys);
  for (const item of [...localItems, ...serverItems]) {
    const key = commandPaletteRecordKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length === 5) break;
  }
  return merged;
}

function sortByFreshness(left, right) {
  return (right.updatedTs || 0) - (left.updatedTs || 0)
    || String(left.title || '').localeCompare(String(right.title || ''));
}

function groupItems(items = []) {
  const byGroup = new Map();
  for (const item of items) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push(item);
  }
  return COMMAND_GROUP_ORDER
    .filter((group) => byGroup.has(group))
    .map((group) => ({
      id: group,
      label: COMMAND_GROUP_LABELS[group] || group,
      items: byGroup.get(group).slice(0, MAX_GROUP_RESULTS),
    }))
    .filter((group) => group.items.length > 0);
}

function buildItem(input = {}) {
  const groupLabel = COMMAND_GROUP_LABELS[input.group] || input.group || '';
  return {
    groupLabel,
    kindLabel: groupLabel,
    updatedTs: 0,
    ...input,
  };
}

function isEditableShortcutTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

function isCommandPaletteOpenShortcut(event, key) {
  const code = String(event.code || '');
  const isK = key === 'k' || code === 'KeyK';
  const isJ = key === 'j' || code === 'KeyJ';
  if (event.altKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  if (event.metaKey && event.ctrlKey) return false;
  if (isJ && !event.shiftKey) return true;
  if (isK) return true;
  return false;
}

function isSuperModifierKey(event, key) {
  const code = String(event.code || '').toLowerCase();
  return SUPER_MODIFIER_KEYS.has(key)
    || code === 'metaleft'
    || code === 'metaright'
    || code === 'osleft'
    || code === 'osright';
}

function hasOnlySuperModifier(event, key) {
  return isSuperModifierKey(event, key)
    && !event.altKey
    && !event.ctrlKey
    && !event.shiftKey;
}

function setShortcutOverlayTimer(callback) {
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    return window.setTimeout(callback, COMMAND_PALETTE_SHORTCUT_OVERLAY_DELAY_MS);
  }
  return setTimeout(callback, COMMAND_PALETTE_SHORTCUT_OVERLAY_DELAY_MS);
}

function clearShortcutOverlayTimer(timer) {
  if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
    window.clearTimeout(timer);
    return;
  }
  clearTimeout(timer);
}

export const commandPaletteMixin = {
  get commandPalettePrimaryAgentNpub() {
    return String(this.defaultAgentNpub || this.botNpub || '').trim();
  },

  get commandPalettePrimaryAgentLabel() {
    const npub = this.commandPalettePrimaryAgentNpub;
    if (!npub) return 'primary agent';
    return this.getSenderName?.(npub) || 'primary agent';
  },

  get commandPaletteCurrentScopeLabel() {
    if (this.selectedBoardScope) {
      return this.selectedBoardScope.title || this.selectedBoardLabel || 'Current scope';
    }
    return '';
  },

  get commandPaletteQuickLaunchItems() {
    const quickDocScopeId = this.resolveCommandPaletteQuickDocScopeId();
    const quickDocScope = quickDocScopeId ? this.scopesMap?.get(quickDocScopeId) : null;
    return [
      buildItem({
        id: 'quick:whats-on',
        group: 'shortcut',
        title: "What's on",
        subtitle: 'Open Flight Deck across the business',
        action: 'all-flightdeck',
        scopeId: ALL_TASK_BOARD_ID,
        shortcutKey: '1',
        icon: 'flightdeck',
        searchText: 'status dashboard flight deck whats on what is on',
      }),
      buildItem({
        id: 'quick:scope-switcher',
        group: 'shortcut',
        title: 'Scope Switcher',
        subtitle: 'Change the active scope',
        action: 'scope-switcher',
        shortcutKey: '2',
        icon: 'scope',
        searchText: 'scope switcher change focus workspace context',
      }),
      buildItem({
        id: 'quick:new-work',
        group: 'shortcut',
        title: 'New Work',
        subtitle: 'Create a task in the current scope',
        action: 'new-work',
        shortcutKey: '3',
        icon: 'plus',
        searchText: 'create add task work todo',
      }),
      buildItem({
        id: 'quick:quick-doc',
        group: 'shortcut',
        title: 'Quick Doc',
        subtitle: quickDocScope?.title ? `Create in ${quickDocScope.title}` : 'Create in the default doc scope',
        action: 'quick-doc',
        scopeId: quickDocScopeId,
        shortcutKey: '4',
        icon: 'doc',
        searchText: 'create add document doc note',
      }),
    ];
  },

  get commandPaletteDefaultItems() {
    return this.commandPaletteQuickLaunchItems;
  },

  get commandPaletteShortcutOverlayItems() {
    const overlayLabels = {
      'all-flightdeck': 'Flight Deck all scopes',
      'scope-switcher': 'Scope Switcher',
      'new-work': 'Quick Task / New Work',
      'quick-doc': 'Quick Doc',
    };
    return [
      { id: 'palette', keys: ['Super', 'K'], label: 'Palette' },
      ...this.commandPaletteQuickLaunchItems
        .filter((item) => item.shortcutKey)
        .map((item) => ({
          id: item.id,
          keys: ['Palette', item.shortcutKey],
          label: overlayLabels[item.action] || item.title,
        })),
    ];
  },

  get commandPaletteRecentItems() {
    return [...(this.commandPaletteIndex || [])]
      .filter((item) => item?.id && item.group !== 'shortcut')
      .sort(sortByFreshness)
      .slice(0, MAX_RECENT_RESULTS);
  },

  get commandPaletteFlatResults() {
    const query = String(this.commandPaletteQuery || '').trim();
    const source = query
      ? [...this.commandPaletteDefaultItems, ...(this.commandPaletteIndex || [])]
      : [...this.commandPaletteDefaultItems, ...this.commandPaletteRecentItems];
    if (!query) return source.filter((item) => matchesCommandPaletteQuery(item, query));
    const ordinaryMatches = source
      .filter((item) => matchesCommandPaletteQuery(item, query))
      .sort((left, right) => {
        const groupDelta = COMMAND_GROUP_ORDER.indexOf(left.group) - COMMAND_GROUP_ORDER.indexOf(right.group);
        if (groupDelta) return groupDelta;
        if (query) return sortByFreshness(left, right);
        return 0;
      });
    const localResults = this.commandPaletteLocalResults || [];
    const localKeys = new Set(localResults.map(commandPaletteRecordKey));
    return [
      ...localResults,
      ...ordinaryMatches.filter((item) => !localKeys.has(commandPaletteRecordKey(item))),
    ];
  },

  getCommandPaletteIconSvg(icon) {
    return COMMAND_PALETTE_ICON_SVG[icon] || COMMAND_PALETTE_ICON_SVG.default;
  },

  getCommandPaletteSubtitleHtml(item = {}) {
    const escaped = escapeHtml(item.subtitle || '');
    const terms = String(this.commandPaletteQuery || '').trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return escaped;
    const matcher = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
    return escaped.replace(matcher, '<mark>$1</mark>');
  },

  get commandPaletteGroups() {
    if (!String(this.commandPaletteQuery || '').trim()) {
      const groups = [{
        id: 'shortcut',
        label: COMMAND_GROUP_LABELS.shortcut,
        items: this.commandPaletteQuickLaunchItems,
      }];
      if (this.commandPaletteRecentItems.length > 0) {
        groups.push({
          id: 'recent',
          label: 'Recent',
          items: this.commandPaletteRecentItems,
        });
      }
      return groups;
    }
    const localResults = this.commandPaletteLocalResults || [];
    const localKeys = new Set(localResults.map(commandPaletteRecordKey));
    const ordinaryGroups = groupItems(
      this.commandPaletteFlatResults.filter((item) => !localKeys.has(commandPaletteRecordKey(item))),
    );
    return localResults.length > 0
      ? [{ id: 'search-local', label: 'Search results', items: localResults }, ...ordinaryGroups]
      : ordinaryGroups;
  },

  get commandPaletteActiveItem() {
    const results = this.commandPaletteMode === 'scope' ? this.commandPaletteScopeItems : this.commandPaletteFlatResults;
    if (results.length === 0) return null;
    return results.find((item) => item.id === this.commandPaletteActiveId) || results[0];
  },

  initCommandPaletteShortcuts() {
    if (typeof window === 'undefined' || this.commandPaletteShortcutHandler) return;
    this.commandPaletteShortcutHandler = (event) => {
      if (event.defaultPrevented) return;
      const key = String(event.key || '').toLowerCase();
      if (isSuperModifierKey(event, key)) {
        this.scheduleCommandPaletteShortcutOverlay(event, key);
        return;
      }
      if (this.commandPaletteShortcutOverlayTimer || this.showCommandPaletteShortcutOverlay) {
        this.hideCommandPaletteShortcutOverlay();
      }
      if (this.showCommandPalette
        && this.commandPaletteMode === 'scope'
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
        && /^\d$/.test(key)) {
        event.preventDefault();
        const item = this.commandPaletteScopeItems.find((scope) => scope.shortcutKey === key);
        if (item) void this.executeCommandPaletteItem(item);
        return;
      }
      if (this.showCommandPalette
        && this.commandPaletteMode === 'root'
        && !this.commandPaletteQuery
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
        && /^[1-4]$/.test(key)) {
        const item = this.commandPaletteQuickLaunchItems[Number(key) - 1];
        if (!item) return;
        event.preventDefault();
        void this.executeCommandPaletteItem(item);
        return;
      }
      if (!isCommandPaletteOpenShortcut(event, key)) return;
      event.preventDefault();
      this.hideCommandPaletteShortcutOverlay();
      this.openCommandPalette();
    };
    this.commandPaletteShortcutKeyupHandler = (event) => {
      const key = String(event.key || '').toLowerCase();
      if (isSuperModifierKey(event, key)) this.hideCommandPaletteShortcutOverlay();
    };
    this.commandPaletteShortcutBlurHandler = () => {
      this.hideCommandPaletteShortcutOverlay();
    };
    window.addEventListener('keydown', this.commandPaletteShortcutHandler, true);
    window.addEventListener('keyup', this.commandPaletteShortcutKeyupHandler, true);
    window.addEventListener('blur', this.commandPaletteShortcutBlurHandler);
  },

  scheduleCommandPaletteShortcutOverlay(event, key) {
    if (!this.isLoggedIn || this.showCommandPalette || !hasOnlySuperModifier(event, key)) return;
    if (this.commandPaletteShortcutOverlayTimer) return;
    let timer = null;
    timer = setShortcutOverlayTimer(() => {
      if (this.commandPaletteShortcutOverlayTimer !== timer) return;
      this.commandPaletteShortcutOverlayTimer = null;
      if (!this.isLoggedIn || this.showCommandPalette) return;
      this.showCommandPaletteShortcutOverlay = true;
    });
    this.commandPaletteShortcutOverlayTimer = timer;
  },

  hideCommandPaletteShortcutOverlay() {
    if (this.commandPaletteShortcutOverlayTimer) {
      clearShortcutOverlayTimer(this.commandPaletteShortcutOverlayTimer);
      this.commandPaletteShortcutOverlayTimer = null;
    }
    this.showCommandPaletteShortcutOverlay = false;
  },

  async openCommandPalette(options = {}) {
    if (!this.isLoggedIn) return;
    this.hideCommandPaletteShortcutOverlay();
    if (!this.showCommandPalette && typeof document !== 'undefined') {
      this.commandPaletteReturnFocusTarget = options.launcher || document.activeElement || null;
    }
    this.commandPaletteMode = options.mode === 'scope' ? 'scope' : 'root';
    this.commandPaletteQuery = options.query ?? '';
    this.commandPaletteActiveId = '';
    this.commandPaletteNotice = '';
    this.showCommandPalette = true;
    this.focusCommandPaletteInput();
    if (this.commandPaletteMode === 'root') await this.refreshCommandPaletteIndex();
    this.focusCommandPaletteInput();
  },

  openCommandPaletteScopeSwitcher(event = null) {
    return this.openCommandPalette({ mode: 'scope', launcher: event?.currentTarget || null });
  },

  focusCommandPaletteInput() {
    const focus = () => {
      if (typeof document === 'undefined') return;
      const input = document.querySelector('[data-command-palette-input]');
      input?.focus();
      input?.select?.();
    };
    this.$nextTick?.(focus);
    if (typeof window !== 'undefined') window.setTimeout(focus, 0);
  },

  closeCommandPalette() {
    this.cancelCommandPaletteSearch();
    this.showCommandPalette = false;
    this.commandPaletteMode = 'root';
    this.commandPaletteQuery = '';
    this.commandPaletteActiveId = '';
    this.commandPaletteNotice = '';
    const returnTarget = this.commandPaletteReturnFocusTarget;
    this.commandPaletteReturnFocusTarget = null;
    this.$nextTick?.(() => returnTarget?.focus?.());
  },

  moveCommandPaletteSelection(delta) {
    const results = this.commandPaletteMode === 'scope' ? this.commandPaletteScopeItems : this.commandPaletteFlatResults;
    if (results.length === 0) return;
    const activeId = this.commandPaletteActiveItem?.id;
    const currentIndex = Math.max(0, results.findIndex((item) => item.id === activeId));
    const nextIndex = (currentIndex + delta + results.length) % results.length;
    this.commandPaletteActiveId = results[nextIndex].id;
  },

  async selectCommandPaletteActiveItem() {
    await this.executeCommandPaletteItem(this.commandPaletteActiveItem);
  },

  async refreshCommandPaletteIndex() {
    const ownerNpub = this.workspaceOwnerNpub;
    if (!ownerNpub) {
      this.commandPaletteIndex = [];
      return;
    }
    this.commandPaletteLoading = true;
    try {
      const [
        channels,
        directories,
        documents,
        tasks,
        scopes,
      ] = await Promise.all([
        getChannelsByOwner(ownerNpub),
        getDirectoriesByOwner(ownerNpub),
        getDocumentsByOwner(ownerNpub),
        getTasksByOwner(ownerNpub),
        getScopesByOwner(ownerNpub),
      ]);
      const [reports] = await Promise.all([
        isFlightDeckSurfaceDisabled('reports') ? [] : getReportsByOwner(ownerNpub),
      ]);
      const workrooms = this.workroomsEnabled !== false && typeof this.loadWorkroomRowsForPalette === 'function'
        ? await this.loadWorkroomRowsForPalette()
        : [];
      const channelMessages = await Promise.all(
        channels.map((channel) => getMessagesByChannel(channel.record_id)),
      );
      this.commandPaletteIndex = this.buildCommandPaletteIndex({
        channels,
        directories,
        documents,
        tasks,
        reports,
        scopes,
        messages: channelMessages.flat(),
        workrooms,
      });
    } finally {
      this.commandPaletteLoading = false;
    }
  },

  buildCommandPaletteIndex(records = {}) {
    const items = [];
    const channelById = new Map((records.channels || []).map((channel) => [channel.record_id, channel]));

    for (const scope of records.scopes || []) {
      items.push(buildItem({
        id: `scope:${scope.record_id}`,
        group: 'scope',
        title: scope.title || 'Untitled scope',
        subtitle: compactText([this.getScopeBreadcrumb?.(scope.record_id), this.scopeLevelLabel?.(scope.level)]),
        action: 'select-scope',
        recordId: scope.record_id,
        scopeId: scope.record_id,
        updatedTs: recordUpdatedTs(scope),
        searchText: compactText([scope.description, scope.level]),
      }));
    }

    for (const directory of records.directories || []) {
      items.push(buildItem({
        id: `doc:directory:${directory.record_id}`,
        group: 'doc',
        title: directory.title || 'Untitled folder',
        subtitle: 'Folder',
        action: 'open-doc',
        recordId: directory.record_id,
        docType: 'directory',
        scopeId: scopeIdFromRecord(directory),
        updatedTs: recordUpdatedTs(directory),
      }));
    }

    for (const document of records.documents || []) {
      items.push(buildItem({
        id: `doc:document:${document.record_id}`,
        group: 'doc',
        title: document.title || 'Untitled document',
        subtitle: 'Document',
        action: 'open-doc',
        recordId: document.record_id,
        docType: 'document',
        scopeId: scopeIdFromRecord(document),
        updatedTs: recordUpdatedTs(document),
        searchText: document.content || '',
      }));
    }

    for (const task of records.tasks || []) {
      items.push(buildItem({
        id: `task:${task.record_id}`,
        group: 'task',
        title: task.title || 'Untitled task',
        subtitle: task.scope_id ? this.getTaskBoardLabel?.(task) : 'Task',
        action: 'open-task',
        recordId: task.record_id,
        scopeId: scopeIdFromRecord(task),
        updatedTs: recordUpdatedTs(task),
        searchText: compactText([task.description, task.state, task.tags]),
      }));
    }

    for (const channel of records.channels || []) {
      items.push(buildItem({
        id: `channel:${channel.record_id}`,
        group: 'channel',
        title: this.getChannelLabel?.(channel) || channel.title || 'Chat channel',
        subtitle: channel.scope_id ? this.getScopeBreadcrumb?.(channel.scope_id) : 'Chat channel',
        action: 'open-channel',
        channelId: channel.record_id,
        scopeId: scopeIdFromRecord(channel),
        updatedTs: recordUpdatedTs(channel),
        searchText: compactText([channel.description, channel.label]),
      }));
    }

    for (const entry of records.workrooms || []) {
      const room = entry.room || entry;
      const participants = entry.participants || [];
      const events = entry.events || [];
      const links = entry.links || [];
      items.push(buildItem({
        id: `workroom:${room.record_id}`,
        group: 'workroom',
        title: room.title || 'Untitled workroom',
        subtitle: `${room.status || 'draft'}${room.repo?.name ? ` · ${room.repo.name}` : ''}`,
        action: 'open-workroom',
        recordId: room.record_id,
        scopeId: scopeIdFromRecord(room),
        updatedTs: recordUpdatedTs(room),
        icon: 'flightdeck',
        searchText: JSON.stringify({ room, participants, events, links }),
      }));
    }

    const repliesByParentId = new Map();
    for (const message of records.messages || []) {
      if (!message.parent_message_id) continue;
      repliesByParentId.set(message.parent_message_id, (repliesByParentId.get(message.parent_message_id) || 0) + 1);
    }
    for (const message of records.messages || []) {
      if (message.parent_message_id || !repliesByParentId.has(message.record_id)) continue;
      const channel = channelById.get(message.channel_id);
      items.push(buildItem({
        id: `thread:${message.record_id}`,
        group: 'thread',
        title: message.body || 'Untitled thread',
        subtitle: channel ? this.getChannelLabel?.(channel) || channel.title || 'Chat thread' : 'Chat thread',
        action: 'open-thread',
        recordId: message.record_id,
        channelId: message.channel_id,
        threadId: message.record_id,
        scopeId: scopeIdFromRecord(channel),
        updatedTs: recordUpdatedTs(message),
        searchText: `${repliesByParentId.get(message.record_id)} replies`,
      }));
    }

    if (!isFlightDeckSurfaceDisabled('reports')) {
      for (const report of records.reports || []) {
        items.push(buildItem({
          id: `report:${report.record_id}`,
          group: 'report',
          title: report.title || this.getReportMetricLabel?.(report) || 'Untitled report',
          subtitle: this.getFlightDeckReportTypeLabel?.(report) || 'Flight Deck report',
          action: 'open-report',
          recordId: report.record_id,
          scopeId: scopeIdFromRecord(report),
          updatedTs: recordUpdatedTs(report),
          searchText: compactText([report.declaration_type, report.surface]),
        }));
      }
    }

    return items.sort(sortByFreshness);
  },

  async executeCommandPaletteItem(item) {
    if (!item) return;
    if (item.action === 'scope-switcher') {
      this.commandPaletteMode = 'scope';
      this.commandPaletteQuery = '';
      this.commandPaletteActiveId = this.commandPaletteScopeItems.find((scope) => scope.active)?.id
        || this.commandPaletteScopeItems[0]?.id
        || '';
      this.focusCommandPaletteInput();
      return;
    }
    if (item.action === 'select-scope-context') {
      await Promise.resolve(this.selectWorkContextScope?.(item.scopeId));
      this.closeCommandPalette();
      return;
    }
    this.closeCommandPalette();
    await this.runCommandPaletteAction(item);
  },

  async runCommandPaletteAction(item) {
    if (item.scopeId && item.scopeId !== ALL_TASK_BOARD_ID) {
      await this.refreshScopes?.();
    }
    if (item.scopeId) this.applyCommandPaletteScope(item.scopeId);
    switch (item.action) {
      case 'all-flightdeck':
      case 'current-flightdeck':
        this.navigateTo('status');
        return;
      case 'all-tasks':
      case 'current-tasks':
        this.navigateTo('tasks');
        return;
      case 'current-docs':
        await this.refreshDirectories();
        await this.refreshDocuments();
        this.navigateTo('docs');
        return;
      case 'current-chat':
        await this.refreshChannels();
        this.navigateTo('chat');
        return;
      case 'new-task':
        if (typeof this.openNewTaskModal === 'function') {
          this.openNewTaskModal({ scopeId: item.scopeId || this.selectedBoardId || null });
          return;
        }
        await this.refreshTasks();
        this.navigateTo('tasks');
        this.$nextTick?.(() => document.querySelector('[data-new-task-input]')?.focus());
        return;
      case 'new-work':
        this.openCommandPaletteNewWorkModal();
        return;
      case 'primary-agent-chat':
        await this.openCommandPalettePrimaryAgentChat();
        return;
      case 'quick-doc':
        await this.createCommandPaletteQuickDoc();
        return;
      case 'open-file':
        this.fileBrowserSearch = item.title || '';
        this.navigateTo('files');
        return;
      case 'open-approval':
        await this.refreshApprovals?.();
        this.navigateTo('approvals');
        this.openApproval?.(item.recordId);
        return;
      case 'new-chat':
        await this.refreshChannels();
        this.navigateTo('chat');
        this.openNewChannelModal?.();
        return;
      case 'select-scope':
        this.applyCommandPaletteScope(item.recordId);
        this.commandPaletteNotice = `${item.title} is now the active scope.`;
        await this.navigateCommandPaletteScopeSelection();
        return;
      case 'open-doc':
        await this.refreshDirectories();
        await this.refreshDocuments();
        if (item.docType === 'directory') this.navigateToFolder(item.recordId);
        else this.openDoc(item.recordId);
        return;
      case 'open-task':
        await this.refreshTasks();
        this.navigateTo('tasks', { syncRoute: false });
        this.openTaskDetail(item.recordId);
        this.syncRoute();
        return;
      case 'open-channel':
        if (!item.channelId) return;
        this.selectedChannelId = item.channelId;
        await this.refreshChannels();
        this.navigateTo('chat', { syncRoute: false, skipChatChannelSelection: true });
        await this.selectChannel(item.channelId, { syncRoute: false });
        this.syncRoute();
        return;
      case 'open-thread':
        await this.refreshChannels();
        this.navigateTo('chat', { syncRoute: false });
        if (item.channelId) await this.selectChannel(item.channelId, { syncRoute: false });
        if (item.threadId) this.openThread(item.threadId, { scrollToLatest: false });
        this.syncRoute();
        return;
      case 'open-report':
        if (isFlightDeckSurfaceDisabled('reports')) return;
        await this.refreshReports();
        this.navigateTo('status', { syncRoute: false });
        this.openReportModalById?.(item.recordId);
        this.syncRoute();
        return;
      case 'open-workroom':
        if (this.workroomsEnabled === false) return;
        await this.openWorkroomDetail?.(item.recordId);
        return;
      default:
    }
  },

  cancelCommandPaletteSearch() {
    if (this.commandPaletteSearchTimer) clearTimeout(this.commandPaletteSearchTimer);
    this.commandPaletteSearchTimer = null;
    this.commandPaletteSearchAbort?.abort?.();
    this.commandPaletteSearchAbort = null;
    this.commandPaletteSearchRequestId += 1;
    this.commandPaletteLocalLoading = false;
    this.commandPaletteGlobalLoading = false;
  },

  handleCommandPaletteQueryInput() {
    this.commandPaletteActiveId = '';
    if (this.commandPaletteMode === 'scope') return;
    this.cancelCommandPaletteSearch();
    this.commandPaletteLocalResults = [];
    this.commandPaletteGlobalResults = [];
    this.commandPaletteLocalError = '';
    this.commandPaletteGlobalError = '';
    const query = String(this.commandPaletteQuery || '').trim();
    if (!query) return;
    this.setCommandPaletteLocalSearchResults(query);
  },

  getCommandPaletteLocalSearchGroups(query) {
    const matches = (this.commandPaletteIndex || [])
      .filter((item) => commandPaletteMatchRank(item, query) !== null)
      .sort(sortCommandPaletteMatches(query));
    return { current: matches.slice(0, 5), other: [] };
  },

  setCommandPaletteLocalSearchResults(query) {
    const groups = this.getCommandPaletteLocalSearchGroups(query);
    this.commandPaletteLocalResults = mergeCommandPaletteResults(groups.current, groups.other);
    this.commandPaletteGlobalResults = [];
    return groups;
  },

  handleCommandPaletteEscape() {
    if (this.commandPaletteQuery) {
      this.commandPaletteQuery = '';
      this.handleCommandPaletteQueryInput();
      return;
    }
    if (this.commandPaletteMode === 'scope') {
      this.commandPaletteMode = 'root';
      this.commandPaletteActiveId = '';
      this.focusCommandPaletteInput();
      return;
    }
    this.closeCommandPalette();
  },

  handleCommandPaletteBackspace() {
    if (!this.commandPaletteQuery) this.handleCommandPaletteEscape();
  },

  get commandPaletteScopeItems() {
    return (this.filterFlightDeckScopeOptions?.(this.commandPaletteQuery) || []).map((board, index) => buildItem({
      id: `scope-picker:${board.id}`,
      group: 'scope',
      title: board.label || 'Untitled scope',
      subtitle: board.meta || board.breadcrumb || (board.id === ALL_TASK_BOARD_ID ? 'Everything' : 'Scope'),
      action: 'select-scope-context',
      scopeId: board.id,
      active: Boolean(this.isFlightDeckScopeOptionActive?.(board)),
      shortcutKey: COMMAND_PALETTE_SCOPE_SHORTCUT_KEYS[index] || '',
      searchText: compactText([board.label, board.meta, board.breadcrumb]),
    }));
  },

  get commandPaletteRecentScopeItems() {
    const byId = new Map(this.commandPaletteScopeItems.map((item) => [item.scopeId, item]));
    return (this.recentFocusAreas || []).map((recent) => byId.get(recent.id)).filter(Boolean).slice(0, 4);
  },

  async navigateCommandPaletteScopeSelection() {
    const section = String(this.navSection || 'status');
    if (section === 'tasks') {
      this.showBoardDescendantTasks = false;
      this.clearSelectedTasks?.();
      if (this.showTaskDetail) await this.closeTaskDetail?.({ syncRoute: false });
    } else if (section === 'docs') {
      await this.refreshDirectories?.();
      await this.refreshDocuments?.();
      this.closeDocEditor?.({ syncRoute: false });
      this.currentFolderId = null;
    } else if (section === 'chat') {
      await this.refreshChannels?.();
    } else if (section === 'reports' && !isFlightDeckSurfaceDisabled('reports')) {
      await this.refreshReports?.();
      this.selectedReportId = this.selectedReport?.record_id || null;
    }

    this.navigateTo?.(section, { syncRoute: false });
    this.syncRoute?.();
  },

  applyCommandPaletteScope(scopeId) {
    const nextScopeId = scopeId || null;
    this.selectedBoardId = nextScopeId;
    this.persistSelectedBoardId?.(nextScopeId);
    this.validateSelectedBoardId?.();
    this.normalizeTaskFilterTags?.();
  },

  resolveCommandPaletteQuickDocScopeId() {
    const configured = String(this.commandPaletteQuickDocScopeId || readStoredScopeId(QUICK_DOC_SCOPE_STORAGE_KEY)).trim();
    if (configured && this.scopesMap?.has(configured)) return configured;
    if (this.selectedBoardScope?.record_id) return this.selectedBoardScope.record_id;
    if (this.selectedBoardId && this.scopesMap?.has(this.selectedBoardId)) return this.selectedBoardId;
    const firstScope = (this.scopes || []).find((scope) => scope?.record_id && scope.record_state !== 'deleted');
    return firstScope?.record_id || null;
  },

  persistCommandPaletteQuickDocScopeId(scopeId = '') {
    const nextScopeId = String(scopeId || '').trim();
    this.commandPaletteQuickDocScopeId = nextScopeId;
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (nextScopeId) window.localStorage.setItem(QUICK_DOC_SCOPE_STORAGE_KEY, nextScopeId);
    else window.localStorage.removeItem(QUICK_DOC_SCOPE_STORAGE_KEY);
  },

  resolveCommandPaletteNewWorkScopeId() {
    const configured = String(this.commandPaletteNewWorkDefaultScopeId || readStoredScopeId(NEW_WORK_SCOPE_STORAGE_KEY)).trim();
    if (configured && this.scopesMap?.has(configured)) return configured;
    if (this.selectedBoardScope?.record_id) return this.selectedBoardScope.record_id;
    if (this.selectedBoardId && this.scopesMap?.has(this.selectedBoardId)) return this.selectedBoardId;
    const firstScope = (this.scopes || []).find((scope) => scope?.record_id && scope.record_state !== 'deleted');
    return firstScope?.record_id || '';
  },

  persistCommandPaletteNewWorkDefaultScopeId(scopeId = '') {
    const nextScopeId = String(scopeId || '').trim();
    this.commandPaletteNewWorkDefaultScopeId = nextScopeId;
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (nextScopeId) window.localStorage.setItem(NEW_WORK_SCOPE_STORAGE_KEY, nextScopeId);
    else window.localStorage.removeItem(NEW_WORK_SCOPE_STORAGE_KEY);
  },

  focusCommandPaletteNewWorkInput() {
    const focus = () => {
      if (typeof document === 'undefined') return;
      const input = document.querySelector('[data-command-palette-new-work-input]');
      input?.focus();
      input?.select?.();
    };
    this.$nextTick?.(focus);
    if (typeof window !== 'undefined') window.setTimeout(focus, 0);
  },

  openCommandPaletteNewWorkModal() {
    this.commandPaletteNewWorkTitle = '';
    this.commandPaletteNewWorkDescription = '';
    this.commandPaletteNewWorkScopeId = this.resolveCommandPaletteNewWorkScopeId();
    this.showCommandPaletteNewWorkModal = true;
    this.focusCommandPaletteNewWorkInput();
  },

  closeCommandPaletteNewWorkModal() {
    this.showCommandPaletteNewWorkModal = false;
    this.commandPaletteNewWorkTitle = '';
    this.commandPaletteNewWorkDescription = '';
    this.commandPaletteNewWorkScopeId = '';
  },

  getCommandPaletteNewWorkPasteGroupIds() {
    const scopeId = String(this.commandPaletteNewWorkScopeId || '').trim();
    if (!scopeId) return [];
    const assignment = this.buildTaskBoardAssignment?.(scopeId) || null;
    if (Array.isArray(assignment?.group_ids) && assignment.group_ids.length > 0) return assignment.group_ids;
    if (Array.isArray(assignment?.scope_policy_group_ids) && assignment.scope_policy_group_ids.length > 0) return assignment.scope_policy_group_ids;
    const scope = this.scopesMap?.get(scopeId);
    if (Array.isArray(scope?.group_ids)) return scope.group_ids;
    return [];
  },

  async handleCommandPaletteNewWorkDescriptionPaste(event) {
    await this.handleInlineImagePaste?.(event, {
      modelKey: 'commandPaletteNewWorkDescription',
      ownerNpub: this.workspaceOwnerNpub || this.session?.npub,
      accessGroupIds: this.getCommandPaletteNewWorkPasteGroupIds(),
      fileLabel: 'task',
    });
  },

  async createCommandPaletteNewWork() {
    const title = String(this.commandPaletteNewWorkTitle || '').trim();
    const description = String(this.commandPaletteNewWorkDescription || '').trim();
    if (!title) return;
    if (this.containsInlineImageUploadToken?.(description)) {
      this.error = 'Wait for image upload to finish.';
      return;
    }
    if (this.commandPaletteNewWorkScopeId) this.applyCommandPaletteScope(this.commandPaletteNewWorkScopeId);
    this.newTaskTitle = title;
    const createdTask = await this.addTask?.({ description });
    if (!createdTask?.record_id) return;
    this.closeCommandPaletteNewWorkModal();
    this.navigateTo?.('tasks', { syncRoute: false });
    this.openTaskDetail?.(createdTask.record_id);
    this.syncRoute?.();
  },

  findPrimaryAgentChannel(agentNpub) {
    const target = String(agentNpub || '').trim();
    const viewer = String(this.session?.npub || '').trim();
    if (!target || !viewer) return null;
    return (this.channels || []).find((channel) => {
      if (channel?.record_state === 'deleted') return false;
      const participants = Array.isArray(channel?.participant_npubs) ? channel.participant_npubs : [];
      return participants.includes(target) && participants.includes(viewer);
    }) || null;
  },

  async openCommandPalettePrimaryAgentChat() {
    await this.refreshChannels?.();
    this.navigateTo('chat', { syncRoute: false });
    const targetNpub = this.commandPalettePrimaryAgentNpub;
    if (!targetNpub) {
      this.openNewChannelModal?.();
      this.syncRoute?.();
      return;
    }
    const existing = this.findPrimaryAgentChannel(targetNpub);
    if (existing?.record_id) {
      await this.selectChannel(existing.record_id);
      return;
    }
    await this.createBotDm?.(targetNpub);
  },

  async createCommandPaletteQuickDoc() {
    const scopeId = this.resolveCommandPaletteQuickDocScopeId();
    if (!scopeId) {
      this.navigateTo('docs');
      this.error = 'Select a scope before creating a document.';
      return;
    }
    this.applyCommandPaletteScope(scopeId);
    await this.refreshDirectories?.();
    await this.refreshDocuments?.();
    await this.createDocument?.('Untitled document', { scopeId });
  },
};
