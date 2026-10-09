import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('version banner responsive and accessible styling', () => {
  it('provides visible keyboard focus for the disclosure and independent actions', () => {
    expect(css).toMatch(/\.update-banner-summary:focus-visible,[\s\S]*\.update-banner-btn:focus-visible/);
    expect(css).toMatch(/outline:\s*2px solid var\(--ring\)/);
  });

  it('bounds the expanded panel and adapts the controls on narrow screens', () => {
    expect(css).toMatch(/\.update-banner-panel\s*{[\s\S]*max-height:\s*min\(50vh, 24rem\)[\s\S]*overflow:\s*auto/);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*\.update-banner-bar\s*{\s*flex-wrap:\s*wrap/);
  });

  it('defines explicit panel colours for the persisted dark theme', () => {
    expect(css).toMatch(/\[data-theme="dark"\][\s\S]*\.update-banner-panel\s*{\s*background:\s*var\(--card\);\s*color:\s*var\(--foreground\)/);
  });

  it('shows a native busy affordance and a visible update error state', () => {
    expect(css).toMatch(/\.update-banner-btn\.is-updating::before[\s\S]*animation:\s*update-banner-spin/);
    expect(css).toMatch(/\.update-banner-update-error\s*{[\s\S]*color:\s*var\(--destructive\)/);
  });
});
