const { test, expect } = require('playwright/test');
const { nip19, getPublicKey, generateSecretKey } = require('nostr-tools');
test.setTimeout(45000);
const human = nip19.npubEncode(getPublicKey(generateSecretKey()));
for (const width of [1440, 390]) {
  test(`Nostr shares Feed filters and inert deliberate navigation ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const destinations = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
        destinations.push(url.href);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
    await page.evaluate(
      ({ human }) => {
        const s = window.Alpine.store('chat');
        s.stopBackgroundSync?.();
        s.stopAllLiveQueries?.();
        s.startWorkspaceLiveQueries = () => {};
        s.syncRoute = () => {};
        s.performSync = () => {};
        s.openConnectModal = () => {};
        s.showConnectModal = false;
        s.showWorkspaceBootstrapModal = false;
        s.session = { npub: human };
        s.ownerNpub = human;
        s.workspaceOwnerNpub = human;
        s.pgBackendMode = false;
        s.isTowerPgMode = false;
        s.navSection = 'status';
        s.nostrNotificationContext = JSON.stringify([s.currentWorkspaceKey, human]);
        s.nostrNotificationItems = [
          {
            id: 'event',
            key: 'nostr-event',
            context: s.nostrNotificationContext,
            origin: 'nostr',
            actorNpub: human,
            source_title: 'Nostr · Reaction',
            title: 'Reaction fixture',
            text: '<img src="https://tracking.invalid/pixel">♥ · Original note',
            published: '2026-10-14T12:00:00Z',
            url: 'https://njump.me/nevent1fixture',
            attachments: [],
            read: false,
            saved: false,
            dismissed: false,
          },
        ];
        s.subscribedFeedItems = [
          {
            id: 'feed',
            key: 'subscribed',
            title: 'Subscribed fixture',
            source_title: 'Existing source',
            text: 'Kept intact',
            published: '2026-10-13',
            attachments: [],
          },
        ];
        s.nostrNotificationStatus =
          'Nostr relays unavailable. Cached notifications remain; refresh to retry.';
        window.opens = [];
        window.open = (...args) => window.opens.push(args);
        // UI fixture flags only; actual Dexie flag writes are tested separately.
        s.setNostrFeedFlag = (item, field, value) => {
          item[field] = value;
        };
      },
      { human },
    );
    const body = page.locator('.feeds-reader');
    await expect(body).toBeVisible();
    await expect(body.getByText('Reaction fixture', { exact: true })).toBeVisible();
    await expect(body.getByText('Subscribed fixture', { exact: true })).toBeVisible();
    await expect(body.locator('img, iframe, audio, video')).toHaveCount(0);
    expect(destinations).toEqual([]);
    const filter = body.getByLabel('Feed source filter');
    await filter.selectOption('nostr');
    await expect(body.getByText('Subscribed fixture', { exact: true })).toHaveCount(0);
    await expect(body.getByText('Reaction fixture', { exact: true })).toBeVisible();
    await body.getByRole('button', { name: 'Actions for Reaction fixture', exact: true }).click();
    await body.getByRole('menuitem', { name: 'Mark read', exact: true }).click();
    expect(
      await page.evaluate(() => window.Alpine.store('chat').nostrNotificationItems[0].read),
    ).toBe(true);
    await body.getByRole('button', { name: 'Reaction fixture', exact: true }).click();
    expect(await page.evaluate(() => window.opens)).toEqual([
      ['https://njump.me/nevent1fixture', '_blank', 'noopener,noreferrer'],
    ]);
    await filter.selectOption('feeds');
    await expect(body.getByText('Subscribed fixture', { exact: true })).toBeVisible();
    await expect(body.getByText('Reaction fixture', { exact: true })).toHaveCount(0);
    await filter.selectOption('all');
    await page.evaluate(() => {
      window.Alpine.store('chat').session = null;
    });
    await expect(body.getByText('Reaction fixture', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.Alpine.store('chat').subscribedFeedItems.length)).toBe(
      1,
    );
  });
}

test('signed relay fixtures traverse the compiled worker and Dexie and retain local flags', async ({
  page,
}) => {
  const { finalizeEvent } = require('nostr-tools');
  const humanKey = generateSecretKey(),
    senderKey = generateSecretKey();
  const pubkey = getPublicKey(humanKey),
    npub = nip19.npubEncode(pubkey);
  const incoming = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content: 'Signed worker mention fixture',
      tags: [['p', pubkey]],
    },
    senderKey,
  );
  const profile = finalizeEvent(
    { kind: 0, created_at: Math.floor(Date.now() / 1000), content: '{}', tags: [] },
    humanKey,
  );
  const actor = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({ display_name: 'Alice Example' }),
      tags: [],
    },
    senderKey,
  );
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  // Playwright WebSocket routing does not cover this dedicated module worker.
  // Replace only its transport before importing the actual served worker bundle;
  // signature validation, normalization, persistence and liveQuery stay real.
  await page.addInitScript(
    ({ incoming, profile, actor }) => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          if (!String(url).includes('nostr-notifications-worker')) {
            super(url, options);
            return;
          }
          const fixture = JSON.stringify({ incoming, profile, actor });
          const transport = `
          const fixture = ${fixture};
          const messages = []; const buffer = event => messages.push(event);
          self.addEventListener('message', buffer);
          self.WebSocket = class {
            static OPEN = 1; static CLOSED = 3;
            constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
            send(message) {
              const request = JSON.parse(message); if (request[0] !== 'REQ') return;
              const id = request[1], filter = request[2];
              setTimeout(() => {
                if (this.readyState !== 1) return;
                const emit = value => this.onmessage?.({ data: JSON.stringify(value) });
                if (filter.kinds?.includes(0)) emit(['EVENT', id, filter.authors?.[0] === fixture.incoming.pubkey ? fixture.actor : fixture.profile]);
                if (filter.kinds?.includes(1)) { emit(['EVENT', id, fixture.incoming]); emit(['EVENT', id, fixture.incoming]); }
                emit(['EOSE', id]);
              }, 0);
            }
            close() { this.readyState = 3; this.onclose?.({}); }
          };
          await import(${JSON.stringify(String(url))});
          self.removeEventListener('message', buffer);
          for (const event of messages) self.onmessage?.(event);
        `;
          const blobUrl = URL.createObjectURL(new Blob([transport], { type: 'text/javascript' }));
          super(blobUrl, options);
          URL.revokeObjectURL(blobUrl);
        }
      };
    },
    { incoming, profile, actor },
  );
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.waitForFunction(() => window.Alpine.store('chat').routeSyncPaused === false);
  await page.evaluate(
    async ({ npub, pubkey }) => {
      const s = window.Alpine.store('chat');
      s.stopBackgroundSync?.();
      s.stopAllLiveQueries?.();
      for (const method of [
        'startSharedLiveQueries',
        'syncRoute',
        'performSync',
        'ensureWorkspaceSessionKey',
        'loadLocalWorkspaceCoreData',
        'persistWorkspaceSettings',
        'refreshWorkspaceSettings',
        'refreshLegacyWorkspaceRecovery',
        'syncWorkspaceProfileDraft',
        'validateSelectedBoardId',
        'activateFeeds',
      ])
        s[method] = () => {};
      s.requestTowerSyncFamily = async () => {};
      s.ensureBackgroundSync = () => {};
      s.startWorkspaceLiveQueries = () => s.startNostrNotifications();
      s.session = { npub, pubkey, method: 'extension' };
      s.ownerNpub = npub;
      s.navSection = 'status';
      s.knownWorkspaces = [
        {
          workspaceKey: 'nostr-worker-fixture',
          workspaceId: '00000000-0000-4000-8000-000000000001',
          workspaceOwnerNpub: npub,
          directHttpsUrl: 'https://tower.example.invalid',
          pgBackendMode: true,
          pgSessionNpub: npub,
        },
      ];
      await s.selectWorkspace('nostr-worker-fixture', { pgVerified: true });
      s.showConnectModal = false;
      s.showWorkspaceBootstrapModal = false;
      s.startNostrNotifications();
    },
    { npub, pubkey },
  );
  const body = page.locator('.feeds-reader');
  await expect(body.getByText('Signed worker mention fixture', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.Alpine.store('chat').nostrNotificationItems.length)).toBe(
    1,
  );
  const actions = body.getByRole('button', { name: 'Actions for Mention from Alice Example' });
  await actions.click();
  await body.getByRole('menuitem', { name: 'Mark read', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.Alpine.store('chat').nostrNotificationItems[0]?.read))
    .toBe(true);
  await actions.click();
  await body.getByRole('menuitem', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.Alpine.store('chat').nostrNotificationItems[0]?.saved))
    .toBe(true);
  await page.evaluate(() => window.Alpine.store('chat').refreshNostrNotifications());
  await expect(body.getByText('Signed worker mention fixture', { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.Alpine.store('chat').nostrNotificationItems[0]?.saved))
    .toBe(true);

  await page.evaluate(() => window.Alpine.store('chat').logout());
  expect(await page.evaluate(() => window.Alpine.store('chat').nostrNotificationItems.length)).toBe(
    0,
  );
});
