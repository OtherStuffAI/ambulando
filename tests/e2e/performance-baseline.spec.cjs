const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

const CHANNEL_ID = 'perf-channel';
const THREAD_ID = 'perf-thread';
const OPERATOR_NPUB = 'npub1perfoperator';
const AGENT_NPUB = 'npub1perfagent';

const BASELINE_TEXT = 'flight deck composer baseline stays exact while typing quickly 0123456789.';

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

function summarize(values) {
  const sample = values.filter((value) => Number.isFinite(value));
  return {
    count: sample.length,
    p50: percentile(sample, 0.5),
    p95: percentile(sample, 0.95),
    max: sample.length ? Math.max(...sample) : 0,
  };
}

async function blockExternalRequests(page) {
  await page.route('**/*', route => {
    if (process.env.FLIGHTDECK_PERF_DIST === '1') return serveBuiltFlightDeck(route);
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    return route.abort();
  });
}

async function waitForStore(page) {
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
}

async function seedWorkspace(page, options = {}) {
  const {
    documentCount = 200,
    historySize = 120,
    taskCount = 200,
  } = options;

  await page.evaluate(({ agentNpub, channelId, documentCount, historySize, operatorNpub, taskCount, threadId }) => {
    const store = window.Alpine.store('chat');
    const now = new Date('2026-09-15T00:00:00.000Z').toISOString();
    const states = ['new', 'ready', 'in_progress', 'blocked', 'done'];
    const makeRow = (prefix, index) => ({
      record_id: `${prefix.toLowerCase()}-${index}`,
      title: `${prefix} ${index}`,
      body: `${prefix} ${index}`,
      description: `${prefix} ${index} description with enough words to look like real workspace content.`,
      record_state: 'active',
      sync_status: 'synced',
      created_at: now,
      updated_at: now,
    });
    const root = {
      record_id: threadId,
      pg_thread_id: threadId,
      thread_id: threadId,
      channel_id: channelId,
      parent_message_id: null,
      sender_npub: operatorNpub,
      body: 'Performance baseline thread root',
      metadata: {},
      record_state: 'active',
      sync_status: 'synced',
      created_at: now,
      updated_at: now,
    };
    const replies = Array.from({ length: historySize }, (_, index) => ({
      record_id: `perf-reply-${index}`,
      pg_thread_id: threadId,
      thread_id: threadId,
      parent_message_id: threadId,
      channel_id: channelId,
      sender_npub: index % 3 === 0 ? agentNpub : operatorNpub,
      body: `Representative reply ${index} for the performance baseline.`,
      metadata: {},
      record_state: 'active',
      sync_status: 'synced',
      created_at: new Date(Date.parse(now) + (index * 1_000)).toISOString(),
      updated_at: new Date(Date.parse(now) + (index * 1_000)).toISOString(),
    }));

    store.startWorkspaceLiveQueries = () => {};
    store.stopTaskCommentsLiveQuery = () => {};
    store.startTaskCommentsLiveQuery = () => {};
    store.syncRoute = () => {};
    store.performSync = () => {};
    store.requestTowerSyncFamily = () => {};
    store.scheduleStorageImageHydration = () => {};
    store.markTaskRead = () => {};
    store.loadTaskComments = async (taskId) => {
      store.applyTaskComments(Array.from({ length: 12 }, (_, index) => ({
        record_id: `${taskId}-comment-${index}`,
        target_record_id: taskId,
        sender_npub: index % 2 === 0 ? operatorNpub : agentNpub,
        body: `Task detail comment ${index} with enough content to render the activity pane.`,
        record_state: 'active',
        sync_status: 'synced',
        created_at: now,
        updated_at: now,
      })));
    };
    store.session = { ...(store.session || {}), npub: operatorNpub };
    store.currentPgActorNpub = operatorNpub;
    store.pgBackendMode = false;
    store.isTowerPgMode = false;
    store.channels = [{
      record_id: channelId,
      title: 'implementation',
      name: 'implementation',
      record_state: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
    }];
    store.selectedChannelId = channelId;
    store.pgContextSelectedChannelId = channelId;
    store.pgWorkspaceMembers = [
      { npub: operatorNpub, display_name: 'Operator', kind: 'person' },
      { npub: agentNpub, display_name: 'Perf Agent', kind: 'agent' },
    ];
    store.addressBookPeople = [{ npub: agentNpub, label: 'Perf Agent', name: 'Perf Agent' }];
    store.groups = [{ record_id: 'perf-group', name: 'Agents', member_npubs: [agentNpub] }];
    store.currentWorkspaceGroups = store.groups;
    store.scopes = Array.from({ length: Math.max(10, Math.ceil(taskCount / 20)) }, (_, index) => ({
      ...makeRow('Scope', index),
      level: 'project',
    }));
    store.messages = [root, ...replies];
    store.documents = Array.from({ length: documentCount }, (_, index) => makeRow('Document', index));
    store.tasks = Array.from({ length: taskCount }, (_, index) => ({
      ...makeRow('Task', index),
      pg_channel_id: channelId,
      state: states[index % states.length],
      tags: [`tag-${index % 9}`, `area-${index % 5}`],
      scheduled_for: index % 6 === 0 ? '2026-09-15' : '',
      assignee_npub: index % 3 === 0 ? agentNpub : '',
      assignee_npubs: index % 3 === 0 ? [agentNpub] : [],
    }));
    store.flows = Array.from({ length: Math.max(5, Math.ceil(taskCount / 50)) }, (_, index) => makeRow('Flow', index));
    store.opportunities = Array.from({ length: Math.max(5, Math.ceil(taskCount / 50)) }, (_, index) => makeRow('Opportunity', index));
    store.navSection = 'chat';
    store.openThread(threadId, { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
  }, {
    agentNpub: AGENT_NPUB,
    channelId: CHANNEL_ID,
    documentCount,
    historySize,
    operatorNpub: OPERATOR_NPUB,
    taskCount,
    threadId: THREAD_ID,
  });

  await expect(page.locator('.chat-thread-panel')).toBeVisible();
  await expect(page.locator('.thread-input-bar [data-chat-composer="thread"]')).toHaveAttribute('contenteditable', 'true');
}

async function installTypingInstrumentation(page) {
  await page.evaluate(() => {
    const composer = document.querySelector('.thread-input-bar [data-chat-composer="thread"]');
    const samples = {
      keydownAt: [],
      keyToInput: [],
      keyToRender: [],
      inputToRender: [],
      longTasks: [],
      frameGaps: [],
      beforeInputCount: 0,
      inputCount: 0,
    };
    window.__flightDeckPerfTyping = samples;
    composer.addEventListener('keydown', () => {
      samples.keydownAt.push(performance.now());
    }, true);
    composer.addEventListener('beforeinput', () => {
      samples.beforeInputCount += 1;
    }, true);
    composer.addEventListener('input', () => {
      const inputAt = performance.now();
      const keyAt = samples.keydownAt[samples.inputCount] || inputAt;
      samples.inputCount += 1;
      samples.keyToInput.push(inputAt - keyAt);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const renderedAt = performance.now();
        samples.inputToRender.push(renderedAt - inputAt);
        samples.keyToRender.push(renderedAt - keyAt);
      }));
    }, true);
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) samples.longTasks.push(entry.duration);
      }).observe({ type: 'longtask' });
    }
    window.__flightDeckPerfFrameLoop = true;
    let previousFrame = performance.now();
    const onFrame = (at) => {
      const gap = at - previousFrame;
      if (gap > 24) samples.frameGaps.push(gap);
      previousFrame = at;
      if (window.__flightDeckPerfFrameLoop) requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
  });
}

