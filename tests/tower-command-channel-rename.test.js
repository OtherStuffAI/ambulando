import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateChannel } = vi.hoisted(() => ({ updateChannel: vi.fn() }));

vi.mock('../src/api.js', async (original) => ({
  ...await original(),
  updateTowerPgChannel: updateChannel,
}));

import {
  clearRuntimeData,
  getChannelById,
  openWorkspaceDb,
  replaceChannelsForOwner,
  upsertChannel,
} from '../src/db.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import { updateTowerPgChannel } from '../src/tower-command-intents.js';
import { TowerSyncService } from '../src/tower-sync-service.js';

const OWNER = 'npub_channel_rename_owner';
const CHANNEL_ID = 'd8d00881-ac84-41eb-ab0d-2c2afb77ddf3';

beforeEach(async () => {
  updateChannel.mockReset();
  const db = openWorkspaceDb(OWNER);
  await db.open();
  await clearRuntimeData();
});

function commandStore() {
  const previous = {
    record_id: CHANNEL_ID,
    owner_npub: OWNER,
    title: 'Wingman App',
    scope_id: 'petes-applications',
    version: 1,
    pg_backend: true,
  };
  const store = { workspaceOwnerNpub: OWNER, channels: [previous] };
  const service = new TowerSyncService({
    workspaceKey: 'workspace-1',
    ports: { prepareCommand: (name, input) => prepareTowerWorkspaceCommand(store, name, input) },
  });
  store.commandTowerWorkspace = (name, input, options) => service.command(name, input, options);
  return store;
}

function canonical(name, rowVersion) {
  return {
    id: CHANNEL_ID,
    workspace_id: 'workspace-1',
    scope_id: 'petes-applications',
    name,
    kind: 'channel',
    position: 3,
    metadata: { agent_chat: { enabled: true } },
    row_version: rowVersion,
  };
}

describe('channel rename commands', () => {
  it('sends a later rename instead of replaying the first cached acknowledgement', async () => {
    updateChannel
      .mockResolvedValueOnce({ channel: canonical('Wingman App', 2) })
      .mockResolvedValueOnce({ channel: canonical('Nostr Browser', 3) });
    const store = commandStore();

    await updateTowerPgChannel(store, 'workspace-1', CHANNEL_ID, { name: 'Wingman App' });
    const result = await updateTowerPgChannel(store, 'workspace-1', CHANNEL_ID, { name: 'Nostr Browser' });

    expect(updateChannel).toHaveBeenCalledTimes(2);
    expect(result.channel.name).toBe('Nostr Browser');
    expect(await getChannelById(CHANNEL_ID)).toMatchObject({
      title: 'Nostr Browser',
      version: 3,
      metadata: { agent_chat: { enabled: true } },
    });
  });

  it('keeps the newer rename through an older PATCH and list materialisation', async () => {
    const releases = [];
    updateChannel.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    const store = commandStore();

    const older = updateTowerPgChannel(store, 'workspace-1', CHANNEL_ID, { name: 'Wingman App' });
    const newer = updateTowerPgChannel(store, 'workspace-1', CHANNEL_ID, { name: 'Nostr Browser' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]({ channel: canonical('Nostr Browser', 3) });
    await newer;
    releases[0]({ channel: canonical('Wingman App', 2) });
    await expect(older).resolves.toMatchObject({ stale: true });

    const stale = { ...(await getChannelById(CHANNEL_ID)), title: 'Wingman App', version: 2 };
    await upsertChannel(stale);
    await replaceChannelsForOwner(OWNER, [stale]);

    expect(await getChannelById(CHANNEL_ID)).toMatchObject({ title: 'Nostr Browser', version: 3 });
  });
});
