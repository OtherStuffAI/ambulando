import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  WINGMAN_IPHONE_WEBVIEW_CLASS,
  applyWingmanIphoneWebViewMarker,
  installWingmanIphoneWebViewMarker,
  isWingmanIphoneWebView,
} from '../src/wingman-iphone-webview.js';

const iphoneUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const sourceHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const sourceStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function environment({ userAgent = iphoneUserAgent, wingman = false } = {}) {
  const classes = new Set();
  return {
    windowObject: wingman ? { nostr: { __wingman: true } } : {},
    navigatorObject: { userAgent },
    documentObject: {
      documentElement: {
        classList: {
          toggle(name, force) {
            if (force) classes.add(name);
            else classes.delete(name);
          },
          contains(name) {
            return classes.has(name);
          },
        },
      },
    },
  };
}

describe('Wingman iPhone WebView typography marker', () => {
  it('recognizes the explicit Wingman bridge on iPhone', () => {
    const env = environment({ wingman: true });
    expect(isWingmanIphoneWebView(env)).toBe(true);
    expect(applyWingmanIphoneWebViewMarker(env)).toBe(true);
    expect(env.documentObject.documentElement.classList.contains(WINGMAN_IPHONE_WEBVIEW_CLASS)).toBe(true);
  });

  it.each([
    ['top-level iPhone PWA', { wingman: false }],
    ['non-Wingman iPhone iframe', { wingman: false }],
    ['Wingman Android WebView', { wingman: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36' }],
    ['Wingman desktop WebView', { wingman: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15' }],
  ])('does not mark %s', (_label, options) => {
    const env = environment(options);
    expect(applyWingmanIphoneWebViewMarker(env)).toBe(false);
    expect(env.documentObject.documentElement.classList.contains(WINGMAN_IPHONE_WEBVIEW_CLASS)).toBe(false);
  });

  it('detects the bridge when the Wingman host injects it after page load', () => {
    vi.useFakeTimers();
    const env = environment();
    env.windowObject.setInterval = setInterval;
    env.windowObject.clearInterval = clearInterval;

    const uninstall = installWingmanIphoneWebViewMarker(env);
    env.windowObject.nostr = { __wingman: true };
    vi.advanceTimersByTime(50);

    expect(env.documentObject.documentElement.classList.contains(WINGMAN_IPHONE_WEBVIEW_CLASS)).toBe(true);
    uninstall();
    vi.useRealTimers();
  });

  it('keeps the standalone PWA viewport and vertical layout stable while permitting zoom', () => {
    expect(sourceHtml).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0" />');
    expect(sourceStyles).toMatch(/body\s*\{[^}]*padding:\s*0\.5rem 0;[^}]*height:\s*100dvh;/s);
    expect(sourceStyles).toMatch(/\.app-shell\s*\{[^}]*height:\s*calc\(100dvh - 1rem\);/s);
    expect(sourceStyles).toMatch(/--app-edge-gutter:\s*max\(0\.75rem, env\(safe-area-inset-left\), env\(safe-area-inset-right\)\)/);
  });

  it('scopes a typography-only adjustment to the runtime marker', () => {
    const rule = sourceStyles.match(/html\.wingman-iphone-webview\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(rule).toMatch(/-webkit-text-size-adjust:\s*87\.5% !important/);
    expect(rule).toMatch(/(?:^|\s)text-size-adjust:\s*87\.5% !important/);
    expect(rule).not.toMatch(/(?:font-size|zoom|transform|width|height|padding|margin|safe-area|viewport)/);
  });
});
