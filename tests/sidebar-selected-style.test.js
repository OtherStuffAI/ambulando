import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|})\\s*${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match[1];
}

describe('selected left navigation styling', () => {
  it('keeps the selected semantic fill and emphasis without a border or outline', () => {
    const active = declarationsFor('.sidebar-nav li.active');

    expect(active).toMatch(/background:\s*var\(--muted\);/);
    expect(active).toMatch(/color:\s*var\(--primary\);/);
    expect(active).toMatch(/font-weight:\s*700;/);
    expect(active).not.toMatch(/(?:^|[;\s])border(?:-left)?:/);
    expect(active).not.toMatch(/(?:^|[;\s])outline:/);
    expect(active).not.toMatch(/(?:^|[;\s])box-shadow:/);
  });
});
