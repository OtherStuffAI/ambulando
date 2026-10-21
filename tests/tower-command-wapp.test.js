import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateWapp } = vi.hoisted(() => ({ updateWapp: vi.fn() }));

vi.mock('../src/api.js', async (original) => ({
  ...await original(),
  updateTowerPgPersonalWapp: updateWapp,
}));

import { clearRuntimeData, getWappById, openWorkspaceDb } from '../src/db.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import { updateTowerPgPersonalWapp } from '../src/tower-command-intents.js';
import { TowerSyncService } from '../src/tower-sync-service.js';

const OWNER = 'npub_wapp_command_owner';

beforeEach(async () => {
  updateWapp.mockReset();
  const db = openWorkspaceDb(OWNER);
  await db.open();
  await clearRuntimeData();
});

function commandStore() {
  const store = { workspaceOwnerNpub: OWNER };
  const service = new TowerSyncService({
    workspaceKey: 'workspace-1',
    ports: { prepareCommand: (name, input) => prepareTowerWorkspaceCommand(store, name, input) },
  });
  store.commandTowerWorkspace = (name, input, options) => service.command(name, input, options);
  return { store, service };
}

describe('personal WApp update commands', () => {
  it('sends every distinct edit instead of reusing the first cached acknowledgement', async () => {
    updateWapp
      .mockResolvedValueOnce({ personal_wapp: { id: 'wapp-1', title: 'Wingman App', launch_url: 'https://app.example', owner_actor_id: 'owner', row_version: 2 } })
      .mockResolvedValueOnce({ personal_wapp: { id: 'wapp-1', title: 'Nostr Browser', launch_url: 'https://app.example', owner_actor_id: 'owner', row_version: 3 } });
    const { store } = commandStore();

    await updateTowerPgPersonalWapp(store, 'workspace-1', 'wapp-1', { title: 'Wingman App', launch_url: 'https://app.example' });
    const result = await updateTowerPgPersonalWapp(store, 'workspace-1', 'wapp-1', { title: 'Nostr Browser', launch_url: 'https://app.example' });

    expect(updateWapp).toHaveBeenCalledTimes(2);
    expect(result.personal_wapp.title).toBe('Nostr Browser');
    expect(await getWappById('wapp-1')).toMatchObject({ title: 'Nostr Browser', version: 3 });
  });

  it('does not reconcile an out-of-order older PATCH response over the newer rename', async () => {
    const releases = [];
    updateWapp.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    const { store } = commandStore();

    const older = updateTowerPgPersonalWapp(store, 'workspace-1', 'wapp-1', { title: 'Wingman App', launch_url: 'https://app.example' });
    const newer = updateTowerPgPersonalWapp(store, 'workspace-1', 'wapp-1', { title: 'Nostr Browser', launch_url: 'https://app.example' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]({ personal_wapp: { id: 'wapp-1', title: 'Nostr Browser', launch_url: 'https://app.example', owner_actor_id: 'owner', row_version: 3 } });
    await expect(newer).resolves.toMatchObject({ personal_wapp: { title: 'Nostr Browser' } });
    releases[0]({ personal_wapp: { id: 'wapp-1', title: 'Wingman App', launch_url: 'https://app.example', owner_actor_id: 'owner', row_version: 2 } });
    await expect(older).resolves.toMatchObject({ stale: true });

    expect(await getWappById('wapp-1')).toMatchObject({ title: 'Nostr Browser', version: 3 });
  });
});
