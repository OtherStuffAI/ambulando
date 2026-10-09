import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

describe('WApp publishing UI contract', () => {
  it('names the component Feed and keeps all v1 filters in its menu', () => {
    const track = html.slice(html.indexOf('data-deck-columns-track'), html.indexOf('<div class="flightdeck-summary-grid"'));
    const rightStack = track.slice(track.indexOf('data-testid="deck-right-stack"'));
    expect(track).toContain('data-deck-column="inbox"');
    expect(rightStack.indexOf('data-deck-column="wapp-updates"')).toBeLessThan(rightStack.indexOf('data-deck-column="recent"'));
    expect(rightStack).toContain('<div class="wapp-updates-heading-title"><h3>Feed</h3></div>');
    expect(rightStack).toContain('aria-label="Feed"');
    expect(rightStack).toContain('aria-label="Feed options"');
    expect(track).not.toContain('WApp Updates');
    expect(rightStack).not.toContain('WApp Recents');
    expect(rightStack).toContain('wappActivityFilterUnread');
    expect(rightStack).toContain('wappActivityFilterSource');
    expect(rightStack).toContain('wappActivityFilterCategory');
    expect(rightStack).toContain('wappActivityFilterChannel');
  });

  it('uses the established popover treatment with accessible open, dismissal, and focus restoration', () => {
    const updates = html.slice(html.indexOf('data-testid="deck-wapp-updates"'), html.indexOf('data-testid="deck-recent-channels"'));

    expect(updates).toContain('class="doc-actions-menu wapp-updates-filter-menu"');
    expect(updates).toContain('class="doc-actions-toggle wapp-updates-filter-trigger"');
    expect(updates).toContain('class="doc-actions-popover wapp-updates-filter-popover"');
    expect(updates).toContain('aria-haspopup="dialog"');
    expect(updates).toContain(':aria-expanded="filtersOpen.toString()"');
    expect(updates).toContain('role="dialog" aria-label="Feed options"');
    expect(updates).toContain('@click.outside="filtersOpen = false"');
    expect(updates).toContain('@keydown.escape.stop.prevent="filtersOpen = false; $nextTick(() => $refs.filterTrigger?.focus())"');
    expect(updates).toContain('if (filtersOpen) $nextTick(() => $refs.firstFilter?.focus())');
  });

  it('keeps selected filters effective while closed and marks the trigger until filters are cleared', () => {
    const updates = html.slice(html.indexOf('data-testid="deck-wapp-updates"'), html.indexOf('data-testid="deck-recent-channels"'));

    expect(updates).toContain("'wapp-updates-filter-trigger-active': $store.chat.hasActiveWappActivityFilters");
    expect(updates).toContain('class="wapp-updates-filter-active-dot"');
    expect(updates).toContain(':disabled="!$store.chat.hasActiveWappActivityFilters"');
    expect(updates).toContain('@click="$store.chat.clearWappActivityFilters()"');
    expect(updates).not.toContain('closeFilters(false); $store.chat.clearWappActivityFilters()');
  });

  it('caps the mobile popover inside the swipe panel usable width', () => {
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.doc-actions-popover\.wapp-updates-filter-popover\s*\{[^}]*width:\s*min\(22rem, calc\(100vw - 6rem\)\);[^}]*max-width:\s*calc\(100vw - 6rem\);/s);
  });

  it('bounds the stacked feed track and scrolls only the feed body', () => {
    const updates = html.slice(html.indexOf('data-testid="deck-wapp-updates"'), html.indexOf('data-testid="deck-recent-channels"'));
    const body = updates.slice(updates.indexOf('class="wapp-updates-body deck-card-scroll"'));

    expect(updates.indexOf('class="autopilot-panel-heading wapp-updates-heading"')).toBeLessThan(updates.indexOf('class="wapp-updates-body deck-card-scroll"'));
    expect(body).toContain('x-show="$store.chat.wappActivityError"');
    expect(body).toContain('x-show="$store.chat.filteredWappActivityItems.length > 0"');
    expect(body).toContain('x-show="!$store.chat.wappActivityBootstrapping && $store.chat.filteredWappActivityItems.length === 0"');
    expect(body).toContain('x-show="$store.chat.wappActivityBootstrapping && $store.chat.filteredWappActivityItems.length === 0"');
    expect(body).toContain('x-show="$store.chat.wappActivityMutes.length > 0"');
    expect(styles).toMatch(/\.deck-right-stack\s*\{[^}]*grid-template-rows:\s*minmax\(7\.5rem, min\(42dvh, 35rem, calc\(var\(--deck-right-stack-height\) - 12\.9rem\)\)\) minmax\(12rem, 1fr\);/s);
    expect(styles).toMatch(/\.deck-right-stack\s*\{[^}]*--deck-right-stack-height:\s*max\(min\(70dvh, 58rem\), 30rem\);/s);
    expect(styles).toMatch(/\.deck-right-stack\s*\{[^}]*overflow:\s*visible;/s);
    expect(styles).toMatch(/\.flightdeck-summary-panel-wapp-updates\s*\{[^}]*align-self:\s*stretch;[^}]*max-height:\s*min\(42dvh, 35rem, calc\(var\(--deck-right-stack-height\) - 12\.9rem\)\);[^}]*overflow:\s*visible;/s);
    expect(styles).toMatch(/\.deck-right-stack > \.flightdeck-summary-panel-wapp-updates\s*\{[^}]*min-height:\s*7\.5rem;/s);
    expect(styles).toMatch(/\.wapp-updates-body\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*flex-direction:\s*column;[^}]*gap:\s*0\.75rem;[^}]*min-height:\s*0;[^}]*padding-top:\s*0\.9rem;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;/s);
    expect(styles).toMatch(/\.wapp-update-list\s*\{[^}]*gap:\s*0\.6rem;[^}]*margin-top:\s*0;/s);
  });

  it('keeps the full title and filter controls in a non-shrinking, single-line header', () => {
    expect(styles).toMatch(/\.wapp-updates-heading\s*\{[^}]*align-items:\s*center;[^}]*flex:\s*0 0 auto;[^}]*min-height:\s*1\.95rem;/s);
    expect(styles).toMatch(/\.wapp-updates-heading-title\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.wapp-updates-heading h3\s*\{[^}]*line-height:\s*1\.25;[^}]*white-space:\s*nowrap;/s);
    expect(styles).toMatch(/\.wapp-updates-heading-actions\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 auto;[^}]*align-items:\s*center;/s);
  });

  it('content-sizes the mobile swipe panel until its body reaches the viewport cap', () => {
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.deck-right-stack > \.flightdeck-summary-panel-wapp-updates\s*\{[^}]*align-self:\s*flex-start;[^}]*height:\s*auto;[^}]*min-height:\s*7\.5rem;[^}]*max-height:\s*calc\(100dvh - var\(--mobile-section-switcher-height\) - 2rem\);[^}]*overflow:\s*visible;/s);
  });

  it('uses plain-text bindings for untrusted WApp titles and summaries', () => {
    const updates = html.slice(html.indexOf('data-testid="deck-wapp-updates"'), html.indexOf('<div class="flightdeck-summary-grid"'));
    expect(updates).toContain('x-text="item.title"');
    expect(updates).toContain('x-text="item.summary"');
    expect(updates).not.toContain('x-html="item.title"');
    expect(updates).not.toContain('x-html="item.summary"');
  });

  it('makes View the only primary action and puts state/mute controls in an accessible per-card menu', () => {
    const updates = html.slice(html.indexOf('data-testid="deck-wapp-updates"'), html.indexOf('<div class="flightdeck-summary-grid"'));
    expect(updates).toContain('class="wapp-update-view"');
    expect(updates).toContain('>View</button>');
    expect(updates).toContain('class="doc-actions-menu wapp-update-actions-menu"');
    expect(updates).toContain('aria-haspopup="menu"');
    expect(updates).toContain('role="menu"');
    expect(updates).toContain('role="menuitem"');
    expect(updates).toContain('@click.outside="open = false"');
    expect(updates).toContain('@keydown.escape.stop.prevent="open = false; $nextTick(() => $refs.actionTrigger?.focus())"');
    expect(updates).toContain('if (open) $nextTick(() => $refs.firstAction?.focus())');
    expect(updates).toContain('markWappActivityRead(item)');
    expect(updates).toContain('markWappActivityUnread(item)');
    expect(updates).toContain('dismissWappActivity(item)');
    expect(updates).toContain("setWappActivityMute('installation'");
    expect(updates).toContain("setWappActivityMute('category'");
    expect(updates).toContain('openWappActivityChannel(item)');
    expect(updates).toContain('openWappActivityLink(item)');
    expect(updates).not.toMatch(/silent action|callback|pipeline tracking/i);
  });

  it('adds accessible single and bulk Feed dismiss controls without card-action propagation', () => {
    const updates = html.slice(html.indexOf('data-testid="deck-wapp-updates"'), html.indexOf('<div class="flightdeck-summary-grid"'));

    expect(updates).toContain('class="wapp-update-dismiss" data-deck-card-action');
    expect(updates).toContain(':aria-label="`Dismiss ${item.title || \'Feed item\'}`"');
    expect(updates).toContain('@click.stop.prevent="$store.chat.dismissWappActivity(item)"');
    expect(updates).toContain('@keydown.enter.stop @keydown.space.stop');
    expect(updates).toContain('class="wapp-updates-dismiss-all"');
    expect(updates).toContain('$store.chat.dismissAllWappActivity(); filtersOpen = false');
    expect(updates).toContain('$store.chat.filteredWappActivityItems.length === 0');
    expect(updates).toContain("'Your Feed is clear.'");
    expect(updates).toContain('role="status" aria-live="polite"');
  });

  it('keeps compact source/time/title/summary metadata and hides routine category/normal priority', () => {
    const updates = html.slice(html.indexOf('data-testid="deck-wapp-updates"'), html.indexOf('<div class="flightdeck-summary-grid"'));
    const card = updates.slice(updates.indexOf('<article class="wapp-update-card"'), updates.indexOf('</article>'));
    expect(card.indexOf('class="wapp-update-source"')).toBeLessThan(card.indexOf('<time'));
    expect(card.indexOf('<time')).toBeLessThan(card.indexOf('<h4'));
    expect(card).toContain('class="wapp-update-summary"');
    expect(card).not.toContain('x-text="item.category"');
    expect(card).not.toContain("`${item.priority || 'normal'} priority`");
    expect(card).toContain("['warning', 'high', 'urgent'].includes(item.priority)");
    expect(styles).toMatch(/\.wapp-update-card \.wapp-update-summary\s*\{[^}]*-webkit-line-clamp:\s*3;/s);
  });

  it('uses the same thin border on every Feed card edge', () => {
    const cardRule = styles.match(/\.wapp-update-card\s*\{([^}]*)\}/s)?.[1] || '';

    expect(cardRule).toMatch(/border:\s*1px solid color-mix\(in srgb, var\(--border\) 28%, transparent\);/);
    expect(styles).not.toMatch(/\.wapp-update-card[^\{]*\{[^}]*(?:border-left|border-inline-start)\s*:/s);
  });

  it('requires explicit channel selection and supports background-only installation administration', () => {
    const modal = html.slice(html.indexOf('wapp-publishing-editor-backdrop'), html.indexOf('x-show="$store.chat.dailyNoteEditorOpen"'));
    expect(html).toContain('openNewWappPublishingEditor()');
    expect(html).toContain('Background-only · no launcher assignment');
    expect(modal).toContain('Can post alerts to Ambulando');
    expect(modal).toContain('No default is selected');
    expect(modal).toContain('wappPublishingDestinationIds.includes(channel.channel_id)');
    expect(modal).toContain('Registered HTTPS open origins');
    expect(modal).toContain('rotateSelectedWappPublisherKey()');
    expect(modal).toContain('revokeSelectedWappPublishingGrant()');
  });

  it('creates publishing channels inline without offering scope creation', () => {
    const modal = html.slice(html.indexOf('wapp-publishing-editor-backdrop'), html.indexOf('x-show="$store.chat.dailyNoteEditorOpen"'));
    expect(modal).toContain('>New channel</button>');
    expect(modal).toContain('wappPublishingNewChannelScopeId');
    expect(modal).toContain('wappPublishingNewChannelName');
    expect(modal).toContain('createWappPublishingChannel()');
    expect(modal).toContain('Create and select');
    expect(modal).not.toMatch(/New scope|createWappPublishingScope/i);
  });

  it('offers default-on My WApps coordination for new installations and a partial-success retry', () => {
    const modal = html.slice(html.indexOf('wapp-publishing-editor-backdrop'), html.indexOf('x-show="$store.chat.dailyNoteEditorOpen"'));
    expect(modal).toContain('x-show="$store.chat.isNewWappPublishingInstallation"');
    expect(modal).toContain('x-model="$store.chat.wappPublishingAddToMyWapps"');
    expect(modal).toContain('wappPublishingLauncherLaunchUrl');
    expect(modal).toContain('wappPublishingLauncherDescription');
    expect(modal).toContain('wappPublishingLauncherIconUrl');
    expect(modal).toContain('Publishing grant saved');
    expect(modal).toContain('retryWappPublishingLauncher()');
  });

  it('uses a fixed header/footer shell around the independently scrolling setup content', () => {
    const modal = html.slice(html.indexOf('wapp-publishing-editor-backdrop'), html.indexOf('x-show="$store.chat.dailyNoteEditorOpen"'));
    expect(modal.indexOf('wapp-publishing-editor-header')).toBeLessThan(modal.indexOf('wapp-publishing-editor-scroll'));
    expect(modal.indexOf('wapp-publishing-editor-scroll')).toBeLessThan(modal.indexOf('wapp-publishing-editor-footer'));
    expect(modal).toContain('aria-label="Close WApp publishing setup"');
  });
});
