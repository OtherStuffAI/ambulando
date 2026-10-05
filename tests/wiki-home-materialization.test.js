import { expect, it } from 'vitest';
import { getChannelsByOwner, upsertChannel, openWorkspaceDb } from '../src/db.js';
import { mapPgChannelToLocal } from '../src/pg-read-hydrator.js';
import { wikiManagerMixin } from '../src/docs/wiki-manager.js';

it('restores shared home from canonical channel materialization after cache/store reopen and clear', async () => {
  const owner = `wiki-owner-${crypto.randomUUID()}`;
  const channelId = crypto.randomUUID();
  openWorkspaceDb(owner);
  const canonical = { id: channelId, name: 'Notebook', scope_id: 'scope', row_version: 2,
    metadata: { docs_home_document_id: 'home-page', agent_chat: { context_prompt: 'Keep' } } };
  await upsertChannel(mapPgChannelToLocal(canonical, { workspaceOwnerNpub: owner }));
  const channels = await getChannelsByOwner(owner);
  const reader = { selectedChannelId: channelId, selectedChannel: channels[0], documents: [{ record_id: 'home-page', title: 'Home', pg_channel_id: channelId }] };
  Object.defineProperties(reader, Object.getOwnPropertyDescriptors(wikiManagerMixin));
  expect(reader.channelDocsHomeId).toBe('home-page');
  expect(reader.channelDocsHome.title).toBe('Home');
  expect(channels[0].metadata.agent_chat.context_prompt).toBe('Keep');
  await upsertChannel(mapPgChannelToLocal({ ...canonical, row_version: 3, metadata: { ...canonical.metadata, docs_home_document_id: null } }, { workspaceOwnerNpub: owner }));
  reader.selectedChannel = (await getChannelsByOwner(owner))[0];
  expect(reader.channelDocsHomeId).toBe('');
  expect(reader.channelDocsHome).toBeNull();
});
