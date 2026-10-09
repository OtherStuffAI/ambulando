import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const htmlPath = path.resolve(import.meta.dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf-8');
const stylesPath = path.resolve(import.meta.dirname, '..', 'src', 'styles.css');
const styles = fs.readFileSync(stylesPath, 'utf-8');

describe('Chat channel rendering hooks', () => {
  it('renders accessible Read aloud controls in the feed and thread messages', () => {
    expect(html.match(/class="chat-read-aloud-btn"/g) || []).toHaveLength(3);
    expect(html).toContain("x-show=\"$store.chat.canReadMessageAloud(msg)\"");
    expect(html).toContain("@click.stop=\"$store.chat.toggleReadAloud(reply)\"");
    expect(html).toContain("'Stop reading message aloud' : 'Read message aloud'");
    expect(styles).toMatch(/\.chat-read-aloud-btn\s*\{[\s\S]*min-height:\s*32px;/);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*\.chat-read-aloud-btn\s*\{[\s\S]*min-height:\s*44px;/);
  });

  it('renders the channel as a stacked thread-card index with modal-only creation', () => {
    expect(html).toContain('class="chat-feed channel-thread-index"');
    expect(html).toContain('class="chat-post channel-thread-card"');
    expect(html).toContain('getThreadCardTitle(msg)');
    expect(html).toContain('getThreadMessageCount(msg.record_id)');
    expect(html).toContain('channel-thread-card-latest');
    expect(html).toContain('@click="$store.chat.openDeckThreadComposer()"');
    const indexStart = html.indexOf('class="chat-layout"');
    const modalStart = html.indexOf('class="chat-thread-modal-backdrop"', indexStart);
    expect(html.slice(indexStart, modalStart)).not.toContain('data-chat-composer="message"');
    expect(styles).toMatch(/\.chat-feed\.channel-thread-index\s*\{[\s\S]*gap:\s*1rem;/);
    expect(styles).toMatch(/\.chat-post\.channel-thread-card\s*\{[\s\S]*border-radius:\s*var\(--radius-panel\);/);
  });

  it('uses a compact channel header without duplicate navigation copy', () => {
    const headerStart = html.indexOf('class="channel-thread-index-header"');
    const feedStart = html.indexOf('class="chat-feed channel-thread-index"', headerStart);
    const header = html.slice(headerStart, feedStart);

    expect(header).toContain('getChannelLabel($store.chat.selectedChannel)');
    expect(header).toContain('aria-label="New thread"');
    expect(header).not.toContain('channel-thread-index-eyebrow');
    expect(header).not.toContain('Open a conversation to read and reply');
    expect(styles).toMatch(/\.channel-thread-index-header\s*\{[\s\S]*min-height:\s*3\.5rem;[\s\S]*padding:\s*0\.55rem/);
  });

  it('stacks Menu above Start thread in the thread composer controls', () => {
    const composerStart = html.indexOf('class="thread-input-actions"');
    const composerEnd = html.indexOf('</div>', html.indexOf('class="thread-reply-btn"', composerStart));
    const controls = html.slice(composerStart, composerEnd);

    expect(composerStart).toBeGreaterThan(-1);
    expect(controls.indexOf('>Menu</button>')).toBeGreaterThan(-1);
    expect(controls.indexOf('>Menu</button>')).toBeLessThan(controls.indexOf('class="thread-reply-btn"'));
    expect(styles).toMatch(/\.thread-input-actions\s*\{[\s\S]*flex-direction:\s*column;/);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*\.thread-input-actions\s*\{[\s\S]*flex-direction:\s*column;/);
  });

  it('keeps the load-more control wired to the shared visibility getter', () => {
    expect(html).toContain('showMainFeedLoadMoreControl');
  });

  it('keeps focus and unread styling on the same chat row binding', () => {
    expect(html).toMatch(/chat-post-focused[\s\S]*chat-post-unread/);
  });

  it('routes index editing through the existing thread modal composer', () => {
    const indexStart = html.indexOf('class="chat-layout"');
    const modalStart = html.indexOf('class="chat-thread-modal-backdrop"', indexStart);
    const indexMarkup = html.slice(indexStart, modalStart);

    expect(indexMarkup).toContain('startMessageEdit(msg.record_id)');
    expect(indexMarkup).not.toContain('data-chat-composer="message"');
    expect(html.slice(modalStart)).toContain('x-show="$store.chat.isEditingMessage(\'thread\')"');
  });

  it('binds the pastel unread treatment to root thread resource state', () => {
    expect(html).toContain("'chat-post-thread-unread': $store.chat.isRootThreadUnread(msg)");
    expect(styles).toMatch(/--unread-pastel-red:\s*var\(--info-background\)/);
    expect(styles).toMatch(/\.chat-post-thread-unread,[\s\S]*background:\s*var\(--unread-pastel-red\)/);
    expect(styles).toContain('.chat-post-thread-unread:hover');
    expect(styles).toContain('.chat-post-thread-unread.chat-post-focused');
  });

  it('renders latest thread reply preview hooks in the main chat feed', () => {
    expect(html).toContain('getThreadReplierAvatars(msg.record_id)');
    expect(html).toContain('getLatestThreadReplyPreview(msg.record_id)');
    expect(html).toContain('chat-thread-latest-preview');
    expect(html).toContain('@click="$store.chat.openThread(msg.record_id)"');
  });

  it('renders the PG work context bar first in status, tasks, docs, and files', () => {
    const statusSectionIndex = html.indexOf('class="status-section"');
    const statusContextIndex = html.indexOf('class="pg-work-context-bar"', statusSectionIndex);
    const statusSummaryIndex = html.indexOf('data-testid="flightdeck-summary-overview"', statusSectionIndex);
    const taskSectionIndex = html.indexOf('class="tasks-section"');
    const taskContextIndex = html.indexOf('class="pg-work-context-bar"', taskSectionIndex);
    const taskCreateIndex = html.indexOf('class="task-create-bar"', taskSectionIndex);
    const docsViewIndex = html.indexOf('class="docs-view"');
    const docsContextIndex = html.indexOf('class="pg-work-context-bar"', docsViewIndex);
    const docsToolbarIndex = html.indexOf('class="docs-toolbar"', docsViewIndex);
    const filesSectionIndex = html.indexOf('class="files-section"');
    const filesContextIndex = html.indexOf('class="pg-work-context-bar files-work-context-bar"', filesSectionIndex);
    const filesHeaderIndex = html.indexOf('class="files-header"', filesSectionIndex);

    expect(statusContextIndex).toBeGreaterThan(statusSectionIndex);
    expect(statusContextIndex).toBeLessThan(statusSummaryIndex);
    expect(taskContextIndex).toBeGreaterThan(taskSectionIndex);
    expect(taskContextIndex).toBeLessThan(taskCreateIndex);
    expect(docsContextIndex).toBeGreaterThan(docsViewIndex);
    expect(docsContextIndex).toBeLessThan(docsToolbarIndex);
    expect(filesContextIndex).toBeGreaterThan(filesSectionIndex);
    expect(filesContextIndex).toBeLessThan(filesHeaderIndex);
    expect(html.match(/class="pg-work-context-bar/g) || []).toHaveLength(4);
  });

  it('renders the channel settings menu in every PG work context bar', () => {
    const contextBars = html.match(/<div class="pg-work-context-bar[\s\S]*?<div class="pg-context-thread-strip"/g) || [];

    expect(contextBars).toHaveLength(4);
    for (const contextBar of contextBars) {
      expect(contextBar).toContain('class="chat-channel-menu chat-channel-tab-menu"');
      expect(contextBar).toContain('@click.stop.prevent="$store.chat.openChannelSettings(channel.record_id)"');
    }
  });

  it('renders task board sort controls with created, modified, and A-Z direction options', () => {
    const taskSectionIndex = html.indexOf('class="tasks-section"');
    const taskBoardIndex = html.indexOf('class="kanban-board"', taskSectionIndex);
    const taskToolbar = html.slice(taskSectionIndex, taskBoardIndex);

    expect(taskToolbar).toContain('class="doc-actions-popover task-control-actions-popover"');
    expect(taskToolbar).toContain('class="task-sort-control"');
    expect(taskToolbar).toContain('@change="$store.chat.setTaskSortMode($event.target.value)"');
    expect(taskToolbar).toContain('<option value="created_asc">Created: oldest first</option>');
    expect(taskToolbar).toContain('<option value="created_desc">Created: newest first</option>');
    expect(taskToolbar).toContain('<option value="modified_desc">Modified: newest first</option>');
    expect(taskToolbar).toContain('<option value="modified_asc">Modified: oldest first</option>');
    expect(taskToolbar).toContain('<option value="alpha_asc">A-Z</option>');
    expect(taskToolbar).toContain('<option value="alpha_desc">Z-A</option>');
  });

  it('keeps desktop task controls in one row with secondary actions in the menu', () => {
    const taskSectionIndex = html.indexOf('class="tasks-section"');
    const taskBoardIndex = html.indexOf('class="kanban-board"', taskSectionIndex);
    const taskToolbar = html.slice(taskSectionIndex, taskBoardIndex);

    expect(taskToolbar).toContain('class="filter-to-me-btn"');
    expect(taskToolbar).toContain('class="doc-actions-popover task-control-actions-popover"');
    expect(taskToolbar).toContain("$store.chat.showBoardDescendantTasks ? 'Hide child-scope tasks' : 'Show child-scope tasks'");
    expect(taskToolbar).toContain('@click="$store.chat.markAllTasksRead(); open = false"');
    expect(taskToolbar).toContain('class="task-selected-count-pill"');
    expect(taskToolbar).toContain('class="task-control-bulk-actions"');
    expect(taskToolbar).not.toContain('class="task-bulk-bar"');
    expect(styles).toMatch(/\.task-top-toolbar\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;/);
    expect(styles).toMatch(/\.task-create-bar\s*\{[\s\S]*flex:\s*0\s+0\s+clamp\(14\.5rem,\s*24vw,\s*20rem\);[\s\S]*margin-bottom:\s*0;/);
    expect(styles).toMatch(/\.task-filters-bar\s*\{[\s\S]*flex:\s*1\s+1\s+auto;[\s\S]*flex-wrap:\s*nowrap;/);
    expect(styles).toMatch(/\.filter-to-me-btn\s*\{[\s\S]*order:\s*3;/);
    expect(styles).toMatch(/\.task-selected-count-pill\s*\{[\s\S]*order:\s*6;/);
    expect(styles).toMatch(/\.task-section-actions-menu\s*\{[\s\S]*order:\s*7;/);
  });

  it('keeps task and docs top toolbars sticky inside the content scroller', () => {
    const taskSectionIndex = html.indexOf('class="tasks-section"');
    const taskToolbarIndex = html.indexOf('class="task-top-toolbar"', taskSectionIndex);
    const taskCreateIndex = html.indexOf('class="task-create-bar"', taskToolbarIndex);
    const taskFiltersIndex = html.indexOf('class="task-filters-bar"', taskToolbarIndex);
    const taskBoardIndex = html.indexOf('class="kanban-board"', taskSectionIndex);

    expect(taskToolbarIndex).toBeGreaterThan(taskSectionIndex);
    expect(taskCreateIndex).toBeGreaterThan(taskToolbarIndex);
    expect(taskFiltersIndex).toBeGreaterThan(taskCreateIndex);
    expect(taskFiltersIndex).toBeLessThan(taskBoardIndex);
    expect(styles).toMatch(/\.task-top-toolbar\s*\{[\s\S]*position:\s*sticky;[\s\S]*top:\s*0;/);
    expect(styles).toMatch(/\.docs-header\s*\{[\s\S]*position:\s*sticky;[\s\S]*top:\s*0;/);
  });

  it('collapses secondary task controls behind a mobile ellipsis while keeping view switching visible', () => {
    const taskSectionIndex = html.indexOf('class="tasks-section"');
    const taskBoardIndex = html.indexOf('class="kanban-board"', taskSectionIndex);
    const taskToolbar = html.slice(taskSectionIndex, taskBoardIndex);
    const mobileStart = styles.indexOf('@media (max-width: 640px)');
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    const mobileCss = styles.slice(mobileStart, styles.indexOf('/* Responsive task board */', mobileStart));

    expect(taskToolbar).toContain('taskControlsOpen: false');
    expect(taskToolbar).toContain('class="task-mobile-controls-row"');
    expect(taskToolbar).toContain('class="board-descendant-toggle task-view-toggle task-mobile-view-toggle"');
    expect(taskToolbar).toContain('class="doc-actions-toggle task-mobile-controls-trigger"');
    expect(taskToolbar).toContain('aria-label="Task controls"');
    expect(taskToolbar).toContain(':aria-expanded="taskControlsOpen.toString()"');
    expect(taskToolbar).toContain("'task-filters-bar-mobile-open': taskControlsOpen");
    expect(taskToolbar).toContain('x-ref="taskControlsFirst"');
    expect(taskToolbar).toContain("@keydown.escape.stop.prevent=\"taskControlsOpen = false; $nextTick(() => $refs.taskControlsTrigger?.focus())\"");

    expect(mobileCss).toMatch(/\.task-mobile-controls-row\s*\{[\s\S]*display:\s*flex;/);
    expect(mobileCss).toMatch(/\.task-filters-bar\s*\{[\s\S]*display:\s*none;/);
    expect(mobileCss).toMatch(/\.task-filters-bar-mobile-open\s*\{[\s\S]*display:\s*flex;/);
    expect(mobileCss).toMatch(/\.task-filters-bar\s*>\s*\.task-view-toggle\s*\{[\s\S]*display:\s*none;/);
    expect(mobileCss).toMatch(/\.task-tag-cloud\s*\{[\s\S]*position:\s*fixed;/);
  });

  it('keeps the mobile task add form narrow enough for the compact controls', () => {
    const mobileStart = styles.indexOf('@media (max-width: 640px)');
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    const mobileCss = styles.slice(mobileStart, styles.indexOf('/* Responsive task board */', mobileStart));

    expect(mobileCss).toMatch(/\.task-top-toolbar\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto;/);
    expect(mobileCss).toMatch(/\.task-create-bar\s*\{[\s\S]*min-width:\s*0;[\s\S]*margin-bottom:\s*0;/);
    expect(mobileCss).toMatch(/\.task-create-input\s*\{[\s\S]*flex:\s*1\s*1\s*0;[\s\S]*min-width:\s*0;/);
    expect(mobileCss).toMatch(/\.task-create-btn\s*\{[\s\S]*flex:\s*0\s*0\s*auto;[\s\S]*min-width:\s*2\.75rem;/);
    expect(mobileCss).toMatch(/\.task-mobile-controls-row\s*\{[\s\S]*min-width:\s*max-content;/);
    expect(mobileCss).toMatch(/\.task-filters-bar\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1;/);
  });

  it('emphasizes only populated thread titles on mobile task cards', () => {
    const taskSectionIndex = html.indexOf('class="tasks-section"');
    const taskDetailIndex = html.indexOf('<!-- Task detail panel -->', taskSectionIndex);
    const taskCards = html.slice(taskSectionIndex, taskDetailIndex);
    const responsiveStart = styles.indexOf('/* Responsive task board */');
    const responsiveCss = styles.slice(responsiveStart, styles.indexOf('@media (max-width: 480px)', responsiveStart));

    expect(taskCards.match(/class="(?:kanban-card-title|task-list-title) task-thread-title"/g)).toHaveLength(3);
    expect(taskCards).toContain('class="kanban-card-title task-thread-title" :class="$store.chat.getTaskTitleLengthClass(task.title)" x-text="task.title"');
    expect(taskCards).toContain('class="task-list-title task-thread-title" :class="$store.chat.getTaskTitleLengthClass(task.title)" x-text="task.title"');
    expect(responsiveCss).toMatch(/@media \(max-width:\s*768px\)[\s\S]*\.task-thread-title:not\(:empty\)\s*\{[\s\S]*font-weight:\s*700;/);
    expect(styles.slice(0, responsiveStart)).not.toContain('.task-thread-title');
    expect(taskCards).not.toMatch(/task-thread-title[^>]*x-text="[^\"]*\|\|/);
  });

  it('renders the fullscreen header toggle in the shared PG channel bar', () => {
    const globalBarIndex = html.indexOf('class="global-pg-channel-bar"');
    const globalBarEndIndex = html.indexOf('<template x-if="$store.chat.navSection === \'status\'">', globalBarIndex);
    const globalBar = html.slice(globalBarIndex, globalBarEndIndex);

    expect(globalBarIndex).toBeGreaterThan(-1);
    expect(globalBar).toContain('class="chat-channel-header-icon-btn"');
    expect(globalBar).toContain('@click="$store.chat.toggleAppHeaderHidden()"');
    expect(globalBar).toContain(":title=\"$store.chat.appHeaderHidden ? 'Show header' : 'Full screen'\"");
  });

  it('renders an all-scopes home tab before shared PG channel tabs', () => {
    const globalBarIndex = html.indexOf('class="global-pg-channel-bar"');
    const globalBarEndIndex = html.indexOf('<template x-if="$store.chat.navSection === \'status\'">', globalBarIndex);
    const globalBar = html.slice(globalBarIndex, globalBarEndIndex);
    const avatarIndex = globalBar.indexOf('class="channel-row-workspace-avatar-btn"');
    const scopeSwitcherIndex = globalBar.indexOf('class="channel-row-scope-switcher"');
    const homeIndex = globalBar.indexOf('class="chat-channel-tab-item channel-home-tab-item"');
    const channelLoopIndex = globalBar.indexOf('<template x-for="channel in $store.chat.pgContextChannels"');

    expect(avatarIndex).toBeGreaterThan(-1);
    expect(scopeSwitcherIndex).toBeGreaterThan(-1);
    expect(avatarIndex).toBeLessThan(scopeSwitcherIndex);
    expect(homeIndex).toBeGreaterThan(-1);
    expect(homeIndex).toBeLessThan(channelLoopIndex);
    expect(globalBar).toContain("pg-all-scopes-context");
    expect(globalBar).toContain('@click="$store.chat.openAllScopesOverview()"');
    expect(globalBar).toContain('@click="$store.chat.openCommandPaletteScopeSwitcher($event)"');
    expect(globalBar).not.toContain('$store.chat.selectBoard(board.id)');
    expect(globalBar).toContain('@click="$store.chat.openWorkContextHome($event)"');
    expect(globalBar).toContain('currentWorkspaceAvatarUrl');
    expect(globalBar).toContain('currentWorkspaceInitials');
    expect(globalBar).toContain(':class="{ active: $store.chat.pgContextHomeSelected }"');
    expect(globalBar).toContain("'chat-channel-tab-all-unread': $store.chat.pgContextAllScopesSelected && $store.chat.isChannelUnread(channel.record_id)");
    expect(styles).toMatch(/\.pg-all-scopes-context \.chat-channel-tab-item\.chat-channel-tab-all-unread\s*\{[\s\S]*opacity:\s*1;/);
    expect(styles).toMatch(/\.pg-all-scopes-context \.chat-channel-tab-all-unread \.chat-channel-tab-label\s*\{[\s\S]*color:\s*var\(--text\);[\s\S]*font-weight:\s*800;/);
  });

  it('keeps the channel row workspace avatar from inheriting global button padding', () => {
    expect(styles).toMatch(/\.channel-row-workspace-avatar-btn\s*\{[\s\S]*padding:\s*0;/);
    expect(styles).toMatch(/\.channel-row-workspace-avatar\s*\{[\s\S]*width:\s*28px;[\s\S]*height:\s*28px;/);
  });

  it('renders workspace avatar access in the mobile scope row', () => {
    const switcherIndex = html.indexOf('class="mobile-scope-switcher"');
    const switcherEndIndex = html.indexOf('<section class="auth-panel"', switcherIndex);
    const switcher = html.slice(switcherIndex, switcherEndIndex);

    expect(switcherIndex).toBeGreaterThan(-1);
    expect(switcher).toContain('class="mobile-scope-workspace-avatar-btn"');
    expect(switcher).toContain('@click="$store.chat.openAllScopesOverview()"');
    expect(switcher).toContain('@click="$store.chat.openCommandPaletteScopeSwitcher($event)"');
    expect(switcher).not.toContain('$store.chat.selectBoard(board.id)');
    expect(switcher).toContain('currentWorkspaceAvatarUrl');
    expect(switcher).toContain('currentWorkspaceInitials');
  });

  it('uses the shared PG context controls as the chat channel bar', () => {
    const globalBarIndex = html.indexOf('class="global-pg-channel-bar"');
    const globalBarEndIndex = html.indexOf('<div class="content-scroll-area"', globalBarIndex);
    const globalBar = html.slice(globalBarIndex, globalBarEndIndex);
    const avatarIndex = globalBar.indexOf('class="channel-row-workspace-avatar-btn"');
    const scopeSwitcherIndex = globalBar.indexOf('class="channel-row-scope-switcher"');
    const homeIndex = globalBar.indexOf('class="chat-channel-tab-item channel-home-tab-item"');
    const channelLoopIndex = globalBar.indexOf('<template x-for="channel in $store.chat.pgContextChannels"');

    expect(globalBarIndex).toBeGreaterThan(-1);
    expect(avatarIndex).toBeGreaterThan(-1);
    expect(scopeSwitcherIndex).toBeGreaterThan(-1);
    expect(avatarIndex).toBeLessThan(scopeSwitcherIndex);
    expect(homeIndex).toBeGreaterThan(-1);
    expect(homeIndex).toBeLessThan(channelLoopIndex);
    expect(globalBar).toContain('@click="$store.chat.openWorkContextHome($event)"');
    expect(globalBar).toContain('currentWorkspaceAvatarUrl');
    expect(globalBar).toContain('active: $store.chat.pgContextSelectedChannelId === channel.record_id');
    expect(globalBar).toContain(':aria-selected="$store.chat.pgContextSelectedChannelId === channel.record_id');
    expect(globalBar).toContain('@click="$store.chat.selectWorkContextChannel(channel.record_id, $event)"');
    expect(globalBar).not.toContain("$store.chat.navSection === 'chat' ? $store.chat.selectChannel(channel.record_id) : $store.chat.selectDeckChannel(channel.record_id)");
    expect(globalBar).not.toContain('scopeFilteredChannels');
  });

  it('keeps the overflowing tab strip on native touch panning in Wingman iPhone without changing tap or desktop drag paths', () => {
    const globalBarIndex = html.indexOf('class="global-pg-channel-bar"');
    const globalBarEndIndex = html.indexOf('<div class="content-scroll-area"', globalBarIndex);
    const globalBar = html.slice(globalBarIndex, globalBarEndIndex);
    const scrollRule = styles.match(/\.chat-channel-tab-scroll\s*\{([^}]+)\}/)?.[1] ?? '';
    const wingmanDragRule = styles.match(/html\.wingman-iphone-webview \.chat-channel-tab-scroll,\s*html\.wingman-iphone-webview \.chat-channel-tab-scroll \*\s*\{([^}]+)\}/)?.[1] ?? '';

    expect(scrollRule).toMatch(/overflow-x:\s*auto/);
    expect(scrollRule).toMatch(/overflow-y:\s*hidden/);
    expect(scrollRule).toMatch(/overscroll-behavior-inline:\s*contain/);
    expect(scrollRule).toMatch(/touch-action:\s*pan-x pan-y/);
    expect(scrollRule).toMatch(/-webkit-overflow-scrolling:\s*touch/);
    expect(scrollRule).not.toMatch(/scroll-snap/);
    expect(wingmanDragRule).toMatch(/-webkit-user-drag:\s*none/);

    expect(globalBar).toContain(':draggable="!$store.chat.isTowerPgMode || $store.chat.canReorderChannel(channel)"');
    expect(globalBar).toContain('@dragstart="$store.chat.startChannelTabDrag(channel.record_id, $event)"');
    expect(globalBar).toContain('@click="$store.chat.selectWorkContextChannel(channel.record_id, $event)"');
    expect(globalBar).toContain('@click.stop.prevent="$store.chat.openChannelSettings(channel.record_id)"');
    expect(globalBar).toContain('@click="$store.chat.openNewChannelModal()"');
    expect(globalBar).toContain('@click="$store.chat.toggleAppHeaderHidden()"');
    expect(globalBar).not.toMatch(/@touch(?:start|move|end)|@pointer(?:down|move|up)/);
  });

  it('renders mobile quick section navigation as a bottom-fixed switcher', () => {
    const globalBarIndex = html.indexOf('class="global-pg-channel-bar"');
    const globalBarEndIndex = html.indexOf('<div class="content-scroll-area"', globalBarIndex);
    const globalBar = html.slice(globalBarIndex, globalBarEndIndex);
    const channelHeaderIndex = globalBar.indexOf('class="chat-channel-header"');
    const switcherIndex = globalBar.indexOf('class="mobile-section-switcher"');

    expect(channelHeaderIndex).toBeGreaterThan(-1);
    expect(switcherIndex).toBeGreaterThan(channelHeaderIndex);
    expect(globalBar).toContain("navigateTo('status')");
    expect(globalBar).toContain("navigateTo('chat')");
    expect(globalBar).toContain("navigateTo('tasks')");
    expect(globalBar).toContain("navigateTo('docs')");
    expect(globalBar).toContain('mobile-section-switcher-btn-active');
    expect(styles).toMatch(/\.mobile-section-switcher\s*\{[\s\S]*display:\s*none;/);
    expect(globalBar.match(/class="mobile-section-switcher-btn"/g)).toHaveLength(8);
    for (const section of ['Deck', 'Chat', 'Tasks', 'Docs', 'Files', 'Agents', 'Context', 'Toolbox']) {
      expect(globalBar).toContain(`aria-label="${section}" title="${section}"`);
    }
    expect(globalBar.match(/class="mobile-section-switcher-btn"[\s\S]*?<svg aria-hidden="true"/g)).toHaveLength(8);
    expect(styles).toMatch(/\.mobile-section-switcher\s*\{[\s\S]*display:\s*flex;[\s\S]*overflow-x:\s*auto;[\s\S]*overflow-y:\s*hidden;/);
    expect(styles).toMatch(/\.mobile-section-switcher-item\s*\{[^}]*flex:\s*1 0 auto;[^}]*min-width:\s*44px;/s);
    expect(styles).toMatch(/--mobile-section-switcher-height:\s*68px;/);
    expect(styles).toMatch(/\.mobile-section-switcher\s*\{[\s\S]*position:\s*fixed;[\s\S]*bottom:\s*0;/);
    expect(styles).toMatch(/\.mobile-section-switcher-btn\s*\{[\s\S]*min-height:\s*var\(--mobile-section-switcher-height\);/);
    expect(styles).toMatch(/\.mobile-section-switcher-btn svg\s*\{[^}]*width:\s*21px;[^}]*height:\s*21px;/s);
    expect(styles).toMatch(/\.content-scroll-area\s*\{[\s\S]*padding-bottom:\s*calc\(var\(--mobile-section-switcher-height\) \+ env\(safe-area-inset-bottom\) \+ 0\.75rem\);/);
  });

  it('exposes Flight Deck reference copy actions in record menus', () => {
    expect(html).toContain("copyFlightDeckReference('doc', $store.chat.selectedDocId");
    expect(html).toContain("copyFlightDeckReference('task', $store.chat.editingTask.record_id");
    expect(html).toContain("copyFlightDeckReference('chat', $store.chat.buildChatMessageFlightDeckReferenceId(msg.record_id)");
    expect(html).toContain("copyFlightDeckReference('chat', $store.chat.buildChatMessageFlightDeckReferenceId($store.chat.getThreadParentMessage()?.record_id)");
    expect(html).toContain("copyFlightDeckReference('chat', $store.chat.buildChatMessageFlightDeckReferenceId(reply.record_id)");
    expect(html).toContain("copyFlightDeckReference('scope', s1.record_id");
    expect(html).toContain("copyFlightDeckReference('scope', s5.record_id");
    expect(html).toContain("copyFlightDeckReference('directory', $store.chat.currentFolder.record_id");
    expect(html).toContain("copyFlightDeckReference('channel', $store.chat.selectedChannelId");
    expect(html).toContain("copyFlightDeckReference('report'");
    expect((html.match(/>FD Ref<\/button>/g) || []).length).toBeGreaterThanOrEqual(16);
  });

  it('keeps logged-in chrome fixed above one content scroll area', () => {
    const mainContentIndex = html.indexOf('class="main-content"');
    const globalBarIndex = html.indexOf('class="global-pg-channel-bar"', mainContentIndex);
    const scrollAreaIndex = html.indexOf('class="content-scroll-area"', mainContentIndex);
    const modalIndex = html.indexOf('class="doc-modal-backdrop channel-settings-modal-backdrop"', mainContentIndex);

    expect(mainContentIndex).toBeGreaterThan(-1);
    expect(globalBarIndex).toBeGreaterThan(mainContentIndex);
    expect(scrollAreaIndex).toBeGreaterThan(globalBarIndex);
    expect(modalIndex).toBeGreaterThan(scrollAreaIndex);
    expect(styles).toMatch(/\.main-content\s*\{[\s\S]*overflow:\s*hidden;/);
    expect(styles).toMatch(/\.content-scroll-area\s*\{[\s\S]*overflow-y:\s*auto;/);
    expect(styles).toMatch(/\.global-pg-channel-bar\s*\{[\s\S]*flex:\s*0 0 auto;/);
  });

  it('keeps channel tabs text-only while labels resolve through getChannelLabel', () => {
    expect(html).not.toContain('class="chat-channel-avatar"');
    expect(html).not.toContain('getChannelDmPeerNpub');
    expect(html.match(/getChannelLabel/g)?.length || 0).toBeGreaterThanOrEqual(5);
  });

  it('resolves profile identities in channel access rows', () => {
    expect(html).toContain('getPgChannelGrantPrincipalNpub(grant)');
    expect(html).toContain('getPgChannelGrantPrincipalLabel(grant)');
  });

  it('adds Get it done actions to every chat message surface', () => {
    const matches = html.match(/Get it done/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('data-chat-get-it-done="true"');
    expect(html).toContain('data-source-surface="main_feed"');
    expect(html).toContain('data-source-surface="thread_parent"');
    expect(html).toContain('data-source-surface="thread_reply"');
  });

  it('renders the chat Get it done modal hooks', () => {
    expect(html).toContain('data-testid="chat-get-it-done-modal"');
    expect(html).toContain('data-testid="chat-get-it-done-title"');
    expect(html).toContain('data-testid="chat-get-it-done-assignee"');
    expect(html).toContain('chatGetItDoneAssigneeSuggestions');
    expect(html).toContain('selectChatGetItDoneAssignee');
    expect(html).toContain('data-testid="chat-get-it-done-output-type"');
    expect(html).toContain('data-testid="chat-get-it-done-scope"');
    expect(html).toContain('chatGetItDoneScopeSuggestions');
    expect(html).toContain('selectChatGetItDoneScope');
    expect(html).toContain('data-testid="chat-get-it-done-submit"');
  });

  it('renders the dedicated chat-thread dispatch modal hooks', () => {
    expect(html).toContain('data-testid="chat-thread-flow-dispatch-modal"');
    expect(html).toContain('data-testid="chat-thread-flow-dispatch-flow-select"');
    expect(html).toContain('data-testid="chat-thread-flow-dispatch-scope-select"');
    expect(html).toContain('data-testid="chat-thread-flow-dispatch-launch-notes"');
    expect(html).toContain('data-testid="chat-thread-flow-dispatch-preview"');
    expect(html).toContain('data-testid="chat-thread-flow-dispatch-regenerate"');
    expect(html).toContain('data-testid="chat-thread-flow-dispatch-stale-warning"');
    expect(html).toContain('data-testid="chat-thread-flow-dispatch-submit"');
    expect(html).toContain('<dt>Clicked message</dt>');
    expect(html).toContain('<dt>Canonical thread</dt>');
    expect(html).toContain('<dt>Thread messages</dt>');
    expect(html).toContain('<dt>Source surface</dt>');
  });
});
