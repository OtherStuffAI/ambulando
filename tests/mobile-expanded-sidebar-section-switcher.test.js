import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createShellState } from '../src/shell-state.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

const mobileSelectorStart = html.indexOf('class="mobile-scope-switcher"');
const mobileSelectorEnd = html.indexOf('<section class="auth-panel"', mobileSelectorStart);
const mobileSelector = html.slice(mobileSelectorStart, mobileSelectorEnd);
const sidebarStart = html.indexOf('<nav class="sidebar"');
const sidebarEnd = html.indexOf('<div class="main-content">', sidebarStart);
const sidebar = html.slice(sidebarStart, sidebarEnd);
const globalBarStart = html.indexOf('class="global-pg-channel-bar"');
const globalBarEnd = html.indexOf('<div class="content-scroll-area"', globalBarStart);
const globalBar = html.slice(globalBarStart, globalBarEnd);
const expandedSwitcher = globalBar.match(/<nav\s+class="expanded-sidebar-section-switcher"[\s\S]*?<\/nav>/)?.[0] ?? '';

describe('expanded left-column section switcher', () => {
  it('keeps the approved collapsed mobile scope, channel, sidebar, and compact controls', () => {
    expect(mobileSelector).toContain('x-show="$store.chat.isLoggedIn && !$store.chat.mobileNavOpen"');
    expect(mobileSelector).toContain('class="mobile-scope-context-controls"');
    expect(mobileSelector).toContain('class="mobile-scope-trigger"');
    expect(mobileSelector).toContain('class="mobile-scope-workspace-avatar-btn"');
    expect(mobileSelector).toContain('@click="$store.chat.openCommandPaletteScopeSwitcher($event)"');

    expect(sidebar).toContain('class="sidebar-nav" x-show="$store.chat.navCollapsed && !$store.chat.mobileNavOpen"');
    expect(globalBar).toContain('class="channel-row-scope-switcher"');
    expect(globalBar).toContain('class="chat-channel-tab-scroll" x-show="$store.chat.navCollapsed && !$store.chat.mobileNavOpen"');
    expect(globalBar).toContain('class="mobile-section-switcher" x-show="!$store.chat.mobileNavOpen"');
  });

  it('renders exactly one labelled section set in the shared top bar for either expanded-column state', () => {
    expect(html.match(/class="expanded-sidebar-section-switcher"/g)).toHaveLength(1);
    expect(expandedSwitcher).toContain('x-show="!$store.chat.navCollapsed || $store.chat.mobileNavOpen"');
    expect(expandedSwitcher).toContain('aria-label="Flight Deck sections"');
    expect(mobileSelector).not.toContain('section-switcher');

    for (const [section, label] of [
      ['status', 'Deck'],
      ['chat', 'Chat'],
      ['tasks', 'Tasks'],
      ['docs', 'Docs'],
      ['files', 'Files'],
      ['settings', 'Setup'],
      ['agents', 'Agents'],
    ]) {
      expect(expandedSwitcher).toContain(`navigateTo('${section}')`);
      expect(expandedSwitcher).toContain(`$store.chat.navSection === '${section}' ? 'page' : null`);
      expect(expandedSwitcher).toMatch(new RegExp(`>${label}<\\/span>`));
    }

    expect(expandedSwitcher.match(/class="expanded-sidebar-section-icon"/g)).toHaveLength(7);
    expect(expandedSwitcher.match(/navigateTo\('settings'\)/g)).toHaveLength(1);
    const setupButton = expandedSwitcher.match(/<button[^>]*navigateTo\('settings'\)[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    const canonicalSetupItem = sidebar.match(/<li[^>]*navSection === 'settings'[^>]*>[\s\S]*?<\/li>/)?.[0] ?? '';
    const setupGear = setupButton.match(/<svg[\s\S]*?<\/svg>/)?.[0].replace(/\s+/g, '') ?? '';
    const canonicalGear = canonicalSetupItem.match(/<svg[\s\S]*?<\/svg>/)?.[0].replace(/\s+/g, '') ?? '';
    expect(setupButton).toContain('class="expanded-sidebar-section-switcher-btn"');
    expect(setupButton).not.toContain('mobileNavOpen');
    expect(setupButton).not.toContain('mobile-only');
    expect(setupGear).toBe(canonicalGear);
  });

  it('removes the actual expanded left-column navigation set and its layout space', () => {
    expect(sidebar).toContain('class="sidebar-nav" x-show="$store.chat.navCollapsed && !$store.chat.mobileNavOpen"');
    expect(sidebar).toMatch(/<\/ul>\s*<section\s+class="sidebar-scope-navigation"/s);
    expect(sidebar).not.toContain('sidebar-workspace-navigation-divider');
    expect(sidebar).not.toContain('mobile-expanded-section-switcher');
    expect(sidebar.match(/navigateTo\('settings'\)/g)).toHaveLength(1);
    expect(styles).toMatch(/\.sidebar\.sidebar-mobile-open \.sidebar-nav\s*\{[^}]*display:\s*none;/s);
    expect(styles).not.toMatch(/global-pg-channel-bar-sidebar-expanded\s*\{[^}]*display:\s*none;/s);
  });

  it('keeps the full-screen control at the right edge of the same top bar', () => {
    const switcherIndex = globalBar.indexOf('class="expanded-sidebar-section-switcher"');
    const actionsIndex = globalBar.indexOf('class="chat-channel-header-actions"');
    const fullScreenIndex = globalBar.indexOf(":aria-label=\"$store.chat.appHeaderHidden ? 'Show header' : 'Full screen'\"");

    expect(switcherIndex).toBeGreaterThanOrEqual(0);
    expect(actionsIndex).toBeGreaterThan(switcherIndex);
    expect(fullScreenIndex).toBeGreaterThan(actionsIndex);
    expect(globalBar.match(/class="chat-channel-header-actions"/g)).toHaveLength(1);
    expect(globalBar).not.toContain('global-pg-channel-bar-mobile-sidebar-open');
  });

  it('preserves expanded desktop navigation and restores collapsed mobile composition after selection', () => {
    const togglePrimaryNav = app.slice(app.indexOf('togglePrimaryNav()'), app.indexOf('toggleAppHeaderHidden()', app.indexOf('togglePrimaryNav()')));
    const navigateTo = app.slice(app.indexOf('navigateTo(section, options = {})'), app.indexOf('toggleSettings()', app.indexOf('navigateTo(section, options = {})')));

    expect(togglePrimaryNav).toContain('this.mobileNavOpen = !this.mobileNavOpen;');
    expect(togglePrimaryNav).toContain('this.navCollapsed = !this.navCollapsed;');
    expect(navigateTo).toContain('this.mobileNavOpen = false;');
    expect(navigateTo).not.toContain('this.navCollapsed = true;');
  });

  it.each([
    ['expanded laptop', { mobileNavOpen: false, navCollapsed: false }],
    ['expanded mobile', { mobileNavOpen: true, navCollapsed: true }],
  ])('selects canonical settings from %s state and keeps the settings deep-link route', (_label, navigationState) => {
    const shell = createShellState();
    Object.assign(shell, navigationState, {
      clearInactiveSectionData: vi.fn(),
      syncRoute: vi.fn(),
      startWorkspaceLiveQueries: vi.fn(),
      ensureBackgroundSync: vi.fn(),
    });

    shell.navigateTo('settings');

    expect(shell.navSection).toBe('settings');
    expect(shell.mobileNavOpen).toBe(false);
    expect(shell.navCollapsed).toBe(navigationState.navCollapsed);
    expect(shell.syncRoute).toHaveBeenCalledTimes(1);
    expect(shell.getRoutePath('settings')).toMatch(/\/settings$/);
  });

  it('keeps touch, keyboard focus, active state, and horizontal overflow behavior', () => {
    expect(styles).toMatch(/\.expanded-sidebar-section-switcher\s*\{[^}]*overflow-x:\s*auto;[^}]*touch-action:\s*pan-x;/s);
    expect(styles).toMatch(/\.expanded-sidebar-section-switcher-btn\s*\{[^}]*min-height:\s*44px;/s);
    expect(styles).toMatch(/\.expanded-sidebar-section-switcher-btn:focus-visible\s*\{[^}]*outline:\s*2px solid #2563eb;/s);
    expect(styles).toMatch(/\.expanded-sidebar-section-switcher-btn-active\s*\{[^}]*background:\s*#eff6ff;/s);
    expect(styles).not.toContain('expanded-sidebar-section-switcher-btn-mobile-only');
  });
});
