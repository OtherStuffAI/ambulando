import { describe, expect, it } from 'vitest';
import { loadNStackSelection, saveNStackSelection } from '../src/nstack-selection-store.js';

function fakeDb() {
  const rows = new Map();
  return {
    nstack_selections: {
      get: async key => rows.get(key),
      put: async row => rows.set(row.partition, structuredClone(row)),
      delete: async key => rows.delete(key),
    },
  };
}

describe('NStack selection persistence', () => {
  it('partitions choices by origin and Nostr identity without persisting handles', async () => {
    const db = fakeDb();
    await saveNStackSelection({
      origin: 'https://a.example', identity: 'npub1alice', workspacePartition: 'workspace-a', db,
      selection: { stackId: 'opaque-stack', stackLabel: 'Home', workspaceId: 'opaque-workspace', workspaceLabel: 'Private', handleId: 'secret-handle' },
    });
    expect(await loadNStackSelection({ origin: 'https://a.example', identity: 'npub1alice', workspacePartition: 'workspace-a', db })).toEqual({
      stackId: 'opaque-stack', stackLabel: 'Home', workspaceId: 'opaque-workspace', workspaceLabel: 'Private',
    });
    await expect(loadNStackSelection({ origin: 'https://b.example', identity: 'npub1alice', workspacePartition: 'workspace-a', db })).resolves.toBeNull();
    await expect(loadNStackSelection({ origin: 'https://a.example', identity: 'npub1bob', workspacePartition: 'workspace-a', db })).resolves.toBeNull();
    await expect(loadNStackSelection({ origin: 'https://a.example', identity: 'npub1alice', workspacePartition: 'workspace-b', db })).resolves.toBeNull();
  });
});
