import { describe, expect, it } from 'vitest';
import { anchoredMenuPosition } from '../src/sol-accessibility.js';

describe('anchoredMenuPosition', () => {
  it('keeps a short-list menu below its trigger when the viewport has room', () => {
    expect(
      anchoredMenuPosition(
        { top: 100, right: 300, bottom: 144 },
        { width: 180, height: 120 },
        { width: 800, height: 600 },
      ),
    ).toMatchObject({ left: 120, top: 149, placement: 'bottom' });
  });

  it('flips a bottom-edge menu above its trigger and clamps it into the viewport', () => {
    const position = anchoredMenuPosition(
      { top: 520, right: 794, bottom: 564 },
      { width: 180, height: 120 },
      { width: 800, height: 600 },
    );
    expect(position).toMatchObject({ left: 612, top: 395, placement: 'top' });
    expect(position.top).toBeGreaterThanOrEqual(8);
    expect(position.top + 120).toBeLessThanOrEqual(592);
  });
});
