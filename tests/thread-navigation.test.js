import { describe, expect, it, vi } from 'vitest';

import { autopilotOverviewManagerMixin } from '../src/autopilot-overview-manager.js';
import {
  resolveHorizontalSwipe,
  resolveVisibleThreadNeighbour,
  shouldSuppressThreadNavigation,
} from '../src/thread-navigation.js';

const row = (id, timestamp, extra = {}) => ({
  id,
  rootRecordId: id,
  channelId: `channel-${id}`,
  latestMessageUpdatedAt: timestamp,
  ...extra,
});

describe('sequential thread navigation', () => {
  const newestFirst = [
    row('newest', '2026-08-07T12:00:00Z'),
    row('middle', '2026-08-07T11:00:00Z'),
    row('oldest', '2026-08-07T10:00:00Z'),
  ];

  it('moves Right/older and Left/newer according to visible-list ordering', () => {
    expect(resolveVisibleThreadNeighbour(newestFirst, 'newest', 'older')?.id).toBe('middle');
    expect(resolveVisibleThreadNeighbour(newestFirst, 'middle', 'newer')?.id).toBe('newest');

    const oldestFirst = [...newestFirst].reverse();
    expect(resolveVisibleThreadNeighbour(oldestFirst, 'newest', 'older')?.id).toBe('middle');
    expect(resolveVisibleThreadNeighbour(oldestFirst, 'middle', 'newer')?.id).toBe('newest');
  });

  it('stops at both list boundaries without wrapping', () => {
    expect(resolveVisibleThreadNeighbour(newestFirst, 'newest', 'newer')).toBeNull();
    expect(resolveVisibleThreadNeighbour(newestFirst, 'oldest', 'older')).toBeNull();
  });

  it('captures only chat rows in the filtered, currently visible Inbox slice', () => {
    const included = row('included', '2026-08-07T12:00:00Z', { inboxKind: 'chat' });
    const otherChat = row('other-chat', '2026-08-07T11:00:00Z', { inboxKind: 'chat' });
    const excludedBySearch = row('excluded', '2026-08-07T10:00:00Z', { inboxKind: 'chat' });
    const store = Object.create(autopilotOverviewManagerMixin);
    Object.defineProperties(store, {
      visibleAutopilotOverviewInbox: { value: [included, { id: 'task', inboxKind: 'task' }, otherChat] },
      pagedAutopilotOverviewThreads: { value: [included, otherChat, excludedBySearch] },
    });

    store.captureDeckThreadNavigationRows(included);

    expect(store.deckThreadNavigationRows.map((item) => item.id)).toEqual(['included', 'other-chat']);
  });

  it('suppresses editable and interactive focus while leaving the reading surface eligible', () => {
    const eventFor = (match) => ({
      key: 'ArrowRight',
      target: { closest: vi.fn(() => match ? {} : null) },
    });
    expect(shouldSuppressThreadNavigation(eventFor(true))).toBe(true);
    expect(shouldSuppressThreadNavigation(eventFor(false))).toBe(false);
    expect(shouldSuppressThreadNavigation({ ...eventFor(false), isComposing: true })).toBe(true);
    expect(shouldSuppressThreadNavigation({ ...eventFor(false), altKey: true })).toBe(true);
  });

  it('recognises deliberate horizontal swipes and rejects short, vertical, and edge gestures', () => {
    expect(resolveHorizontalSwipe({ x: 200, y: 100 }, { x: 100, y: 110 }, { viewportWidth: 400 })).toBe('older');
    expect(resolveHorizontalSwipe({ x: 100, y: 100 }, { x: 180, y: 105 }, { viewportWidth: 400 })).toBe('newer');
    expect(resolveHorizontalSwipe({ x: 100, y: 100 }, { x: 145, y: 102 }, { viewportWidth: 400 })).toBeNull();
    expect(resolveHorizontalSwipe({ x: 100, y: 100 }, { x: 170, y: 180 }, { viewportWidth: 400 })).toBeNull();
    expect(resolveHorizontalSwipe({ x: 10, y: 100 }, { x: 100, y: 100 }, { viewportWidth: 400 })).toBeNull();
    expect(resolveHorizontalSwipe({ x: 390, y: 100 }, { x: 300, y: 100 }, { viewportWidth: 400 })).toBeNull();
  });

  it('reuses the normal Deck open-thread path for neighbour state changes', async () => {
    const openAutopilotOverviewThread = vi.fn(async function openThread(next) {
      this.activeThreadId = next.rootRecordId;
    });
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      navSection: 'status',
      activeThreadId: 'newest',
      deckThreadNavigationRows: newestFirst,
      openAutopilotOverviewThread,
    });

    await store.navigateDeckThread('older');

    expect(openAutopilotOverviewThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'middle' }),
      { preserveNavigationRows: true, replaceRoute: true },
    );
    expect(store.activeThreadId).toBe('middle');
  });

  it('replaces threads inside one modal history entry and one close returns to Deck', async () => {
    const originalWindow = globalThis.window;
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const back = vi.fn();
    globalThis.window = {
      history: { state: null, pushState, replaceState, back },
    };
    try {
      const routeModes = [];
      const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
        navSection: 'status',
        activeThreadId: null,
        fileMessages: [],
        deckThreadNavigationRows: newestFirst,
        deckThreadReturnContext: { selectedBoardId: 'scope-a' },
        autopilotOverviewThreadOpenRequestId: 0,
        captureDeckReturnContext: vi.fn(() => ({ selectedBoardId: 'scope-a' })),
        applyMessages: vi.fn(),
        openThread(threadId) {
          this.activeThreadId = threadId;
        },
        closeThread: vi.fn(function closeThread() {
          this.activeThreadId = null;
        }),
        restoreDeckReturnContext: vi.fn(),
        syncRoute(replace = false) {
          routeModes.push(replace);
          if (replace) {
            replaceState({ section: 'status', deckThreadModal: true }, '', `?threadid=${this.activeThreadId}`);
          } else {
            pushState({ section: 'status', deckThreadModal: true }, '', `?threadid=${this.activeThreadId}`);
            globalThis.window.history.state = { deckThreadModal: true, deckThreadModalOrigin: '/be-free/flight-deck' };
          }
        },
      });

      await store.openAutopilotOverviewThread(newestFirst[0], { preserveNavigationRows: true });
      await store.navigateDeckThread('older');
      await store.navigateDeckThread('older');
      await store.navigateDeckThread('newer');

      expect(store.activeThreadId).toBe('middle');
      expect(routeModes).toEqual([false, true, true, true]);
      expect(pushState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledTimes(3);
      expect(store.deckThreadReturnContext).toEqual({ selectedBoardId: 'scope-a' });

      expect(store.closeDeckThread()).toBe(true);
      expect(back).toHaveBeenCalledTimes(1);
      expect(store.closeThread).not.toHaveBeenCalled();
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
