import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeData,
  clearRuntimeFamilies,
  getRecentWappChangesSince,
  getWappPublishingGrants,
  getWappById,
  getWappsByOwner,
  openWorkspaceDb,
  replaceWappPublishingGrants,
  upsertWapp,
} from '../src/db.js';

const TEST_OWNER = 'npub_test_wapps_workspace';

beforeEach(async () => {
  const wsDb = openWorkspaceDb(TEST_OWNER);
  await wsDb.open();
  await Promise.all(wsDb.tables.map((table) => table.clear()));
});

function wapp(overrides = {}) {
  return {
    record_id: 'wapp-record-1',
    owner_npub: TEST_OWNER,
    title: 'Budget Builder',
    description: 'Prepare a scope budget.',
    wapp_id: 'wapp-budget',
    app_id: 'app-budget',
    launch_url: 'https://apps.example.test/budget',
    workspace_owner_npub: TEST_OWNER,
    scope_id: 'scope-project',
    scope_l1_id: 'scope-product',
    scope_l2_id: 'scope-project',
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
    group_ids: ['group-1'],
    sync_status: 'synced',
    status: 'active',
    schedule: null,
    record_state: 'active',
    version: 1,
    created_at: '2026-05-14T00:00:00.000Z',
    updated_at: '2026-05-14T00:01:00.000Z',
    ...overrides,
  };
}

describe('wapp db helpers', () => {
  it('upserts and retrieves WApps by id and owner', async () => {
    await upsertWapp(wapp());

    expect((await getWappById('wapp-record-1'))?.title).toBe('Budget Builder');
    expect(await getWappsByOwner(TEST_OWNER)).toHaveLength(1);
  });

  it('loads WApps by workspace owner when the app owner differs', async () => {
    await upsertWapp(wapp({
      owner_npub: 'npub_app_owner',
      workspace_owner_npub: TEST_OWNER,
    }));

    const rows = await getWappsByOwner(TEST_OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_npub).toBe('npub_app_owner');
  });

  it('hides archived WApps from owner and recent-change helpers', async () => {
    await upsertWapp(wapp({ record_state: 'archived' }));
    await upsertWapp(wapp({ record_id: 'status-archived', status: 'archived' }));

    expect(await getWappsByOwner(TEST_OWNER)).toEqual([]);
    expect(await getRecentWappChangesSince('2026-05-13T00:00:00.000Z')).toEqual([]);
  });

  it('clears WApps through family and full runtime clears', async () => {
    await upsertWapp(wapp());
    await clearRuntimeFamilies(['wapp']);
    expect(await getWappById('wapp-record-1')).toBeUndefined();

    await upsertWapp(wapp());
    await clearRuntimeData();
    expect(await getWappById('wapp-record-1')).toBeUndefined();
  });

  it('replaces authoritative Tower WApp publishing materializations and removes stale rows', async () => {
    await replaceWappPublishingGrants([{ wapp_installation_id: 'install-old', status: 'active' }]);

    await replaceWappPublishingGrants([{ wapp_installation_id: 'install-new', status: 'disabled' }]);

    expect((await getWappPublishingGrants()).map((row) => row.wapp_installation_id)).toEqual(['install-new']);

    await clearRuntimeData();
    expect(await getWappPublishingGrants()).toEqual([]);
  });

  it('does not rewrite unchanged authoritative WApp materializations', async () => {
    const db = openWorkspaceDb(TEST_OWNER);
    const mutations = [];
    for (const tableName of ['wapp_publishing_grants']) {
      const table = db.table(tableName);
      table.hook('creating', (_key, row) => mutations.push(['creating', tableName, row]));
      table.hook('updating', (changes, _key, row) => mutations.push(['updating', tableName, changes, row]));
      table.hook('deleting', (key, row) => mutations.push(['deleting', tableName, key, row]));
    }
    const grants = [{ wapp_installation_id: 'install-1', status: 'active', updated_at: '2026-08-04T00:00:00.000Z' }];
    await replaceWappPublishingGrants(grants);
    mutations.length = 0;

    await replaceWappPublishingGrants(grants);

    expect(mutations).toEqual([]);
  });

});