async function readTypingMetrics(page, expectedText, extra = {}) {
  return page.evaluate(({ expected, extraMetrics }) => {
    window.__flightDeckPerfFrameLoop = false;
    const samples = window.__flightDeckPerfTyping;
    const composer = document.querySelector('.thread-input-bar [data-chat-composer="thread"]');
    const percentileInPage = (values, ratio) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
    };
    const summary = (values) => ({
      count: values.length,
      p50: percentileInPage(values, 0.5),
      p95: percentileInPage(values, 0.95),
      max: values.length ? Math.max(...values) : 0,
    });
    const renderedValue = composer?.textContent || '';
    const store = window.Alpine.store('chat');
    const modelValue = store.threadInput || '';
    return {
      ...extraMetrics,
      expectedLength: expected.length,
      renderedLength: renderedValue.length,
      renderedValue,
      expectedMatchesRendered: renderedValue === expected,
      modelLength: modelValue.length,
      modelValue,
      expectedMatchesModel: modelValue === expected,
      beforeInputCount: samples.beforeInputCount,
      inputCount: samples.inputCount,
      keyToInputMs: summary(samples.keyToInput),
      inputToRenderMs: summary(samples.inputToRender),
      keyToRenderMs: summary(samples.keyToRender),
      longTaskMs: summary(samples.longTasks),
      longTasksOver50ms: samples.longTasks.filter((duration) => duration > 50).length,
      frameGapMs: summary(samples.frameGaps),
      domNodes: document.querySelectorAll('*').length,
      heapUsed: performance.memory?.usedJSHeapSize || null,
      taskRows: store.tasks.length,
      documentRows: store.documents.length,
      messageRows: store.messages.length,
    };
  }, { expected: expectedText, extraMetrics: extra });
}

