const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const width of [390, 1440]) {
  test(`Deck channel options preserves target, permissions and menu actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.navigateTo('status', { syncRoute: false });
      s.navCollapsed = true;
      s.deckInboxEnabled = true;
      s.deckMobileColumn = 'inbox';
      s.channels.push({ ...s.channels[0], record_id: 'other-channel', title: 'Other channel' });
      // The Deck context takes precedence over another section's last selection.
      s.selectedChannelId = 'other-channel';
      s.pgContextSelectedChannelId = 'sol-channel';
      Object.defineProperty(s, 'autopilotOverviewContext', { configurable: true, get: () => ({ channelId: 'sol-channel', scopeId: null, mode: 'channel' }) });
      s.selectedBoardId = '';
      s.canAdminWorkspace = false;
      window.readActions = [];
      s.runInboxReadAction = (types, label) => window.readActions.push({ types, label });
      for (const key of ['unreadTasks', 'unreadDocs', 'unreadChat', 'unreadDeck']) Object.defineProperty(s, key, { get: () => 1 });
    });
    const trigger = page.getByRole('button', { name: 'Inbox options', exact: true });
    const menu = page.getByRole('menu', { name: 'Inbox options', exact: true });
    const options = page.getByRole('menuitem', { name: 'Channel options', exact: true });
    await trigger.click();
    await expect(options).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Mark all tasks as read', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.press('Enter');
    await options.click();
    const dialog = page.getByRole('dialog', { name: 'Channel settings', exact: true });
    await expect(dialog).toBeVisible();
    await expect(menu).toBeHidden();
    await expect(dialog).toContainText('Design implementation');
    expect(await page.evaluate(() => window.Alpine.store('chat').channelSettingsChannelId)).toBe('sol-channel');
    expect(await page.evaluate(() => window.Alpine.store('chat').canManageSettingsChannel)).toBe(false);
    await expect(dialog.getByRole('button', { name: 'Rename channel', exact: true })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    for (const label of ['Mark all tasks as read', 'Mark all docs as read', 'Mark all chats as read', 'Mark everything as read']) {
      await trigger.click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await expect(menu).toBeHidden();
    }
    expect(await page.evaluate(() => window.readActions.map(action => action.types))).toEqual([
      ['task'], ['document'], ['thread'], ['thread', 'task', 'document'],
    ]);
    await trigger.click();
    await page.locator('#deck-inbox-search').click();
    await expect(menu).toBeHidden();
    await trigger.click();
    await options.press('Tab');
    // Normal Tab navigation can leave the menu and dismiss it.
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    await expect(menu).toBeHidden();

    // No selected channel, all scopes, and inaccessible channels offer no channel action.
    for (const context of ['none', 'all', 'access-lost']) {
      await page.evaluate(context => {
        const s = window.Alpine.store('chat');
        delete s.autopilotOverviewContext;
        Object.defineProperty(s, 'autopilotOverviewContext', { configurable: true, get: () => ({ channelId: context === 'access-lost' ? 'sol-channel' : '', scopeId: null, mode: 'all' }) });
        s.selectedChannelId = ''; s.pgContextSelectedChannelId = ''; s.selectedBoardId = '';
        if (context === 'all') { s.selectedBoardId = '__all__'; s.selectedChannelId = 'sol-channel'; }
        if (context === 'access-lost') { s.pgContextSelectedChannelId = 'sol-channel'; s.channels[0].pg_access_status = 'access-lost'; }
      }, context);
      await trigger.click();
      await expect(menu).toBeVisible();
      await expect(options).toBeHidden();
      await page.keyboard.press('Escape');
    }
  });
}
