import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('avatar startup receive progress presentation', () => {
  it('keeps active startup receive progress off the fixed content overlay', () => {
    expect(html).not.toContain('class="startup-sync-status"');
    expect(html).not.toContain('class="catchup-overlay"');
    expect(html).not.toContain('x-if="$store.chat.catchUpSyncActive"');
    expect(html).toContain('x-show="$store.chat.showSyncProgressModal"');
  });

  it('uses the existing avatar button and menu as the on-demand disclosure', () => {
    expect(html).toContain("'avatar-status-receiving': $store.chat.startupSyncProgress.visible && $store.chat.startupSyncProgress.active");
    expect(html).toContain('@click="$store.chat.showAvatarMenu = !$store.chat.showAvatarMenu"');
    expect(html).toContain(':aria-label="$store.chat.avatarControlTitle"');
    expect(html).toContain(':aria-expanded="$store.chat.showAvatarMenu ? \'true\' : \'false\'"');
    expect(html).toContain('class="avatar-menu-section startup-sync-progress-panel" x-show="$store.chat.startupSyncProgress.visible" role="status" aria-live="polite"');
    expect(html).toContain('x-text="$store.chat.startupSyncProgressLabel()"');
    expect(html).toContain('x-text="$store.chat.startupSyncProgressMeta()"');
    expect(html).toContain('@click="$store.chat.retryStartupSync()">Retry updates</button>');
  });

  it('rotates only an orange/yellow ring pseudo-element and keeps it static for reduced motion', () => {
    expect(css).toMatch(/\.avatar-chip\.avatar-status-receiving::before\s*\{[^}]*conic-gradient\(#f97316, #facc15, #fb923c, #f97316\)[^}]*animation: avatar-receive-ring/s);
    expect(css).toMatch(/@keyframes avatar-receive-ring\s*\{\s*to \{ transform: rotate\(360deg\); \}\s*\}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.avatar-chip\.avatar-status-receiving::before,[^}]*animation: none;/s);

    const avatarImageRule = css.match(/\.avatar-chip img\s*\{([^}]*)\}/)?.[1] || '';
    expect(avatarImageRule).not.toContain('animation:');
    expect(avatarImageRule).not.toContain('transform:');
  });

  it('keeps the progress panel within narrow viewports and the avatar touch target at 48px', () => {
    expect(css).toMatch(/\.avatar-chip\s*\{[^}]*width: 48px;[^}]*height: 48px;/s);
    expect(css).toMatch(/\.startup-sync-progress-panel\s*\{[^}]*width: min\(15rem, calc\(100vw - 3rem\)\);/s);
  });
});
