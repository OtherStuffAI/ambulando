const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.afterEach(async (_fixtures, info) => {
  if (info.errors.length) console.log('TOOLBOX_FAILURE', info.errors.map(error => error.message).join('\n'));
});

// Built-client smoke with local fixtures. No remote Tower or WApp authentication.
async function seed(page, workspace = 'toolbox-workspace-a') {
  await page.waitForFunction(() => !!window.Alpine?.store('chat'));
  await page.evaluate(workspace => {
    const s = window.Alpine.store('chat');
    s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
    s.session = { npub: 'synthetic-toolbox-reader' };
    s.workspaceDbKey = workspace; s.selectedWorkspaceKey = workspace;
    s.knownWorkspaces = [{ workspaceKey: workspace, workspaceId: workspace,
      workspaceOwnerNpub: 'synthetic-owner', towerServiceNpub: 'synthetic-tower',
      workspaceServiceNpub: 'synthetic-service', pgBackendMode: true,
      directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'synthetic-app',
      pgMe: { actor: { actor_id: 'reader', npub: 'synthetic-toolbox-reader' } } }];
    s.wapps = [
      { record_id: 'artifacts', title: "Sample Artifacts", launch_url: 'http://127.0.0.1:3100/synthetic-wapp',
        pg_backend: true, pg_record_type: 'personal_wapp', owner_actor_id: 'reader' },
      { record_id: 'other-owner', title: 'Private app', launch_url: 'http://127.0.0.1:3100/private',
        pg_backend: true, pg_record_type: 'personal_wapp', owner_actor_id: 'other' },
      { record_id: 'archived', title: 'Archived app', launch_url: 'http://127.0.0.1:3100/archive',
        pg_backend: true, pg_record_type: 'personal_wapp', owner_actor_id: 'reader', record_state: 'archived' },
    ];
    s.scopes = [{ record_id: 'scope-a', title: 'Sample scope A' }, { record_id: 'scope-b', title: 'Sample scope B' }];
    s.channels = [{ record_id: 'channel-a', title: 'Sample channel A', scope_id: 'scope-a' }, { record_id: 'channel-a2', title: 'Sample channel A2', scope_id: 'scope-a' }, { record_id: 'channel-b', title: 'Sample channel B', scope_id: 'scope-b' }];
    // Synthetic command port preserves the production editor and persistence paths.
    // No signer, real actor or external Tower is involved.
    s.commandTowerWorkspace = async (name, input) => {
      const args = input.args;
      if (name === 'wapp.create') return { personal_wapp: { id: 'created-fixture', ...args[1], owner_actor_id: 'reader' } };
      if (name === 'wapp.update') return { personal_wapp: { id: args[1], ...args[2], owner_actor_id: 'reader' } };
      if (name === 'wapp.delete') return {};
      if (name === 'wapp.reorder') return { personal_wapps: args[1].ordered_ids.map((id, index) => ({ ...s.wapps.find(row => row.record_id === id), id, sort_order: index })) };
      return {};
    };
    s.orgDataInstallations = [{ key: 'register', title: 'Project Register', version: 1 }];
    s.orgDataInstallationContext = s.orgDataInstallationsContextKey;
    s.loadOrgDataInstallations = async () => {};
    s.startWorkspaceLiveQueries = () => {};
    s.ensureBackgroundSync = () => {};
    s.refreshStatusRecentChanges = () => {};
    s.startSharedLiveQueries();
    s.navSection = 'status'; s.navCollapsed = true; s.mobileNavOpen = false;
  }, workspace);
}
async function openToolbox(page, mobile) {
  if (mobile) await page.evaluate(() => { window.Alpine.store('chat').mobileNavOpen = true; });
  const nav = mobile ? page.locator('.expanded-sidebar-section-switcher').getByRole('button', { name: 'Toolbox', exact: true }) : page.locator('.sidebar').getByRole('button', { name: 'Toolbox', exact: true });
  await nav.focus(); await nav.press('Enter');
  await expect(page.getByTestId('toolbox-page')).toBeVisible();
  await expect(page.locator('button[aria-label="Toolbox"]:visible')).toHaveAttribute('aria-current', 'page');
}
for (const width of [1280, 390]) {
  test('Toolbox placement, reload, workspace isolation and both Apps launches at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => serveBuiltFlightDeck(route));
    await page.goto('/'); await seed(page);
    if (width === 390) await page.getByRole('button', { name: 'Show Hello and Links', exact: true }).evaluate(button => button.click());
    await expect(page.getByTestId('apps-stack')).toBeVisible();
    await page.getByRole('button', { name: 'Open Apps stack', exact: true }).click();
    await expect(page.getByTestId('message-activity-launch')).toHaveCount(0);
    await expect(page.getByTestId('tower-usage-launch')).toHaveCount(0);
    await expect(page.getByTestId('app-launch')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'Toolbox', exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-label="My Agents"]')).toBeVisible();
    await page.evaluate(() => { window.Alpine.store('chat').closePersonalWappsOverlay(); });
    await openToolbox(page, width === 390);
    await page.evaluate(() => { window.Alpine.store('chat').orgDataInstallations = []; });
    for (const title of ['Message activity', 'Tower Usage', 'Organisation Data Catalogue', 'People', 'Organisation chart', 'Holiday viewer']) {
      await expect(page.getByRole('checkbox', { name: 'Show ' + title + ' in Apps', exact: true })).toHaveCount(0);
    }
    await expect(page.getByTestId('toolbox-page').locator('.personal-wapp-settings-row')).toHaveCount(1);
    await page.evaluate(() => { window.Alpine.store('chat').orgDataInstallations = [{ key: 'register', title: 'Project Register', version: 1 }]; });
    const napplet = page.getByRole('checkbox', { name: 'Show Project Register in Apps', exact: true });
    const wapp = page.getByRole('checkbox', { name: "Show Sample Artifacts in Apps", exact: true });
    await expect(napplet).toBeChecked(); await expect(wapp).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Show (Private|Archived) app in Apps/ })).toHaveCount(0);
    await napplet.uncheck(); await expect(page.getByText('Placement saved.', { exact: true })).toBeVisible();
    await wapp.uncheck();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').visibleApps.length)).toBe(0);
    await page.reload(); await seed(page); await openToolbox(page, width === 390);
    await expect(napplet).not.toBeChecked(); await expect(wapp).not.toBeChecked();
    await seed(page, 'toolbox-workspace-b'); await openToolbox(page, width === 390);
    await expect(napplet).toBeChecked(); await expect(wapp).toBeChecked();
    await seed(page, 'toolbox-workspace-a'); await openToolbox(page, width === 390);
    await expect(napplet).not.toBeChecked(); await expect(wapp).not.toBeChecked();
    await napplet.check(); await expect(napplet).toBeEnabled();
    await wapp.check(); await expect(wapp).toBeEnabled();
    await page.screenshot({ path: 'tmp/docs/handoffs/toolbox-collapsed-' + width + '.png' });
    await page.evaluate(() => { const s = window.Alpine.store('chat'); if (s.mobileViewport) s.mobileNavOpen = true; else s.navCollapsed = false; });
    await expect(page.locator('.sidebar button[aria-label="Toolbox"]')).toBeHidden();
    const horizontal = page.locator('.expanded-sidebar-section-switcher');
    await horizontal.getByRole('button', { name: 'Toolbox', exact: true }).focus();
    await horizontal.getByRole('button', { name: 'Toolbox', exact: true }).press('Enter');
    if (width === 390) await page.evaluate(() => { window.Alpine.store('chat').mobileNavOpen = true; });
    await expect(horizontal).toBeVisible();
    await expect(page.locator('.toolbox-expanded-nav')).toHaveCount(0);
    await page.screenshot({ path: 'tmp/docs/handoffs/toolbox-expanded-' + width + '.png' });
    if (width === 390) await page.evaluate(() => { window.Alpine.store('chat').mobileNavOpen = false; });
    const row = title => page.getByTestId('toolbox-page').locator('.personal-wapp-settings-row').filter({ has: page.locator('strong', { hasText: title }) });
    const modal = page.locator('.personal-wapp-editor-modal');
    for (const [title, save] of [['Sample Artifacts', 'Save WApp'], ['Project Register', 'Save napplet']]) {
      await row(title).getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(modal).toBeVisible();
      await modal.getByRole('textbox', { name: 'Icon URL', exact: true }).fill('http://127.0.0.1:3100/favicon.ico');
      await modal.getByRole('spinbutton', { name: 'Position in Apps' }).fill('1');
      await modal.getByRole('combobox', { name: 'App visibility' }).selectOption('scope');
      await modal.getByRole('combobox', { name: 'App scope' }).selectOption('scope-a');
      await page.screenshot({ path: 'tmp/docs/handoffs/toolbox-edit-' + title.replaceAll(' ', '-') + '-' + width + '.png' });
      await modal.getByRole('button', { name: save, exact: true }).click();
      await expect(modal).toBeHidden();
      await page.evaluate(() => { window.Alpine.store('chat').selectedBoardId = 'scope-a'; });
      await expect.poll(() => page.evaluate(title => window.Alpine.store('chat').visibleApps.some(app => app.title === title), title)).toBe(true);
      await page.evaluate(() => { window.Alpine.store('chat').selectedBoardId = '__pg_channel__:channel-a'; });
      await expect.poll(() => page.evaluate(title => window.Alpine.store('chat').visibleApps.some(app => app.title === title), title)).toBe(true);
      await page.evaluate(() => { window.Alpine.store('chat').selectedBoardId = 'scope-b'; });
      await expect.poll(() => page.evaluate(title => window.Alpine.store('chat').visibleApps.some(app => app.title === title), title)).toBe(false);
      await row(title).getByRole('button', { name: 'Edit', exact: true }).click();
      await modal.getByRole('combobox', { name: 'App visibility' }).selectOption('channel');
      await modal.getByRole('combobox', { name: 'App channel' }).selectOption('channel-a');
      await modal.getByRole('button', { name: save, exact: true }).click();
      await expect(modal).toBeHidden();
      await page.evaluate(() => { window.Alpine.store('chat').selectedBoardId = '__pg_channel__:channel-a'; });
      await expect.poll(() => page.evaluate(title => window.Alpine.store('chat').visibleApps.some(app => app.title === title), title)).toBe(true);
      await page.evaluate(() => { window.Alpine.store('chat').selectedBoardId = '__pg_channel__:channel-a2'; });
      await expect.poll(() => page.evaluate(title => window.Alpine.store('chat').visibleApps.some(app => app.title === title), title)).toBe(false);
      // Verify the actual launcher DOM, as well as its filtered collection.
      await page.evaluate(() => window.Alpine.store('chat').navigateTo('status'));
      await expect(page.getByTestId('apps-stack').getByRole('button', { name: 'Open ' + title, exact: true })).toHaveCount(0);
      await page.evaluate(() => { window.Alpine.store('chat').selectedBoardId = '__pg_channel__:channel-a'; });
      await expect(page.getByTestId('apps-stack').getByRole('button', { name: 'Open ' + title, exact: true })).toHaveCount(1);
      await page.evaluate(() => window.Alpine.store('chat').navigateTo('toolbox'));
    }
    await page.reload(); await seed(page); await openToolbox(page, width === 390);
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.selectedBoardId = '__pg_channel__:channel-a'; });
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').visibleApps.length)).toBe(2);
    await page.evaluate(() => { window.Alpine.store('chat').channels = []; });
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').visibleApps.length)).toBe(0);
    await row('Project Register').getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(modal.getByRole('combobox', { name: 'App visibility' })).toHaveValue('channel');
    await expect(modal.getByRole('combobox', { name: 'App channel' }).locator('option:checked')).toHaveText('Unavailable channel (restricted)');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await seed(page, 'toolbox-workspace-b');
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').visibleApps.length)).toBe(2);
    await seed(page);
    await page.evaluate(() => { window.Alpine.store('chat').knownWorkspaces[0].pgMe.actor.actor_id = 'other'; });
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').visibleApps.map(app => app.title))).toEqual(['Private app', 'Project Register']);
    await seed(page); await openToolbox(page, width === 390);
    for (const [title, save] of [['Sample Artifacts', 'Save WApp'], ['Project Register', 'Save napplet']]) {
      await row(title).getByRole('button', { name: 'Edit', exact: true }).click();
      await modal.getByRole('combobox', { name: 'App visibility' }).selectOption('everywhere');
      await modal.getByRole('button', { name: save, exact: true }).click();
      await expect(modal).toBeHidden();
    }
    await page.getByTestId('toolbox-page').getByRole('button', { name: 'Add WApp' }).click();
    await modal.getByRole('textbox', { name: 'Title', exact: true }).fill('Synthetic added app');
    await modal.getByRole('textbox', { name: 'Launch URL', exact: true }).fill('http://127.0.0.1:3100/new');
    await modal.getByRole('button', { name: 'Save WApp', exact: true }).click();
    await expect(row('Synthetic added app')).toBeVisible();
    await row('Synthetic added app').getByRole('button', { name: 'Archive' }).click();
    await expect(row('Synthetic added app')).toHaveCount(0);
    await row('Project Register').getByRole('button', { name: 'Move Project Register down' }).click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').toolboxApps.at(-1).appType)).toBe('Napplet');
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.navCollapsed = true; s.mobileNavOpen = false; s.navigateTo('settings'); s.settingsTab = 'apps'; });
    await expect(page.locator('.settings-section .personal-wapp-settings-row')).toHaveCount(0);

    await page.evaluate(() => window.Alpine.store('chat').navigateTo('toolbox'));
    // Display names use local placement preferences, with the same editor and launch.
    await row('Project Register').getByRole('button', { name: 'Edit', exact: true }).click();
    const titleField = modal.getByRole('textbox', { name: 'Title', exact: true });
    await expect(titleField).toBeEditable();
    for (const blank of ['', '   ']) {
      await titleField.fill(blank);
      await modal.getByRole('button', { name: 'Save napplet', exact: true }).click();
      await expect(modal.getByText('Title is required. Enter a display name.', { exact: true })).toBeVisible();
      await expect(row('Project Register')).toBeVisible();
    }
    await titleField.fill('  My project register  ');
    await modal.getByRole('button', { name: 'Save napplet', exact: true }).click();
    await expect(row('My project register')).toBeVisible();
    await row('My project register').getByRole('button', { name: 'Edit', exact: true }).click();
    // The existing shared editor heading still uses the retained Message activity title.
    await expect(modal.getByRole('heading', { name: 'Edit Message activity' })).toBeVisible();
    await expect(titleField).toHaveValue('My project register');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.reload(); await seed(page); await openToolbox(page, width === 390);
    await expect(row('My project register')).toBeVisible();
    await seed(page, 'toolbox-workspace-b'); await openToolbox(page, width === 390); await expect(row('Project Register')).toBeVisible();
    await seed(page); await openToolbox(page, width === 390); await page.evaluate(() => { const s = window.Alpine.store('chat'); s.knownWorkspaces[0].pgMe.actor.actor_id = 'other'; s.orgDataInstallationContext = s.orgDataInstallationsContextKey; });
    await expect(row('Project Register')).toBeVisible();
    await seed(page); await openToolbox(page, width === 390); await expect(row('My project register')).toBeVisible();
    // Keep WApp title editing on its existing server-backed path.
    await row('Sample Artifacts').getByRole('button', { name: 'Edit', exact: true }).click();
    await titleField.fill('Renamed WApp');
    await modal.getByRole('button', { name: 'Save WApp', exact: true }).click();
    await expect(row('Renamed WApp')).toBeVisible();
    await row('Renamed WApp').getByRole('button', { name: 'Edit', exact: true }).click();
    await titleField.fill('Sample Artifacts');
    await modal.getByRole('button', { name: 'Save WApp', exact: true }).click();
    await page.evaluate(() => window.Alpine.store('chat').navigateTo('status'));
    if (width === 390) await page.getByRole('button', { name: 'Show Hello and Links', exact: true }).evaluate(button => button.click());
    await page.getByRole('button', { name: 'Open Apps stack', exact: true }).click();
    // Probe launcher routing; host authorization is covered independently by org-data tests.
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s.openOrgData = options => { s.toolboxFixtureLaunch = options.view; s.closePersonalWappsOverlay(); };
    });
    await page.getByTestId('apps-stack').getByRole('button', { name: 'Open My project register', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').toolboxFixtureLaunch)).toBe('bundle:register');
    await page.getByRole('button', { name: 'Open Apps stack', exact: true }).click();
    const popup = page.waitForEvent('popup');
    await page.getByTestId('apps-stack').getByRole('button', { name: "Open Sample Artifacts", exact: true }).click();
    const appPage = await popup; await expect(appPage).toHaveURL('http://127.0.0.1:3100/synthetic-wapp');
    expect(await appPage.evaluate(() => window.opener)).toBeNull(); await appPage.close();
    // Existing hidden WApp-management x-models dereference null drafts at boot.
    // Report that baseline separately; no new Toolbox/launcher errors are accepted.
    const knownBootError = /^Cannot read properties of null \(reading '(delegate_actor_id|expires_at|app_ids|installation_ids|scope_ids|channel_ids|open_origins|autopilot_origins|activity_publish|app_version|wapp_installation_id|launch_url)'\)$/;
    const fixtureAuthError = message => message === 'No Nostr session available for NIP-98 auth.';
    expect(errors.filter(message => !knownBootError.test(message) && !fixtureAuthError(message))).toEqual([]);
    console.log('TOOLBOX_SMOKE', JSON.stringify({ width,
      knownBootErrors: errors.filter(message => knownBootError.test(message)).length,
      fixtureAuthErrors: errors.filter(fixtureAuthError).length,
      reload: true, workspaceIsolation: true, launches: ['Napplet', 'WApp'] }));
  });
}
