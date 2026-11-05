import { beforeEach, describe, expect, it, vi } from 'vitest';
const { ensure } = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock('../src/api.js', async original => ({ ...await original(), ensureTowerPgGeneral: ensure }));
import { openWorkspaceDb, clearRuntimeData, getChannelById } from '../src/db.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import { ensureTowerPgGeneral } from '../src/tower-command-intents.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
beforeEach(async () => { await openWorkspaceDb('general-owner').open(); await clearRuntimeData(); ensure.mockReset(); });
describe('canonical General command', () => {
  it('materializes canonical scope and channel through the workspace command service', async () => {
    const response = { scope: { id: 'general-scope', name: 'Shared', kind: 'scope', workspace_id: 'w' }, channel: { id: 'general-channel', scope_id: 'general-scope', name: 'General', kind: 'channel', workspace_id: 'w' }, policy: { kind: 'all_workspace_members' } };
    ensure.mockResolvedValue(response);
    const store = { workspaceOwnerNpub: 'general-owner' };
    const service = new TowerSyncService({ workspaceKey: 'w', ports: { prepareCommand: (name, input) => prepareTowerWorkspaceCommand(store, name, input) } });
    store.commandTowerWorkspace = (name, input, options) => service.command(name, input, options);
    expect(await ensureTowerPgGeneral(store, 'w', { baseUrl: 'https://nstack.otherstuff.ai' })).toEqual(response);
    expect((await getChannelById('general-channel')).title).toBe('General');
    expect(ensure).toHaveBeenCalledWith('w', { baseUrl: 'https://nstack.otherstuff.ai' });
    service.dispose();
  });
});