async function runTypingScenario(page, scenario, seedOptions) {
  await blockExternalRequests(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  const shellStarted = Date.now();
  await page.goto('/');
  await waitForStore(page);
  const shellReadyMs = Date.now() - shellStarted;
  const seedStarted = Date.now();
  await seedWorkspace(page, seedOptions);
  const composerReadyMs = Date.now() - shellStarted;
  const seedAndComposerReadyMs = Date.now() - seedStarted;
  await installTypingInstrumentation(page);

  const composer = page.locator('.thread-input-bar [data-chat-composer="thread"]');
  await composer.focus();
  const started = Date.now();
  await composer.pressSequentially(BASELINE_TEXT, { delay: Number(process.env.FLIGHTDECK_PERF_KEY_DELAY || 5) });
  await page.waitForTimeout(120);
  const metrics = await readTypingMetrics(page, BASELINE_TEXT, {
    scenario,
    shellReadyMs,
    composerReadyMs,
    seedAndComposerReadyMs,
    elapsedMs: Date.now() - started,
  });
  console.log(`FLIGHTDECK_PERF_BASELINE ${JSON.stringify({ type: 'typing', metrics })}`);

  expect(metrics.expectedMatchesRendered).toBe(true);
  expect(metrics.beforeInputCount).toBe(BASELINE_TEXT.length);
  expect(metrics.inputCount).toBe(BASELINE_TEXT.length);
}

test('captures chat composer typing responsiveness baseline', async ({ page }) => {
  await runTypingScenario(page, 'chat-composer', {
    documentCount: 200,
    historySize: 120,
    taskCount: 200,
  });
});

test('captures heavy-state chat composer typing responsiveness baseline', async ({ page }) => {
  await runTypingScenario(page, 'chat-composer-heavy-state', {
    documentCount: Number(process.env.FLIGHTDECK_PERF_DOCS || 2_000),
    historySize: Number(process.env.FLIGHTDECK_PERF_HISTORY || 800),
    taskCount: Number(process.env.FLIGHTDECK_PERF_TASKS || 2_000),
  });
});

test('captures app shell and seeded navigation timing baseline', async ({ page }) => {
  await blockExternalRequests(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  const shellStarted = Date.now();
  await page.goto('/');
  await waitForStore(page);
  const shellReadyMs = Date.now() - shellStarted;
  const seedStarted = Date.now();
  await seedWorkspace(page, {
    documentCount: Number(process.env.FLIGHTDECK_PERF_DOCS || 2_000),
    historySize: Number(process.env.FLIGHTDECK_PERF_HISTORY || 800),
    taskCount: Number(process.env.FLIGHTDECK_PERF_TASKS || 2_000),
  });
  const composerReadyMs = Date.now() - shellStarted;
  const seedAndComposerReadyMs = Date.now() - seedStarted;

  const navigationMetrics = await page.evaluate(async ({ threadId }) => {
    const store = window.Alpine.store('chat');
    const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const measure = async (label, action) => {
      const started = performance.now();
      await action();
      await nextPaint();
      return { label, ms: performance.now() - started };
    };
    const threadOpen = [];
    for (let index = 0; index < 7; index += 1) {
      await store.closeThread({ saveDraft: false, syncRoute: false });
      await nextPaint();
      threadOpen.push(await measure('thread-open', async () => {
        store.navSection = 'chat';
        store.openThread(threadId, { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
      }));
    }
    const taskDetailOpen = [];
    const taskIds = store.tasks.slice(0, 7).map(task => task.record_id);
    for (const taskId of taskIds) {
      await store.closeTaskDetail({ syncRoute: false, releaseCheckout: false });
      await nextPaint();
      taskDetailOpen.push(await measure('task-detail-open', async () => {
        store.openTaskDetail(taskId, { captureOrigin: false, syncRoute: false });
      }));
    }
    return {
      threadOpenMs: threadOpen.map(sample => sample.ms),
      taskDetailOpenMs: taskDetailOpen.map(sample => sample.ms),
      activeTaskId: store.activeTaskId,
      activeThreadId: store.activeThreadId,
      domNodes: document.querySelectorAll('*').length,
      heapUsed: performance.memory?.usedJSHeapSize || null,
      taskRows: store.tasks.length,
      documentRows: store.documents.length,
      messageRows: store.messages.length,
    };
  }, { threadId: THREAD_ID });

  const metrics = {
    scenario: 'seeded-navigation',
    shellReadyMs,
    composerReadyMs,
    seedAndComposerReadyMs,
    threadOpenMs: summarize(navigationMetrics.threadOpenMs),
    taskDetailOpenMs: summarize(navigationMetrics.taskDetailOpenMs),
    domNodes: navigationMetrics.domNodes,
    heapUsed: navigationMetrics.heapUsed,
    taskRows: navigationMetrics.taskRows,
    documentRows: navigationMetrics.documentRows,
    messageRows: navigationMetrics.messageRows,
  };
  console.log(`FLIGHTDECK_PERF_BASELINE ${JSON.stringify({ type: 'navigation', metrics })}`);

  expect(navigationMetrics.activeThreadId).toBe(THREAD_ID);
  expect(navigationMetrics.activeTaskId).toBeTruthy();
  expect(metrics.threadOpenMs.count).toBe(7);
  expect(metrics.taskDetailOpenMs.count).toBe(7);
});

// Reuses the representative composer fixture; no Tower authority is simulated.
test('preserves editing and navigation during reconnect, retries and lazy asset failures', async ({ page }) => {
  test.setTimeout(30000);
  await blockExternalRequests(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await waitForStore(page);
  await seedWorkspace(page, { documentCount: 20, historySize: 120, taskCount: 20 });
  const composer = page.locator('.thread-input-bar [data-chat-composer="thread"]');
  await composer.fill('draft survives retry');
  await composer.focus();
  const before = await page.evaluate(() => {
    const composer = document.querySelector('.thread-input-bar [data-chat-composer="thread"]');
    const range = document.createRange();
    range.setStart(composer.firstChild, 6);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const scroller = document.querySelector('[data-thread-replies]');
    if (!scroller) throw new Error('Thread scroller is missing');
    scroller.scrollTop = 120;
    window.__retryDocumentIdentity = 'preserved';
    return { scroll: scroller?.scrollTop, channel: window.Alpine.store('chat').selectedChannelId };
  });
  expect(before.scroll).toBeGreaterThan(0);
  await page.context().setOffline(true);
  const result = await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    store.scheduleBackgroundSync = () => {}; // fixture has no live Tower
    store.startupSyncProgress.connectionKey = store.buildSSEConnectionKey();
    for (let attempt = 0; attempt < 3; attempt++) {
      store.handleSSEStatus({ status: 'reconnecting' });
      store.handleSSEStatus({ status: 'catch-up-required' });
      store.beginStartupSyncProgress();
      store.updateStartupSyncProgress({ stage: 'receiving', page: 1 });
      store.finishStartupSyncProgress(new Error('Transient network failure'));
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.resolve(),
        reason: new Error('Failed to fetch dynamically imported module: /assets/unavailable-editor.js'),
      }));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return {
      identity: window.__retryDocumentIdentity,
      focused: document.activeElement?.matches('[data-chat-composer="thread"]'),
      offset: window.getSelection().anchorOffset,
      scroll: document.querySelector('[data-thread-replies]')?.scrollTop,
      channel: store.selectedChannelId,
      thread: store.activeThreadId,
      error: store.startupSyncProgress.error,
    };
  });
  expect(result).toMatchObject({ identity: 'preserved', focused: true, offset: 6, channel: before.channel, thread: THREAD_ID, error: 'Transient network failure' });
  expect(result.scroll).toBe(before.scroll);
  await page.context().setOffline(false);
  await expect(composer).toHaveText('draft survives retry');
  await expect(page.locator('.catchup-overlay, .startup-sync-status, #flightdeck-asset-recovery-failed')).toHaveCount(0);
  await composer.press('End');
  await composer.pressSequentially(' and keeps typing');
  await expect(composer).toHaveText('draft survives retry and keeps typing');
  await page.locator('.thread-close-btn').click();
  await page.locator('.avatar-chip').click();
  await expect(page.getByRole('button', { name: 'Retry updates', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload after saving drafts' })).toBeVisible();
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.beginStartupSyncProgress();
    store.finishStartupSyncProgress();
    store.showAvatarMenu = false;
    store.openThread('perf-thread', { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
  });
  await expect(composer).toHaveText('draft survives retry and keeps typing');
  expect(await page.evaluate(() => window.Alpine.store('chat').startupSyncProgress.error)).toBeNull();
});


test('Backlog renders collapsed and expands in kanban and list, including reload', async ({ page }) => {
  test.setTimeout(30000);
  await blockExternalRequests(page);
  await page.goto('/');
  await waitForStore(page);
  await seedWorkspace(page, { documentCount: 10, historySize: 10, taskCount: 20 });
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.navSection = 'tasks';
    store.showTaskDetail = false;
    store.selectedBoardId = null;
    store.activeThreadId = null;
    store.tasks = store.tasks.map(task => ({ ...task, tags: '', assignee_npub: '', assignee_npubs: [] }));
    store.taskViewMode = 'kanban';
  });
  const column = page.locator('.kanban-col-new');
  await expect(column.locator('.kanban-column-title')).toHaveText('Backlog');
  await expect(column.locator('.kanban-column-body')).toBeHidden();
  await column.locator('.kanban-column-header').click();
  await expect(column.locator('.kanban-column-body')).toBeVisible();
  await page.evaluate(() => window.Alpine.store('chat').toggleTaskViewMode());
  const group = page.locator('.task-list-group').filter({ has: page.locator('.task-list-group-new') });
  await expect(group.locator('.task-list-group-label')).toHaveText('Backlog');
  await expect(group.locator('.task-list-rows')).toBeHidden();
  await group.locator('.task-list-group-header').click();
  await expect(group.locator('.task-list-rows')).toBeVisible();
  await page.reload();
  await waitForStore(page);
  expect(await page.evaluate(() => window.Alpine.store('chat').isSectionCollapsed('new'))).toBe(true);
});


test('Backlog resets on Tasks re-entry while allowing expansion during the visit', async ({ page }) => {
  test.setTimeout(30000);
  await blockExternalRequests(page);
  await page.goto('/');
  await waitForStore(page);
  await seedWorkspace(page, { documentCount: 10, historySize: 10, taskCount: 20 });
  const evidence = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.tasks = store.tasks.map(task => ({ ...task, tags: '', assignee_npub: '', assignee_npubs: [] }));
    store.collapsedSections = { new: false, done: true };
    store.openTaskDetail('task-0', { captureOrigin: false, syncRoute: false });
    const entryClosed = store.isSectionCollapsed('new');
    store.toggleSectionCollapse('new');
    const explicitlyExpanded = !store.isSectionCollapsed('new');
    store.navSection = 'tasks';
    const stillExpanded = !store.isSectionCollapsed('new');
    store.navSection = 'chat';
    store.openTaskDetail('task-1', { captureOrigin: false, syncRoute: false });
    return { entryClosed, explicitlyExpanded, stillExpanded,
      reentryClosed: store.isSectionCollapsed('new'), doneClosed: store.isSectionCollapsed('done'),
      backlogLabel: store.boardColumns.find(column => column.state === 'new').label };
  });
  expect(evidence).toEqual({ entryClosed: true, explicitlyExpanded: true, stillExpanded: true,
    reentryClosed: true, doneClosed: true, backlogLabel: 'Backlog' });
});
