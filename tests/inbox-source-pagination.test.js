import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { openWorkspaceDb, deleteWorkspaceDb } from '../src/db.js';
import { sectionLiveQueryMixin } from '../src/section-live-queries.js';
import { autopilotOverviewManagerMixin } from '../src/autopilot-overview-manager.js';
import { buildSidebarScopeChannelGroups } from '../src/sidebar-navigation.js';

const key = 'inbox-source-pagination';
let store;
afterEach(async () => { store?.stopAllLiveQueries(); await deleteWorkspaceDb(key); });
async function setup(count = 225) {
  const db = openWorkspaceDb(key);
  await db.open();
  const owner_npub = 'npub1owner';
  await db.scopes.bulkPut([{ record_id: 'scope', title: 'Project', level: 'l1', owner_npub }]);
  await db.channels.bulkPut([
    { record_id: 'old', scope_id: 'scope', title: 'Old channel', owner_npub, updated_at: '2000-01-01', is_active: false },
    { record_id: 'empty', scope_id: 'scope', title: 'Empty channel', owner_npub },
    { record_id: 'deleted', scope_id: 'scope', owner_npub, record_state: 'deleted' },
    { record_id: 'denied', scope_id: 'scope', owner_npub, can_read: false },
  ]);
  await db.tasks.bulkPut(Array.from({ length: count }, (_, i) => ({
    record_id: `task-${i}`, owner_npub, title: i >= 200 ? 'Older match' : `New task ${i}`,
    state: 'ready', updated_at: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString(),
  })));
  const subscriptions = new Set();
  store = Object.defineProperties({}, Object.getOwnPropertyDescriptors(autopilotOverviewManagerMixin));
  Object.assign(store, sectionLiveQueryMixin, {
    currentWorkspaceKey: key, workspaceOwnerNpub: owner_npub, navSection: 'status',
    createLiveSubscription(query, onNext) { const sub = { query, onNext }; subscriptions.add(sub); return sub; },
    stopLiveSubscription(sub) { subscriptions.delete(sub); },
    applyAddressBookPeople() {}, applyWapps() {}, applyDailyNotes() {},
    applyScopes(rows) { this.scopes = rows; }, applyChannels(rows) { this.channels = rows; },
    applyDirectories() {}, applyDocuments(rows) { this.documents = rows; },
    applyTasks(rows) { this.tasks = rows; }, applyFileMessages(rows) { this.fileMessages = rows; },
    applyFileComments(rows) { this.fileComments = rows; }, applyFileFolders() {}, applyAudioNotes() {},
  });
  store.startWorkspaceLiveQueries();
  const deliver = async () => { for (const sub of subscriptions) await sub.onNext(await sub.query()); };
  await deliver();
  return { db, deliver, subscriptions };
}

describe('Inbox source pagination and complete navigation', () => {
  it('reveals 50 then 100, reads older source pages, exhausts, and keeps old/empty channels under their scope', async () => {
    const { deliver, subscriptions } = await setup();
    const navigation = () => buildSidebarScopeChannelGroups(store.scopes, store.channels);
    expect(navigation()[0].channels.map(c => c.record_id).sort()).toEqual(['empty', 'old']);
    expect(store.visibleAutopilotOverviewInbox).toHaveLength(50);
    const originalSubscriptions = new Set(subscriptions);
    store.revealMoreDeckInbox(); await deliver();
    expect(store.visibleAutopilotOverviewInbox).toHaveLength(100);
    expect(store.inboxActivityVisibleCount).toBe(100);
    for (const n of [150, 200, 225]) {
      store.revealMoreDeckInbox(); await deliver();
      expect(store.visibleAutopilotOverviewInbox).toHaveLength(n);
      expect(navigation()[0].channels).toHaveLength(2);
    }
    expect(store.hasMoreAutopilotOverviewInbox).toBe(false);
    // The workspace subscriptions survive Inbox paging; only source limits change.
    expect([...originalSubscriptions].filter(s => subscriptions.has(s)).length).toBeGreaterThanOrEqual(5);
    store.revealMoreDeckInbox(); await deliver();
    expect(store.visibleAutopilotOverviewInbox).toHaveLength(225);
  });

  it('selects old search matches before paging and exhausts unrelated source history', async () => {
    const { deliver } = await setup();
    store.setDeckInboxSearchDraft('Older match'); store.applyDeckInboxSearch();
    expect(store.inboxActivityLoading).toBe(true);
    await deliver();
    expect(store.inboxActivityVisibleCount).toBe(100);
    expect(store.deckInboxVisibleCount).toBe(50);
    expect(store.visibleAutopilotOverviewInbox).toHaveLength(25);
    expect(store.hasMoreAutopilotOverviewInbox).toBe(false);
    store.setDeckInboxSearchDraft('no match'); store.applyDeckInboxSearch(); await deliver();
    expect(store.visibleAutopilotOverviewInbox).toHaveLength(0);
    expect(store.hasMoreAutopilotOverviewInbox).toBe(false);
  });

  it('does not leak Files has-more or limits into Inbox and resets source state for another workspace', async () => {
    const { deliver } = await setup(25);
    expect(store.hasMoreAutopilotOverviewInbox).toBe(false);
    store.filesActivityPageHasMore = { messages: true }; store.filesActivityVisibleCount = 1000;
    expect(store.hasMoreAutopilotOverviewInbox).toBe(false);
    store.navSection = 'files'; store.startWorkspaceLiveQueries(); await deliver();
    expect(store.inboxActivityVisibleCount).toBe(100);
    store.navSection = 'status'; store.startWorkspaceLiveQueries(); await deliver();
    expect(store.visibleAutopilotOverviewInbox).toHaveLength(25);
    store.inboxActivityPageHasMore = { tasks: true }; store.inboxActivityVisibleCount = 500;
    store.workspaceOwnerNpub = 'npub1another'; store.startWorkspaceLiveQueries(); await deliver();
    expect(store.inboxActivityVisibleCount).toBe(100);
    expect(store.filesActivityVisibleCount).toBe(100);
    expect(store.hasMoreAutopilotOverviewInbox).toBe(false);
  });

  it('places the only Inbox control after cards/empty results and leaves a separate Files footer', () => {
    const html = readFileSync('index.html', 'utf8');
    const document = new JSDOM(html).window.document;
    const find = (root, selector) => root.querySelector(selector)
      || [...root.querySelectorAll('template')].map(t => find(t.content, selector)).find(Boolean);
    const inbox = find(document, '[data-deck-column="inbox"]');
    expect(inbox.querySelector('.deck-card-scroll').lastElementChild.textContent).toBe('Load older activity');
    expect(inbox.querySelectorAll('.inbox-load-more')).toHaveLength(1);
    expect(inbox.hasAttribute('@scroll.passive')).toBe(false);
    expect(html).not.toContain('Load older cached activity');
    const files = find(document, '.files-section');
    expect(files.querySelector('.inbox-load-more').previousElementSibling.className).toBe('files-empty');
    expect(files.querySelector('.inbox-load-more').getAttribute('x-show')).toContain('filesActivityPageHasMore');
  });
});
