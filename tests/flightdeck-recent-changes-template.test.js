import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderDeckCardTextToHtml } from '../src/markdown.js';

const INDEX_PATH = resolve(process.cwd(), 'index.html');
const STYLES_PATH = resolve(process.cwd(), 'src/styles.css');
const OVERVIEW_MANAGER_PATH = resolve(process.cwd(), 'src/autopilot-overview-manager.js');

describe('flight deck summary template', () => {
  it('renders the summary overview on the Flight Deck home page', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    const statusIndex = html.indexOf('navSection === \'status\'');
    const summaryIndex = html.indexOf('data-testid="flightdeck-summary-overview"', statusIndex);

    expect(summaryIndex).toBeGreaterThan(statusIndex);
    expect(html).toContain('<h2 x-text="$store.chat.dashboardGreetingText"></h2>');
    expect(html).toContain('x-text="$store.chat.autopilotOverviewContextLabel"');
    expect(html).toContain('class="launcher-stack-panel my-agents-panel agents-stack-panel"');
    expect(html).toContain('aria-label="My WApps"');
    expect(html).toContain('<h3>My Agents</h3>');
    expect(html).toContain('class="launcher-pill autopilot-agent-launcher"');
    expect(html).toContain('class="agents-stack-hitbox"');
    expect(html).toContain('$store.chat.visiblePersonalAgents.length > 1');
    expect(html).toContain('$store.chat.personalAgentsOverlayOpen');
    expect(html).toContain('Dive Deeper in Autopilot');
    expect(html).toContain('class="launcher-avatar-ring autopilot-agent-avatar-ring"');
    expect(html).toContain('x-text="$store.chat.previewPersonalAgents[0]?.title || \'Autopilot agent\'"');
    expect(html).not.toContain('aria-label="Open Autopilot">Open Autopilot</button>');
    expect(html).not.toContain('class="autopilot-overview-greeting"');
    expect(html).not.toContain('x-text="$store.chat.autopilotOverviewGreeting"');
    expect(html).toContain('data-testid="flightdeck-summary-inbox"');
    expect(html).toContain('x-show="!$store.chat.deckInboxEnabled"');
    expect(html).toContain('data-testid="deck-inbox-enabled"');
    expect(html).toContain('data-testid="flightdeck-summary-daily-scope"');
    expect(html).toContain('data-testid="flightdeck-summary-threads"');
    expect(html).toContain('data-testid="flightdeck-summary-tasks"');
    expect(html).toContain('data-testid="flightdeck-summary-documents"');
    expect(html).toContain('data-testid="flightdeck-summary-files"');
  });

  it('uses attention card styles for summary rows', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('<div class="attention-card flightdeck-summary-card flightdeck-summary-card-chat"');
    expect(html).toContain('<div class="attention-card flightdeck-summary-card flightdeck-summary-card-task"');
    expect(html).toContain('<div class="attention-card flightdeck-summary-card flightdeck-summary-card-doc"');
    expect(html).toContain('class="attention-card flightdeck-summary-card flightdeck-summary-card-file"');
    expect(html).toContain('attention-card-new-dot');
    expect(html).toContain('x-html="$store.chat.getAttentionIconSvg(\'chat\')"');
    expect(html).toContain('x-html="$store.chat.getAttentionIconSvg(\'task\')"');
    expect(html).toContain('x-html="$store.chat.getAttentionIconSvg(\'doc\')"');
    expect(html).toContain('@click="if ($store.chat.shouldOpenDeckCard($event)) $store.chat.openAutopilotOverviewThread(thread)"');
    expect(html).toContain('@click="if ($store.chat.shouldOpenDeckCard($event)) $store.chat.openAutopilotOverviewTask(task)"');
    expect(html).toContain('@click="if ($store.chat.shouldOpenDeckCard($event)) $store.chat.openAutopilotOverviewDocument(doc)"');
    expect(html).toContain('@click="$store.chat.openFileBrowserSource(file)"');
  });

  it('binds the Inbox pastel treatment to each supported resource unread flag', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');
    const inbox = html.slice(
      html.indexOf('data-testid="flightdeck-summary-inbox"'),
      html.indexOf('<div class="flightdeck-summary-grid"')
    );

    expect(inbox.match(/'flightdeck-summary-card-inbox-unread': item\.isUnread/g)).toHaveLength(3);
    expect(inbox).toMatch(/item\.inboxKind === 'chat'[\s\S]*flightdeck-summary-card-inbox-unread/);
    expect(inbox).toMatch(/item\.inboxKind === 'task'[\s\S]*flightdeck-summary-card-inbox-unread/);
    expect(inbox).toMatch(/item\.inboxKind === 'document'[\s\S]*flightdeck-summary-card-inbox-unread/);
    expect(inbox).not.toMatch(/item\.inboxKind === 'file'[\s\S]*flightdeck-summary-card-inbox-unread/);
    expect(styles).toMatch(/--unread-pastel-red:\s*rgba\(254, 226, 226, 0\.62\)/);
    expect(styles).toMatch(/\.flightdeck-summary-panel-inbox \.flightdeck-summary-card-inbox-unread,[\s\S]*background:\s*var\(--unread-pastel-red\)/);
    expect(styles).toMatch(/\.chat-post-thread-unread,[\s\S]*background:\s*var\(--unread-pastel-red\)/);
  });

  it('binds Inbox working cards to cached row state, not a live activity scan helper', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');
    const inbox = html.slice(
      html.indexOf('data-testid="flightdeck-summary-inbox"'),
      html.indexOf('<div class="flightdeck-summary-grid"')
    );

    expect(html).not.toContain('isDeckInboxItemWorking');
    expect(inbox).not.toMatch(/\$store\.chat\.[^"'`<>]*Working\(\s*item\s*\)/);
    expect(inbox).not.toContain('agentActivities');
    expect(inbox.match(/'flightdeck-summary-card-inbox-working': item\.isWorking/g)).toHaveLength(3);
    expect(inbox).toMatch(/item\.inboxKind === 'chat'[\s\S]*flightdeck-summary-card-inbox-working/);
    expect(inbox).toMatch(/item\.inboxKind === 'task'[\s\S]*flightdeck-summary-card-inbox-working/);
    expect(inbox).toMatch(/item\.inboxKind === 'document'[\s\S]*flightdeck-summary-card-inbox-working/);
    expect(inbox).not.toMatch(/item\.inboxKind === 'file'[\s\S]*flightdeck-summary-card-inbox-working/);
    expect(styles).toMatch(/--inbox-working-blue:\s*rgba\(219, 234, 254, 0\.86\)/);
    expect(styles).toMatch(/animation:\s*flightdeck-inbox-working-pulse 2\.1s ease-in-out infinite alternate/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.flightdeck-summary-card-inbox-working[\s\S]*animation:\s*none;/);
  });

  it('keeps a uniform Inbox border while removing only the top accent', () => {
    const styles = readFileSync(STYLES_PATH, 'utf8');

    expect(styles).toMatch(/\.flightdeck-summary-panel-inbox\s*\{[^}]*min-height:\s*0;[^}]*box-shadow:\s*none;/s);
    expect(styles).not.toMatch(/\.flightdeck-summary-panel-inbox\s*\{[^}]*(?:border-top|border-top-left-radius|border-top-right-radius):/s);
    expect(styles).toMatch(/\.flightdeck-summary-panel\s*\{[^}]*border:\s*1px solid[^}]*border-radius:\s*8px;[^}]*box-shadow:\s*inset 0 3px 0/s);
    expect(styles).toMatch(/\.flightdeck-summary-panel-inbox \.flightdeck-summary-card::before\s*\{[^}]*content:\s*none;/s);
  });

  it('uses two desktop columns with Feed above Recent Channels in the right stack', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');
    const track = html.slice(html.indexOf('data-testid="deck-columns-track"'), html.indexOf('<div class="flightdeck-summary-grid"'));
    const rightStack = track.slice(track.indexOf('data-testid="deck-right-stack"'));

    expect(track).toContain('data-deck-column="inbox" data-testid="flightdeck-summary-inbox"');
    expect(rightStack.indexOf('data-deck-column="wapp-updates"')).toBeLessThan(rightStack.indexOf('data-deck-column="recent"'));
    expect(styles).toMatch(/\.deck-columns-track\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1\.7fr\) minmax\(20rem, 1fr\);/s);
    expect(styles).toMatch(/\.deck-right-stack\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(7\.5rem, min\(42dvh, 35rem, calc\(var\(--deck-right-stack-height\) - 12\.9rem\)\)\) minmax\(12rem, 1fr\);[^}]*overflow:\s*visible;/s);
    expect(styles).toMatch(/\.deck-right-stack > \.deck-column\s*\{[^}]*min-height:\s*0;/s);
  });

  it('uses four mounted viewport-width snapping cards at narrow widths with Inbox selected initially', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');
    const overviewManager = readFileSync(OVERVIEW_MANAGER_PATH, 'utf8');

    expect(html).toContain('@scroll.passive="$store.chat.handleDeckColumnsScroll($event)"');
    expect(html).toContain('x-init="$store.chat.initMobileDeck($el)"');
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.deck-columns-track\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;/s);
    const track = html.slice(html.indexOf('data-testid="deck-columns-track"'), html.indexOf('<div class="flightdeck-summary-grid"'));
    expect(html).toContain('data-deck-column="hello-links" data-deck-hello-card role="region" aria-label="Hello and Links"');
    expect(track).toContain('x-for="card in $store.chat.deckMobileCards"');
    expect(overviewManager).toContain("track.insertBefore(helloCard, track.firstElementChild)");
    expect(overviewManager).toMatch(/DECK_MOBILE_CARDS\s*=\s*Object\.freeze\(\[\s*\{ id: 'hello-links',[\s\S]*\{ id: 'inbox',[\s\S]*\{ id: 'wapp-updates',[\s\S]*\{ id: 'recent',/);
    expect(track.indexOf('data-deck-column="inbox"')).toBeLessThan(track.indexOf('data-deck-column="wapp-updates"'));
    expect(track.indexOf('data-deck-column="wapp-updates"')).toBeLessThan(track.indexOf('data-deck-column="recent"'));
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.deck-right-stack\s*\{[^}]*display:\s*contents;/s);
    expect(styles).toMatch(/\.deck-columns-track > \.deck-column,\s*\.deck-columns-track > \.deck-hello-card,\s*\.deck-right-stack > \.deck-column\s*\{[^}]*flex:\s*0 0 100%;[^}]*width:\s*100%;[^}]*scroll-snap-align:\s*start;[^}]*scroll-snap-stop:\s*always;/s);
    expect(styles).toMatch(/\.deck-columns-track:not\(\[data-deck-ready\]\)\s*\{[^}]*visibility:\s*hidden;/s);
  });

  it('keeps each mobile activity heading visible inside its card scroll surface', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');
    const track = html.slice(html.indexOf('data-testid="deck-columns-track"'), html.indexOf('<div class="flightdeck-summary-grid"'));
    const inbox = track.slice(track.indexOf('data-testid="flightdeck-summary-inbox"'), track.indexOf('data-testid="deck-right-stack"'));
    const feed = track.slice(track.indexOf('data-testid="deck-wapp-updates"'), track.indexOf('data-testid="deck-recent-channels"'));
    const recent = track.slice(track.indexOf('data-testid="deck-recent-channels"'));

    expect(inbox).toContain('class="autopilot-panel-heading inbox-panel-heading" data-deck-mobile-sticky-heading');
    expect(feed).toContain('class="autopilot-panel-heading wapp-updates-heading" data-deck-mobile-sticky-heading');
    expect(recent).toContain('class="autopilot-panel-heading" data-deck-mobile-sticky-heading');
    const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 720px)'), styles.indexOf('@media (max-width: 720px)', styles.indexOf('@media (max-width: 720px)') + 1));
    expect(mobileStyles).toMatch(/\[data-deck-mobile-sticky-heading\]\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*2;[^}]*margin:\s*0 -0\.95rem;[^}]*padding:\s*1rem 0\.95rem 0\.75rem;[^}]*border-bottom:[^}]*background:\s*var\(--surface, #fff\);/s);
    expect(mobileStyles).toMatch(/\.deck-columns-track > \.deck-column,\s*\.deck-right-stack > \.deck-column\s*\{[^}]*padding-top:\s*0;/s);
    expect(styles.slice(0, styles.indexOf('@media (max-width: 720px)'))).not.toContain('[data-deck-mobile-sticky-heading]');
  });

  it('keeps New thread visible in the Inbox header', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');
    const heroStart = html.indexOf('class="flightdeck-summary-header"');
    const inboxStart = html.indexOf('data-testid="flightdeck-summary-inbox"');
    const recentStart = html.indexOf('data-testid="deck-recent-channels"');
    const hero = html.slice(heroStart, inboxStart);
    const inbox = html.slice(inboxStart, recentStart);

    expect(hero).not.toContain('openDeckThreadComposer()');
    expect(html.match(/openDeckThreadComposer\(\)/g)).toHaveLength(3);
    expect(inbox).not.toContain('Newest activity first');
    expect(inbox).toMatch(/<\/form>\s*<button type="button" class="deck-new-thread-button" title="New thread" aria-label="New thread" @click="\$store\.chat\.openDeckThreadComposer\(\)"><span aria-hidden="true">\+<\/span><\/button>\s*<div class="doc-actions-menu inbox-read-menu"/);
    expect(inbox).not.toMatch(/role="menuitem"[^>]*>New thread<\/button>/);
    expect(styles).toMatch(/\.deck-new-thread-button:focus-visible\s*\{[^}]*outline:/s);
    expect(inbox).toContain('Mark all tasks as read');
    expect(inbox).toContain('Mark all docs as read');
    expect(inbox).toContain('Mark all chats as read');
    expect(inbox).toContain('Mark everything as read');
  });

  it('provides accessible local Inbox search, progressive results, and a load-more fallback', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');
    const inboxStart = html.indexOf('data-testid="flightdeck-summary-inbox"');
    const recentStart = html.indexOf('data-testid="deck-recent-channels"');
    const inbox = html.slice(inboxStart, recentStart);
    const headingStart = inbox.indexOf('<div class="autopilot-panel-heading inbox-panel-heading" data-deck-mobile-sticky-heading>');
    const headingEnd = inbox.indexOf('</div>\n              <p class="inbox-read-notice"', headingStart);
    const heading = inbox.slice(headingStart, headingEnd);

    expect(inbox).not.toContain('<span>Search Inbox</span>');
    expect(heading).toMatch(/<h3>Inbox<\/h3>\s*<form class="inbox-search-form"/);
    expect(heading).toContain('<form class="inbox-search-form" role="search" @submit.prevent="$store.chat.applyDeckInboxSearch()">');
    expect(heading).toContain('type="search" autocomplete="off" aria-label="Search Inbox"');
    expect(heading).toContain('placeholder="Search"');
    expect(heading).toContain(':value="$store.chat.deckInboxSearchDraft"');
    expect(heading).toContain('@input="$store.chat.setDeckInboxSearchDraft($event.target.value)"');
    expect(heading).toMatch(/<button type="submit" class="inbox-search-submit" title="Search Inbox" aria-label="Search Inbox">\s*<svg[^>]*aria-hidden="true">/);
    expect(heading).toMatch(/<\/form>\s*<button type="button" class="deck-new-thread-button" title="New thread" aria-label="New thread"[^>]*><span aria-hidden="true">\+<\/span><\/button>\s*<div class="doc-actions-menu inbox-read-menu"/);
    expect(inbox).not.toContain('@scroll.passive="$store.chat.handleDeckInboxScroll($event)"');
    expect(inbox).toContain('x-effect="$store.chat.syncDeckInboxContext($store.chat.deckInboxCurrentContextKey, $store.chat.autopilotOverviewContext.scopeId)"');
    expect(inbox).toContain('item in $store.chat.visibleAutopilotOverviewInbox');
    expect(inbox).toContain('No Inbox cards match your search.');
    expect(inbox).toContain('@click="$store.chat.revealMoreDeckInbox()"');
    expect(inbox).toContain('Load older activity');
    expect(styles).toMatch(/\.inbox-search-form input:focus-visible\s*\{[^}]*outline:/s);
    expect(styles).toMatch(/\.inbox-search-submit:focus-visible\s*\{[^}]*outline:/s);
    expect(styles).toMatch(/\.inbox-load-more:focus-visible\s*\{[^}]*outline:/s);
    expect(styles).toMatch(/\.inbox-panel-heading\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*flex-start;[^}]*flex-wrap:\s*nowrap;/s);
    expect(styles).toMatch(/\.inbox-search-form\s*\{[^}]*flex:\s*0 1 28rem;[^}]*min-width:\s*0;[^}]*display:\s*flex;/s);
    expect(styles).toMatch(/\.inbox-search-form input\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.inbox-panel-heading > \.inbox-read-menu\s*\{[^}]*flex:\s*0 0 auto;/s);
  });

  it('keeps Inbox modal clicks separate from the single Recent channel navigation target', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const inboxStart = html.indexOf('data-testid="flightdeck-summary-inbox"');
    const recentStart = html.indexOf('data-testid="deck-recent-channels"');
    const recentEnd = html.indexOf('</section>', recentStart) + '</section>'.length;
    const inbox = html.slice(inboxStart, recentStart);
    const recent = html.slice(recentStart, recentEnd);

    expect(inbox).toContain('$store.chat.openAutopilotOverviewThread(item)');
    expect(recent).toContain('<button type="button" class="deck-recent-channel-row" @click="$store.chat.openDeckRecentChannel(thread)"');
    expect(recent.match(/@click=/g)).toHaveLength(1);
    expect(recent).not.toContain('openAutopilotOverviewThread');
    expect(recent).not.toContain('openDeckThread(');
  });

  it('keeps every Recent Channels card fixed-height with one-line truncated previews', () => {
    const styles = readFileSync(STYLES_PATH, 'utf8');

    expect(styles).toMatch(/\.deck-recent-channel-row\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*4\.9rem;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.deck-recent-channel-copy\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.deck-recent-thread-preview\s*\{[^}]*display:\s*block;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(styles).not.toMatch(/\.deck-recent-thread-preview\s*\{[^}]*(?:-webkit-line-clamp|-webkit-box-orient):/s);
    expect(styles).toMatch(/\.deck-recent-thread-title \.mention-pill,\s*\.deck-recent-thread-preview \.mention-pill\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  });

  it('renders structured mention fields through the shared pill renderer', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');

    expect(html).toContain('class="attention-card-title deck-card-inline-title" x-html="$store.chat.renderDeckCardText(thread.title)"');
    expect(html).toContain('class="attention-card-subtitle deck-card-inline-preview" x-html="$store.chat.renderDeckCardText(thread.latestMessage)"');
    expect(html).toContain('class="attention-card-title deck-card-inline-title" :class="$store.chat.getTaskTitleLengthClass(task.title)" x-html="$store.chat.renderDeckCardText(task.title)"');
    expect(html).toContain('class="attention-card-title deck-card-inline-title" x-html="$store.chat.renderDeckCardText(doc.title)"');
    expect(styles).toMatch(/\.deck-card-inline-title \.mention-pill,[\s\S]*\.deck-card-inline-preview \.mention-pill\s*\{[^}]*max-width:[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);
  });

  it('keeps Deck card content inline and plain while preserving mention pills', () => {
    const rendered = renderDeckCardTextToHtml('**Plain**\n@[Long task](mention:task:task-1) <unsafe>');

    expect(rendered).toContain('**Plain**\n');
    expect(rendered).toContain('class="mention-link mention-pill mention-link-task mention-pill-task"');
    expect(rendered).toContain('data-mention-id="task-1"');
    expect(rendered).toContain('&lt;unsafe&gt;');
    expect(rendered).not.toMatch(/<(p|h[1-6]|ul|ol|blockquote|pre)\b/);
  });

  it('uses valid non-button card containers around interactive mention links', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const summary = html.slice(html.indexOf('data-testid="flightdeck-summary-threads"'), html.indexOf('data-testid="flightdeck-summary-files"'));

    expect(summary).not.toMatch(/<button[^>]*class="attention-card flightdeck-summary-card/);
    expect(summary.match(/role="link" tabindex="0"/g)).toHaveLength(3);
    expect(summary.match(/@keydown\.enter\.prevent=/g)).toHaveLength(3);
    expect(summary.match(/@keydown\.space\.prevent=/g)).toHaveLength(3);
  });

  it('uses collapsible summary quadrant headings with updated labels', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const styles = readFileSync(STYLES_PATH, 'utf8');

    expect(html).toContain('class="summary-panel-heading-toggle"');
    expect(html).toContain('class="overview-panel-pager daily-note-date-pager"');
    expect(html).toContain('class="overview-panel-pager-all"');
    expect(html).toContain('>All</button>');
    expect(html).toContain("showPreviousSummaryPanelPage('chats')");
    expect(html).toContain("showNextSummaryPanelPage('files')");
    expect(html).toContain('$store.chat.pagedAutopilotOverviewThreads');
    expect(html).toContain('$store.chat.pagedAutopilotOverviewFiles');
    expect(html).toContain("'summary-panel-collapsed': $store.chat.isSummaryPanelCollapsed('chats')");
    expect(html).toContain("@click=\"$store.chat.toggleSummaryPanel('chats')\"");
    expect(html).toContain('<h3>Chats</h3>');
    expect(html).toContain('<h3>Docs</h3>');
    expect(html).not.toContain('<h3>Threads</h3>');
    expect(html).not.toContain('<h3>Docs and Comments</h3>');
    expect(styles).toMatch(/summary-panel-collapsed[\s\S]*min-height:\s*0;/);
    expect(styles).toMatch(/flightdeck-summary-header h2[\s\S]*white-space:\s*pre-line;/);
  });

  it('configures an ordered, keyboard-reorderable Autopilot agent list', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('id="wingman-harness-agent-input"');
    expect(html).toContain('x-model="$store.chat.wingmanHarnessAgentQuery"');
    expect(html).toContain('@input="$store.chat.handleHarnessAgentInput($event.target.value)"');
    expect(html).toContain('x-show="$store.chat.harnessAgentSuggestions.length > 0"');
    expect(html).toContain('@click="$store.chat.selectHarnessAgent(person.npub)"');
    expect(html).toContain('id="wingman-harness-input"');
    expect(html).toContain('x-for="(entry, index) in $store.chat.workspaceHarnessAgents"');
    expect(html).toContain("moveHarnessAgent(index, 'up')");
    expect(html).toContain("moveHarnessAgent(index, 'down')");
    expect(html).toContain('Save My Agents');
    expect(html).toContain('Can read and edit my Daily Scope');
    expect(html).toContain('Test link');
  });

  it('does not expose the removed calendar surface', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).not.toContain("navigateTo('calendar')");
    expect(html).not.toContain("navSection === 'calendar'");
    expect(html).not.toContain('<span class="sidebar-label">Calendar</span>');
  });

  it('keeps schedules hidden while the surface is disabled', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).not.toContain("navigateTo('schedules')");
    expect(html).not.toContain("navSection === 'schedules'");
    expect(html).not.toContain('<span class="sidebar-label">Schedules</span>');
    expect(html).toContain('x-show="false" x-cloak class="settings-tab" :class="{ active: $store.chat.settingsTab === \'schedules\' }"');
  });

  it('moves scopes into settings instead of exposing a top-level section', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).not.toContain("navigateTo('scopes')");
    expect(html).not.toContain("navSection === 'scopes'");
    expect(html).not.toContain('<span class="sidebar-label">Scopes</span>');
    expect(html).toContain("settingsTab === 'scopes'");
  });

  it('keeps flows hidden while the surface is disabled', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).not.toContain("navigateTo('flows')");
    expect(html).not.toContain("navSection === 'flows'");
    expect(html).not.toContain('<span class="sidebar-label">Flows</span>');
    expect(html).not.toContain('$store.chat.settingsTab === \'flows\'');
  });

  it('labels setup without changing the settings route', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('@click="$store.chat.navigateTo(\'settings\')">Setup</button>');
    expect(html).toContain('<span class="sidebar-label">Setup</span>');
    expect(html).not.toContain('<span class="sidebar-label">Settings</span>');
  });

  it('hides people and opportunities in the sidebar', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).not.toContain('$store.chat.navSection === \'people\'');
    expect(html).not.toContain('$store.chat.navSection === \'opportunities\'');
  });

  it('exposes files as a top-level sidebar section', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain("navigateTo('files')");
    expect(html).toContain("navSection === 'files'");
    expect(html).toContain('<span class="sidebar-label">Files</span>');
    expect(html).toContain('class="files-section"');
    expect(html).toContain('x-for="row in $store.chat.filteredFileBrowserRows"');
  });

  it('keeps reports hidden from the sidebar and Flight Deck cards', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).not.toContain('<span class="sidebar-label">Reports</span>');
    expect(html).toContain('<section class="flightdeck-reports-section" x-show="false" x-cloak>');
    expect(html).toContain('class="flightdeck-report-card flightdeck-report-card-link"');
  });

  it('keeps in-view channel tabs alongside the new expanded sidebar hierarchy', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('class="page-header" x-show="!$store.chat.appHeaderHidden"');
    expect(html).toMatch(/class="global-pg-channel-bar"[\s\S]*?:class="\{ 'global-pg-channel-bar-sidebar-expanded': !\$store\.chat\.navCollapsed \|\| \$store\.chat\.mobileNavOpen \}"[\s\S]*?x-show="\$store\.chat\.isLoggedIn"/s);
    expect(html).toContain('class="content-scroll-area"');
    expect(html).toContain('class="chat-channel-tab-item"');
    expect(html).toContain('class="chat-channel-tab-scroll" role="tablist" aria-label="Workspace channels"');
    expect(html).toContain('class="chat-channel-tab"');
    expect(html).toContain('class="chat-channel-header-icon-btn"');
    expect(html).toContain('@click="$store.chat.toggleAppHeaderHidden()"');
    expect(html).toContain('@click="$store.chat.openAllScopesOverview()"');
    expect(html).toContain('@click="$store.chat.openWorkContextHome($event)"');
    expect(html).toContain('x-for="channel in $store.chat.pgContextChannels"');
    expect(html).toContain('active: $store.chat.pgContextSelectedChannelId === channel.record_id');
    expect(html).toContain('@click="$store.chat.selectWorkContextChannel(channel.record_id, $event)"');
    expect(html).not.toContain("$store.chat.navSection === 'chat' ? $store.chat.selectChannel(channel.record_id) : $store.chat.selectDeckChannel(channel.record_id)");
    expect(html).toContain('aria-label="New thread" @click="$store.chat.openDeckThreadComposer()"><span aria-hidden="true">+</span></button>');
    expect(html).not.toContain('class="app-header-icon-btn"');
    expect(html).not.toContain('class="app-header-restore"');
    expect(html).toContain(':draggable="!$store.chat.isTowerPgMode || $store.chat.canReorderChannel(channel)"');
    expect(html).toContain('@dragstart="$store.chat.startChannelTabDrag(channel.record_id, $event)"');
    expect(html).toContain('@drop.prevent="$store.chat.dropChannelTab(channel.record_id, $event)"');
    expect(html).toContain('class="chat-channel-menu chat-channel-tab-menu"');
    expect(html).toContain('class="chat-channel-menu-button"');
    expect(html).toContain('@click.stop.prevent="$store.chat.openChannelSettings(channel.record_id)"');
    expect(html).not.toContain('class="chat-channel-tabs"');
    expect(html).not.toContain('class="sidebar-channels"');
    expect(html).not.toContain('class="sidebar-channel-item"');
    expect(html).toContain('class="sidebar-scope-navigation"');
    expect(html).toContain('class="sidebar-scope-channel"');
  });
});
