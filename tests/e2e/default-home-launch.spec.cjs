const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.setTimeout(30000);

// Built frontend, real init/bootstrap, localStorage and browser history. Only
// identity, workspace authority and background services are synthetic; no live
// Tower permission or synchronization acceptance is implied.
async function installWorkspace(page, stored = null) {
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.addInitScript(({ stored }) => {
    if (window.top !== window) return;
    if (!sessionStorage.getItem('launch-fixture-seeded')) {
      if (stored) localStorage.setItem('coworker:alpha:last-task-board-id', stored);
      localStorage.setItem('coworker:beta:last-task-board-id', 'beta-project');
      sessionStorage.setItem('launch-fixture-seeded', '1');
    }
    let alpine;
    Object.defineProperty(window, 'Alpine', {
      configurable: true,
      get: () => alpine,
      set(value) {
        alpine = value;
        const store = value.store.bind(value);
        value.store = (name, state) => {
          if (name === 'chat' && state) {
            state.session = { npub: 'npub1launchfixture' };
            state.knownWorkspaces = [{ workspaceKey: 'alpha-key', workspaceOwnerNpub: 'npub1owner',
              workspaceId: 'alpha-id', slug: 'alpha', name: 'Alpha', pgBackendMode: true,
              directHttpsUrl: 'http://127.0.0.1:3100' }];
            state.selectedWorkspaceKey = 'alpha-key';
            state.backendUrl = 'http://127.0.0.1:3100';
            state.scopes = ['project-a', 'project-b'].map(record_id => ({ record_id, title: record_id, level: 'l1', record_state: 'active' }));
            state.scopesLoaded = true;
            state.channels = ['a', 'b'].map(id => ({ record_id: `channel-${id}`, title: `Channel ${id}`, scope_id: `project-${id}`, record_state: 'active' }));
            state.tasks = ['a', 'b'].map(id => ({ record_id: `task-${id}`, title: `Activity from project ${id}`,
              pg_channel_id: `channel-${id}`, scope_id: `project-${id}`, state: 'in_progress',
              updated_at: new Date().toISOString(), record_state: 'active' }));
            for (const key of ['startExtensionSignerWatch', 'initCommandPaletteShortcuts', 'initDocCommentConnector',
              'startSharedLiveQueries', 'startWorkspaceLiveQueries', 'loadLocalWorkspaceCoreData',
              'maybeAutoLogin', 'selectWorkspace', 'refreshKnownHostsMetadata', 'ensureWorkspaceSessionKey',
              'ensureTowerPgControlPlaneHydrated', 'resumePgTaskWriteQueue', 'refreshAddressBook',
              'refreshSyncStatus', 'refreshStatusRecentChanges', 'hydrateKnownWorkspaceProfiles',
              'filterKnownWorkspacesForActiveSession', 'loadRemoteWorkspaces', 'ensureBackgroundSync',
              'updateWorkspaceBootstrapPrompt', 'resolveChatProfile', 'refreshWorkrooms']) state[key] = async () => {};
            state.ensurePgWorkspaceAvailable = async () => state.currentWorkspace;
            state.prepareWorkspaceAccessGate = () => false;
          }
          return state === undefined ? store(name) : store(name, state);
        };
      },
    });
  }, { stored });
}

async function ready(page) {
  await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false
    && new URL(location.href).searchParams.has('scopeid'), null, { timeout: 15000 });
}

async function expectAll(page) {
  await expect(page.locator('.flightdeck-summary-header p').first()).toHaveText('All workspace activity');
  expect(await page.evaluate(() => {
    const s = Alpine.store('chat');
    return { section: s.navSection, scope: s.selectedBoardId, home: s.pgContextHomeSelected,
      tasks: s.autopilotOverviewTasks.map(task => task.recordId).sort(),
      otherWorkspace: localStorage.getItem('coworker:beta:last-task-board-id') };
  })).toEqual({ section: 'status', scope: '__all__', home: true, tasks: ['task-a', 'task-b'], otherWorkspace: 'beta-project' });
}

for (const stored of [null, 'project-a']) {
  test(`Home launch and reload show all accessible projects with saved selection ${stored}`, async ({ page }) => {
    await installWorkspace(page, stored);
    await page.goto('/alpha', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await expectAll(page);
    // Reload a plain app entry while localStorage still names a project.
    await page.evaluate(() => {
      localStorage.setItem('coworker:alpha:last-task-board-id', 'project-a');
      history.replaceState(null, '', '/alpha');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    await expectAll(page);
  });
}

test('explicit project links and intentional navigation survive reload and Back/Forward', async ({ page }) => {
  await installWorkspace(page, 'project-a');
  await page.goto('/alpha/flight-deck?scopeid=project-b', { waitUntil: 'domcontentloaded' });
  await ready(page);
  await expect.poll(() => page.evaluate(() => Alpine.store('chat').selectedBoardId)).toBe('project-b');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  expect(await page.evaluate(() => Alpine.store('chat').selectedBoardId)).toBe('project-b');
  await page.evaluate(() => Alpine.store('chat').openAllScopesOverview());
  await expectAll(page);
  await page.evaluate(() => Alpine.store('chat').selectWorkContextBoard('project-a'));
  await expect.poll(() => page.evaluate(() => Alpine.store('chat').selectedBoardId)).toBe('project-a');
  await page.goBack();
  await expectAll(page);
  await page.goForward();
  await expect.poll(() => page.evaluate(() => Alpine.store('chat').selectedBoardId)).toBe('project-a');
});
