import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

describe('WApp publishing UI contract', () => {

  it('content-sizes the mobile swipe panel until its body reaches the viewport cap', () => {
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.deck-right-stack > \.flightdeck-summary-panel-wapp-updates\s*\{[^}]*align-self:\s*flex-start;[^}]*height:\s*auto;[^}]*min-height:\s*7\.5rem;[^}]*max-height:\s*calc\(100dvh - var\(--mobile-section-switcher-height\) - 2rem\);[^}]*overflow:\s*visible;/s);
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
