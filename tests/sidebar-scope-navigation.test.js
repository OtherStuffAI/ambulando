import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { channelsManagerMixin } from '../src/channels-manager.js';
import {
  buildSidebarActiveChannelIds,
  buildSidebarScopeChannelGroups,
  buildSidebarUnreadChannels,
} from '../src/sidebar-navigation.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('expanded sidebar scope/channel navigation', () => {
  it('groups workspace-visible records in scope order and channel position order', () => {
    const scopes = [
      { record_id: 'scope-child', title: 'Child', level: 'l2' },
      { record_id: 'scope-a', title: 'Alpha', level: 'l1' },
      { record_id: 'scope-deleted', title: 'Deleted', level: 'l1', record_state: 'deleted' },
      { record_id: 'scope-b', title: 'Beta', level: 'l1' },
      { record_id: 'scope-dms', title: 'DMs', level: 'l1', pg_kind: 'dm' },
      { record_id: 'scope-a', title: 'Duplicate', level: 'l1' },
    ];
    const channels = [
      { record_id: 'channel-a-2', title: 'Second', scope_id: 'scope-a', position: 2 },
      { record_id: 'channel-a-1', title: 'First', scope_id: 'scope-a', position: 1 },
      { record_id: 'channel-b', title: 'Beta', scope_id: 'scope-b', position: 1 },
      { record_id: 'dm-second', title: 'Second DM', scope_id: 'scope-dms', position: 2 },
      { record_id: 'dm-first', title: 'First DM', scope_id: 'scope-dms', position: 1 },
      { record_id: 'channel-a-1', title: 'Duplicate', scope_id: 'scope-b', position: 2 },
      { record_id: 'channel-deleted', scope_id: 'scope-a', record_state: 'deleted' },
      { record_id: 'channel-hidden', scope_id: 'scope-a', can_read: false },
      { record_id: 'channel-orphan', scope_id: 'scope-missing' },
    ];

    const groups = buildSidebarScopeChannelGroups(scopes, channels);

    expect(groups.map(({ scope }) => scope.record_id)).toEqual(['scope-dms', 'scope-a', 'scope-b', 'scope-child']);
    expect(groups[0].channels.map((channel) => channel.record_id)).toEqual(['dm-first', 'dm-second']);
    expect(groups[1].channels.map((channel) => channel.record_id)).toEqual(['channel-a-1', 'channel-a-2']);
    expect(groups[2].channels.map((channel) => channel.record_id)).toEqual(['channel-b']);
    expect(groups[3].channels).toEqual([]);
  });

  it('preserves the existing scope projection when no DMs scope is visible', () => {
    const groups = buildSidebarScopeChannelGroups([
      { record_id: 'scope-child', title: 'Child', level: 'l2' },
      { record_id: 'scope-a', title: 'Alpha', level: 'l1' },
      { record_id: 'scope-b', title: 'Beta', level: 'l1' },
    ], []);

    expect(groups.map(({ scope }) => scope.record_id)).toEqual(['scope-a', 'scope-b', 'scope-child']);
  });

  it('derives unread and active copy links from the existing sidebar tree without moving canonical channels', () => {
    const groups = buildSidebarScopeChannelGroups([
      { record_id: 'scope-a', title: 'Alpha', level: 'l1' },
      { record_id: 'scope-b', title: 'Beta', level: 'l1' },
    ], [
      { record_id: 'channel-a-1', title: 'Alpha first', scope_id: 'scope-a', position: 1 },
      { record_id: 'channel-a-2', title: 'Alpha second', scope_id: 'scope-a', position: 2 },
      { record_id: 'channel-b-1', title: 'Beta first', scope_id: 'scope-b', position: 1 },
      { record_id: 'channel-b-2', title: 'Beta second', scope_id: 'scope-b', position: 2 },
      { record_id: 'channel-deleted', title: 'Deleted', scope_id: 'scope-a', position: 3, record_state: 'deleted' },
    ]);
    const unreadIds = new Set(['channel-a-2', 'channel-b-1', 'channel-deleted']);
    const activeIds = new Set(['channel-a-1', 'channel-b-1', 'channel-deleted']);

    expect(buildSidebarUnreadChannels(
      groups,
      (channelId) => unreadIds.has(channelId),
      (channelId) => activeIds.has(channelId),
    ).map((channel) => channel.record_id)).toEqual([
      'channel-a-1',
      'channel-a-2',
      'channel-b-1',
    ]);
    expect(groups[0].channels.map((channel) => channel.record_id)).toEqual(['channel-a-1', 'channel-a-2']);
    expect(groups[1].channels.map((channel) => channel.record_id)).toEqual(['channel-b-1', 'channel-b-2']);
  });

  it('builds active channel membership from cached Inbox working keys only', () => {
    const activeIds = buildSidebarActiveChannelIds(new Set([
      'channel-thread:channel-a:thread-1',
      'thread:thread-2',
      'message:message-2',
      'task:task-1',
      'document:doc-1',
      'channel-thread:channel-b:thread-3',
    ]));

    expect([...activeIds].sort()).toEqual(['channel-a', 'channel-b']);
  });

  it('exposes unread and active copy links through the channel manager using live unread and cached active state', () => {
    const store = Object.create(channelsManagerMixin);
    Object.assign(store, {
      scopes: [{ record_id: 'scope-a', title: 'Alpha', level: 'l1' }],
      channels: [
        { record_id: 'channel-a-1', title: 'Active', scope_id: 'scope-a', position: 1 },
        { record_id: 'channel-a-2', title: 'Unread', scope_id: 'scope-a', position: 2 },
        { record_id: 'channel-a-3', title: 'Read', scope_id: 'scope-a', position: 3 },
      ],
      _unreadChannels: { 'channel-a-2': true },
      deckInboxWorkingResourceKeys: new Set(['channel-thread:channel-a-1:thread-1']),
      isChannelUnread(channelId) {
        return this._unreadChannels[channelId] === true;
      },
    });

    expect(store.sidebarUnreadChannels.map((channel) => channel.record_id)).toEqual(['channel-a-1', 'channel-a-2']);
    store._unreadChannels = {};
    expect(store.sidebarUnreadChannels.map((channel) => channel.record_id)).toEqual(['channel-a-1']);
    store.deckInboxWorkingResourceKeys = new Set();
    expect(store.sidebarUnreadChannels).toEqual([]);
  });

  it('keeps cached active channel membership across unrelated composer updates', () => {
    const store = Object.create(channelsManagerMixin);
    Object.assign(store, {
      deckInboxWorkingResourceKeys: new Set(['channel-thread:channel-a:thread-1']),
      messageDraft: 'before',
    });

    const first = store.sidebarActiveChannelIds;
    store.messageDraft = 'after';

    expect(store.sidebarActiveChannelIds).toBe(first);
  });

  it('binds Deck selection styling and routes clicks through the shared work-context controller', () => {
    expect(html).toContain('class="sidebar-scope-navigation"');
    expect(html).toContain('active: $store.chat.pgContextSelectedChannelId === channel.record_id && !$store.chat.pgContextSelectedThreadId');
    expect(html).toContain('@click="$store.chat.selectWorkContextChannel(channel.record_id, $event)"');
    expect(html).not.toContain('openSidebarChannel');
  });

  it('renders scope headings as native controls that open the exact scope Home in Deck', () => {
    expect(html).toMatch(/<h2\s+class="sidebar-scope-heading"[^>]*>\s*<span class="sidebar-scope-heading-row">\s*<button/s);
    expect(html).toContain('class="sidebar-scope-heading-control"');
    expect(html).toContain('@click="$store.chat.selectWorkContextScope(group.scope.record_id, $event)"');
    expect(html).toContain("active: $store.chat.pgContextScopeId === group.scope.record_id && $store.chat.pgContextHomeSelected");
    expect(html).toContain("$store.chat.pgContextHomeSelected ? 'page' : null");
    expect(html).toContain("'Open ' + ($store.chat.getScopeBreadcrumb(group.scope.record_id) || group.scope.title || group.scope.record_id) + ' home'");
  });

  it('opens all workspace content from the avatar with current-page semantics in every view', () => {
    expect(html).toMatch(/<button\s+type="button"\s+class="sidebar-workspace-overview"/s);
    expect(html).toContain('@click="$store.chat.openAllScopesOverview()"');
    expect(html).toContain("active: $store.chat.pgContextAllScopesSelected");
    expect(html).toContain("$store.chat.pgContextAllScopesSelected ? 'page' : null");
    expect(html).toContain('aria-label="All workspace activity"');
    expect(html).toContain('title="All workspace activity"');
    expect(html).toContain('class="sidebar-workspace-overview-label">Home</span>');
  });

  it('renders projected groups immediately after Home in the shared desktop and mobile sidebar', () => {
    const navigationStart = html.indexOf('class="sidebar-scope-navigation"');
    const navigationEnd = html.indexOf('class="sidebar-workspace-footer"', navigationStart);
    const navigation = html.slice(navigationStart, navigationEnd);
    const homeIndex = navigation.indexOf('class="sidebar-workspace-overview"');
    const groupsIndex = navigation.indexOf('x-for="group in $store.chat.sidebarScopeChannelGroups"');

    expect(homeIndex).toBeGreaterThan(-1);
    expect(groupsIndex).toBeGreaterThan(homeIndex);
  });

  it('renders an Unread & Active copy section before canonical scope groups only when shortcut channels exist', () => {
    const navigationStart = html.indexOf('class="sidebar-scope-navigation"');
    const navigationEnd = html.indexOf('class="sidebar-workspace-footer"', navigationStart);
    const navigation = html.slice(navigationStart, navigationEnd);
    const unreadIndex = navigation.indexOf('class="sidebar-unread-section"');
    const groupsIndex = navigation.indexOf('x-for="group in $store.chat.sidebarScopeChannelGroups"');
    const resolvedLabel = "$store.chat.getChannelLabel(channel) || channel.name || 'Channel'";

    expect(unreadIndex).toBeGreaterThan(-1);
    expect(groupsIndex).toBeGreaterThan(unreadIndex);
    expect(navigation).toContain('x-show="$store.chat.sidebarUnreadChannels.length > 0"');
    expect(navigation).toContain('aria-label="Unread and active channels"');
    expect(navigation).toContain('class="sidebar-unread-heading">Unread &amp; Active</h2>');
    expect(navigation).toContain('x-for="channel in $store.chat.sidebarUnreadChannels"');
    expect(navigation).toContain(':key="`sidebar-unread-channel-${channel.record_id}`"');
    expect(navigation).toContain(`:aria-label="'Open unread or active ' + (${resolvedLabel})"`);
    expect(navigation).toContain(`:title="${resolvedLabel}"`);
    expect(navigation).toContain(`x-text="${resolvedLabel}"`);
    expect(navigation).toContain('@click="$store.chat.selectWorkContextChannel(channel.record_id, $event)"');
    expect(navigation).toContain(":class=\"{ active: $store.chat.pgContextSelectedChannelId === channel.record_id && !$store.chat.pgContextSelectedThreadId }\"");
    expect(styles).toMatch(/\.sidebar-unread-section\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/s);
    expect(styles).toMatch(/\.sidebar-unread-channel\s*\{[^}]*min-height:\s*34px;[^}]*font-weight:\s*800;/s);
    expect(styles).toMatch(/\.sidebar-unread-channel\.active\s*\{[^}]*background:\s*#eff6ff;[^}]*color:\s*#1d4ed8;/s);
  });

  it('does not bind agent-activity scan helpers inside the sidebar shortcut section', () => {
    const navigationStart = html.indexOf('class="sidebar-scope-navigation"');
    const navigationEnd = html.indexOf('class="sidebar-workspace-footer"', navigationStart);
    const navigation = html.slice(navigationStart, navigationEnd);
    const unreadStart = navigation.indexOf('class="sidebar-unread-section"');
    const unreadEnd = navigation.indexOf('x-for="group in $store.chat.sidebarScopeChannelGroups"', unreadStart);
    const unreadSection = navigation.slice(unreadStart, unreadEnd);

    expect(unreadSection).not.toContain('agentActivities');
    expect(unreadSection).not.toMatch(/AgentActivity|agentActivity|get.*Working|is.*Working/);
  });

  it('uses the existing workspace avatar image and initials fallback state', () => {
    expect(html).toContain('class="sidebar-workspace-overview-avatar" :src="$store.chat.currentWorkspaceAvatarUrl"');
    expect(html).toContain('class="sidebar-workspace-overview-avatar sidebar-workspace-overview-avatar-fallback avatar-fallback" x-text="$store.chat.currentWorkspaceInitials"');
    expect(html).toContain('<template x-if="!$store.chat.currentWorkspaceAvatarUrl">');
  });

  it('keeps the overview visible for an active workspace when loaded groups are empty', () => {
    const visibility = "x-show=\"(!$store.chat.navCollapsed || $store.chat.mobileNavOpen) && (!$store.chat.scopesLoaded || $store.chat.currentWorkspaceKey || $store.chat.activeWorkspaceOwnerNpub || $store.chat.sidebarScopeChannelGroups.length > 0)\"";

    expect(html).toContain(visibility);
    expect(html).toContain('x-show="$store.chat.currentWorkspaceKey || $store.chat.activeWorkspaceOwnerNpub"');
  });

  it('uses the shared resolved channel label for sidebar text and accessible metadata', () => {
    const resolvedLabel = "$store.chat.getChannelLabel(channel) || channel.name || 'Channel'";

    expect(html).toContain(`:aria-label="${resolvedLabel}"`);
    expect(html).toContain(`:title="${resolvedLabel}"`);
    expect(html).toContain(`x-text="${resolvedLabel}"`);
    expect(html).not.toContain('x-text="channel.title || channel.name || channel.record_id"');
  });

  it('keeps unread and selected channel state reactive on the same sidebar control', () => {
    expect(html).toContain("'sidebar-scope-channel-unread': $store.chat.isChannelUnread(channel.record_id)");
    expect(html).toContain('active: $store.chat.pgContextSelectedChannelId === channel.record_id && !$store.chat.pgContextSelectedThreadId');
    expect(html).toMatch(/class="sidebar-scope-channel-row"[\s\S]*?:class="\{[\s\S]*?active:[\s\S]*?'sidebar-scope-channel-unread':[\s\S]*?\}"/s);
    expect(html).toContain('class="unread-dot unread-dot-channel" x-show="$store.chat.isChannelUnread(channel.record_id)" x-cloak aria-hidden="true"');
    expect(styles).toMatch(/\.sidebar-scope-channel-label\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/s);
    expect(styles).toMatch(/\.sidebar-scope-channel-unread \.sidebar-scope-channel-label\s*\{[^}]*font-weight:\s*800;/s);
    expect(styles).toMatch(/\.sidebar-scope-channel-row\.active\.sidebar-scope-channel-unread \.sidebar-scope-channel-label\s*\{[^}]*color:\s*#1d4ed8;/s);
  });

  it('adds a permission-aware scoped channel creation control without navigating Home', () => {
    expect(html).toContain('class="sidebar-scope-add-channel"');
    expect(html).toContain('x-show="$store.chat.canCreateChannelInScope(group.scope)"');
    expect(html).toContain(":aria-label=\"'Create channel in ' + ($store.chat.getScopeBreadcrumb(group.scope.record_id) || group.scope.title || group.scope.record_id)\"");
    expect(html).toContain('@click.stop.prevent="$store.chat.openNewChannelModal({ scopeId: group.scope.record_id })"');
    expect(styles).toMatch(/\.sidebar-scope-add-channel\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s);
    expect(styles).toMatch(/\.sidebar-scope-add-channel:focus-visible\s*\{[^}]*outline:\s*2px solid #2563eb;/s);
  });

  it('renders a visible sibling settings control on every channel row', () => {
    expect(html).toMatch(/class="sidebar-scope-channel-row"[\s\S]*?<button[\s\S]*?class="sidebar-scope-channel"[\s\S]*?<\/button>[\s\S]*?<button[\s\S]*?class="chat-channel-menu-button sidebar-scope-channel-menu"/s);
    expect(html).toContain('@click.stop.prevent="$store.chat.openChannelSettings(channel.record_id)"');
    expect(html).toContain(":aria-label=\"'Channel settings for ' + ($store.chat.getChannelLabel(channel) || channel.name || 'Channel')\"");
    expect(styles).toMatch(/\.sidebar-scope-channel-row\s*\{[^}]*min-height:\s*40px;/s);
    expect(styles).toMatch(/\.sidebar-scope-channel-menu\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s);
  });

  it('keeps the scope navigation stack scrollable and hides it in collapsed/mobile rails', () => {
    expect(styles).toMatch(/\.sidebar-nav\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toMatch(/\.sidebar-scope-navigation\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;/s);
    expect(styles).toMatch(/\.sidebar-scope-heading-control:focus-visible\s*\{[^}]*outline:\s*2px solid #2563eb;/s);
    expect(styles).toMatch(/\.sidebar-workspace-overview:focus-visible\s*\{[^}]*outline:\s*2px solid #2563eb;/s);
    expect(styles).toMatch(/\.sidebar-workspace-overview:active\s*\{[^}]*background:\s*#dbeafe;/s);
    expect(styles).toMatch(/\.sidebar-workspace-footer\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toMatch(/\.sidebar-collapsed \.sidebar-scope-navigation[\s\S]*display:\s*none;/);
    expect(styles).toMatch(/\.sidebar-collapsed \.sidebar-manage-scopes-footer\s*\{[^}]*display:\s*none;/s);
    const mobile = styles.slice(styles.indexOf('@media (max-width: 768px)'));
    expect(mobile).toMatch(/\.sidebar\.sidebar-mobile-open \.sidebar-scope-navigation\s*\{[^}]*display:\s*block;/s);
    expect(mobile).toMatch(/\.sidebar\.sidebar-mobile-open \.sidebar-manage-scopes-footer\s*\{[^}]*display:\s*block;/s);
  });

  it('keeps the shared top bar available for the expanded-column section picker', () => {
    expect(html).toContain("'global-pg-channel-bar-sidebar-expanded': !$store.chat.navCollapsed");
    expect(styles).not.toMatch(/@media \(min-width: 769px\)\s*\{[\s\S]*?\.global-pg-channel-bar\.global-pg-channel-bar-sidebar-expanded\s*\{[^}]*display:\s*none;/s);
    const mobile = styles.slice(styles.indexOf('@media (max-width: 768px)'));
    expect(mobile).toMatch(/\.global-pg-channel-bar\.global-pg-channel-bar-sidebar-expanded\s*\{[^}]*display:\s*flex;/s);
  });

  it('places Home below primary navigation without a dedicated divider in desktop or mobile layouts', () => {
    expect(html).toMatch(/<span class="sidebar-label">Context<\/span>[\s\S]*<\/ul>\s*<button[^>]*class="toolbox-expanded-nav"[^>]*>[\s\S]*?<\/button>\s*<section\s+class="sidebar-scope-navigation"/s);
    expect(html).not.toContain('sidebar-workspace-navigation-divider');
    expect(styles).not.toContain('sidebar-workspace-navigation-divider');
  });

  it('places Manage scopes at the bottom of the scrollable scope navigation stack', () => {
    const navigationStart = html.indexOf('class="sidebar-scope-navigation"');
    const footerStart = html.indexOf('class="sidebar-workspace-footer"', navigationStart);
    const navigation = html.slice(navigationStart, footerStart);
    const footer = html.slice(footerStart, html.indexOf('</nav>', footerStart));
    const groupsIndex = navigation.indexOf('x-for="group in $store.chat.sidebarScopeChannelGroups"');
    const manageIndex = navigation.indexOf('class="sidebar-manage-scopes-footer"');

    expect(manageIndex).toBeGreaterThan(groupsIndex);
    expect(navigation).toMatch(/class="sidebar-manage-scopes-footer"[\s\S]*x-show="\$store\.chat\.canAccessScopeSettings"[\s\S]*class="sidebar-scope-heading-control"[\s\S]*@click="\$store\.chat\.openScopeManagement\(\)"[\s\S]*>Manage scopes<\/button>/s);
    expect(footer).not.toContain('$store.chat.openScopeManagement()');
    expect(styles).toMatch(/\.sidebar-manage-scopes-footer\s*\{[^}]*border-top:\s*1px solid var\(--border\);/s);
  });
});
