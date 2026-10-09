import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('rendered markdown code block styling', () => {
  it('covers chat, task, document, and comment markdown surfaces with one component', () => {
    for (const surface of ['.chat-post-markdown', '.doc-block-rendered', '.doc-thread-entry-body', '.task-comment-body']) {
      expect(css).toContain(`${surface} .md-code-block`);
      expect(css).toContain(`${surface} .md-code-scroll`);
    }
  });

  it('keeps long lines unwrapped inside an independently scrollable code area', () => {
    expect(css).toMatch(/\.md-code-scroll[^}]*overflow-x:\s*auto;/s);
    expect(css).toMatch(/\.md-code-scroll code[^}]*width:\s*max-content;[^}]*white-space:\s*pre;/s);
    expect(css).toMatch(/\.md-code-block[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s);
  });

  it('keeps inline code and fenced code styling separate and preserves keyboard focus', () => {
    expect(css).toMatch(/\.chat-post-markdown code,[\s\S]*background:\s*var\(--card\);/);
    expect(css).toMatch(/\.md-code-copy-button:focus-visible\s*\{[^}]*outline:/s);
    expect(css).toMatch(/\.md-code-scroll code[^}]*background:\s*transparent;/s);
  });
});
