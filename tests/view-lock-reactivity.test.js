// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Alpine from 'alpinejs';
import { createShellState } from '../src/shell-state.js';

describe('view lock composer reactivity', () => {
  it('retains the mobile lock through drawer toggles and clears it at collapsed desktop width', () => {
    const originalWidth = window.innerWidth;
    try {
      window.innerWidth = 375;
      const store = createShellState({ initialSection: 'tasks' });
      store.navCollapsed = true; // Exercise the collapsed desktop state explicitly; Sol opens expanded.
      expect(store.mobileNavOpen).toBe(false);
      expect(store.canLockCurrentView).toBe(true);
      store.toggleCurrentViewLock();
      store.togglePrimaryNav();
      expect(store.mobileNavOpen).toBe(true);
      expect(store.isCurrentViewLocked).toBe(true);
      store.togglePrimaryNav();
      expect(store.mobileNavOpen).toBe(false);
      expect(store.isCurrentViewLocked).toBe(true);
      window.innerWidth = 1200;
      store.updateNavigationViewport();
      expect(store.canLockCurrentView).toBe(false);
      expect(store.lockedView).toBeNull();
      window.innerWidth = 320;
      store.updateNavigationViewport();
      expect(store.canLockCurrentView).toBe(true);
      expect(store.lockedView).toBeNull();
    } finally { window.innerWidth = originalWidth; }
  });
  it('does not invalidate navigation effects when composer text changes', async () => {
    const store = Alpine.reactive(createShellState({ initialSection: 'chat' }));
    store.navCollapsed = false;
    store.toggleCurrentViewLock();
    let navigationRuns = 0;
    const runner = Alpine.effect(() => {
      void store.navSection;
      void store.isCurrentViewLocked;
      navigationRuns += 1;
    });
    try {
      for (let index = 0; index < 200; index += 1) {
        store.messageInput = `message ${index}`;
        store.threadInput = `reply ${index}`;
        store.navSection = 'chat';
      }
      await Promise.resolve();
      expect(navigationRuns).toBe(1);
      expect(store.isCurrentViewLocked).toBe(true);
      store.navSection = 'tasks';
      expect(store.lockedView).toBeNull();
      await Promise.resolve();
      expect(navigationRuns).toBeGreaterThan(1);
    } finally {
      Alpine.release(runner);
    }
  });
});
