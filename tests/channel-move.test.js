import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb } from '../src/db.js';
import { materializeChannelMove } from '../src/channel-move-materialization.js';
import { mapPgChannelToLocal } from '../src/pg-read-hydrator.js';
import { channelMoveMixin } from '../src/channel-move-ui.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import * as api from '../src/api.js';
import { applyPgRecordChanges } from '../src/pg-record-delta.js';
import fixture from './fixtures/flightdeck-record-delta-v1.json';

let db;
beforeEach(async () => { db = openWorkspaceDb('channel-move-tests'); await db.open(); await Promise.all(db.tables.map(t => t.clear())); vi.restoreAllMocks(); });
const channel = { id: 'channel', workspace_id: 'workspace', scope_id: 'destination', name: 'Research', kind: 'named', row_version: 3 };
async function seed() {
  await db.scopes.put({ record_id: 'destination', level: 'l2', l1_id: 'root' });
  await db.channels.put({ record_id: 'channel', scope_id: 'source', channel_grants: [{ id: 'direct' }] });
  await db.tasks.put({ record_id: 'task', pg_channel_id: 'channel', scope_id: 'source', title: 'Keep draft', sync_status: 'pending', version: 7 });
  await db.documents.put({ record_id: 'doc', pg_channel_id: 'channel', scope_id: 'source', content: 'Hydrated body', cache_scope: 'source' });
  await db.chat_messages.put({ record_id: 'message', channel_id: 'channel', pg_scope_id: 'source', body: 'Conversation' });
  await db.comments.put({ record_id: 'comment', task_id: 'task', pg_scope_id: 'source', body: 'Reply' });
  await db.pg_resource_attention.put({ record_id: 'task:task', resource_id: 'task', scope_id: 'source', channel_id: 'channel' });
  await db.pg_record_rows.put({ key: 'task:task', family: 'task', id: 'task', row: { id: 'task', channel_id: 'channel', scope_id: 'source', title: 'Canonical title' } });
  await db.pending_writes.add({ record_id: 'task', envelope: { scope_id: 'source', title: 'Keep draft' } });
  await db.notification_items.put({ key: 'notification', context: 'test', target: { channel_id: 'channel', scope_id: 'source' }, subject: { task_id: 'task', scope_id: 'source' } });
  await db.audio_notes.put({ record_id: 'audio', pg_channel_id: 'channel', pg_scope_id: 'source', transcript: 'Keep voice' });
  await db.daily_notes.put({ record_id: 'daily', pg_channel_id: 'channel', pg_scope_id: 'source', body: 'Keep daily note' });
  await db.tasks.put({ record_id: 'other', pg_channel_id: 'other-channel', scope_id: 'source' });
}
describe('channel move authority materialization', () => {
  it('moves every loaded projection atomically without discarding drafts, content or direct grants', async () => {
    await seed();
    await materializeChannelMove(db, channel, mapPgChannelToLocal, 'owner');
    expect(await db.tasks.get('task')).toMatchObject({ scope_id: 'destination', scope_l1_id: 'root', scope_l2_id: 'destination', sync_status: 'pending', version: 7, title: 'Keep draft', cache_scope: 'destination' });
    expect((await db.tasks.get('task')).cache_board_keys.some(key => key[0] === 'scope:destination')).toBe(true);
    expect(await db.documents.get('doc')).toMatchObject({ scope_id: 'destination', cache_scope: 'destination', content: 'Hydrated body' });
    expect(await db.chat_messages.get('message')).toMatchObject({ pg_scope_id: 'destination', body: 'Conversation' });
    expect(await db.comments.get('comment')).toMatchObject({ pg_scope_id: 'destination', body: 'Reply' });
    expect(await db.pg_resource_attention.get('task:task')).toMatchObject({ scope_id: 'destination' });
    expect(await db.channels.get('channel')).toMatchObject({ scope_id: 'destination', channel_grants: [{ id: 'direct' }] });
    expect((await db.pg_record_rows.get('task:task')).row).toEqual({ id: 'task', channel_id: 'channel', scope_id: 'destination', title: 'Canonical title' });
    expect((await db.pending_writes.toArray())[0].envelope).toEqual({ scope_id: 'source', title: 'Keep draft' });
    expect(await db.notification_items.get('notification')).toMatchObject({ target: { scope_id: 'destination' }, subject: { scope_id: 'destination' } });
    expect(await db.audio_notes.get('audio')).toMatchObject({ pg_scope_id: 'destination', transcript: 'Keep voice' });
    expect(await db.daily_notes.get('daily')).toMatchObject({ pg_scope_id: 'destination', body: 'Keep daily note' });
    expect(await db.tasks.get('other')).toMatchObject({ scope_id: 'source' });
  });
  it('rolls back the entire relocation if the canonical channel cannot be stored', async () => {
    await seed();
    await expect(materializeChannelMove(db, channel, () => { throw new Error('mapping failed'); })).rejects.toThrow('mapping failed');
    expect((await db.tasks.get('task')).scope_id).toBe('source');
    expect((await db.channels.get('channel')).scope_id).toBe('source');
  });
  it('reconciles remote/reconnect channel deltas including loaded pending child projections', async () => {
    await seed();
    const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
    const store = { workspaceId, workspaceOwnerNpub: 'owner', backendUrl: 'http://localhost:3100', session: { npub: 'viewer' }, currentWorkspace: { workspaceId, pgBackendMode: true } };
    const change = { family: 'channel', id: channel.id, workspace_id: workspaceId, channel_id: channel.id, operation: 'upsert', version: '90', row: { ...channel, workspace_id: workspaceId } };
    await applyPgRecordChanges(store, { ...fixture.one_message_delta, changes: [change], has_more: false, next_cursor: 'moved' });
    expect((await db.tasks.get('task')).scope_id).toBe('destination');
    expect((await db.documents.get('doc')).scope_id).toBe('destination');
    expect((await db.chat_messages.get('message')).pg_scope_id).toBe('destination');
  });
  it('does not replay an older move acknowledgement over a newer channel location', async () => {
    await seed();
    await db.channels.update('channel', { scope_id: 'newer-destination', updated_at: '2026-11-04T03:00:00Z' });
    await materializeChannelMove(db, { ...channel, updated_at: '2026-11-04T02:00:00Z' }, mapPgChannelToLocal);
    expect((await db.channels.get('channel')).scope_id).toBe('newer-destination');
    expect((await db.tasks.get('task')).scope_id).toBe('source');
  });
  it('retains the original database target across a workspace switch during a move', async () => {
    await seed();
    const original = db;
    let finish;
    vi.spyOn(api, 'moveTowerPgChannel').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const store = { workspaceOwnerNpub: 'owner' };
    const service = new TowerSyncService({ workspaceKey: 'test', ports: { prepareCommand: (name, input) => prepareTowerWorkspaceCommand(store, name, input) } });
    const request = service.command('channel.move', { args: ['workspace', 'channel', { destination_scope_id: 'destination', mutation_id: 'switch' }] });
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    service.dispose();
    const other = openWorkspaceDb('channel-move-other'); await other.open();
    await other.channels.put({ record_id: 'channel', scope_id: 'unrelated' });
    finish({ channel }); await rejected;
    await original.open();
    expect((await original.channels.get('channel')).scope_id).toBe('destination');
    expect((await other.channels.get('channel')).scope_id).toBe('unrelated');
    other.close(); openWorkspaceDb('channel-move-tests');
  });
  it('does not change scope until the service receives Tower success; retries use the same mutation', async () => {
    await seed();
    const store = { workspaceOwnerNpub: 'owner' };
    const service = new TowerSyncService({ workspaceKey: 'test', ports: { prepareCommand: (name, input) => prepareTowerWorkspaceCommand(store, name, input) } });
    const request = { args: ['workspace', 'channel', { destination_scope_id: 'destination', confirmation_token: 'token', mutation_id: 'mutation' }] };
    const transport = vi.spyOn(api, 'moveTowerPgChannel').mockRejectedValueOnce(new Error('network')).mockResolvedValue({ channel });
    await expect(service.command('channel.move', request, { clientMutationId: 'mutation' })).rejects.toThrow('network');
    expect((await db.channels.get('channel')).scope_id).toBe('source');
    await service.command('channel.move', request, { clientMutationId: 'mutation' });
    await service.command('channel.move', request, { clientMutationId: 'mutation' });
    expect(transport).toHaveBeenCalledTimes(2);
    expect((await db.channels.get('channel')).scope_id).toBe('destination');
    service.dispose();
  });
});
function ui() {
  const result = { isTowerPgMode: true, channelSettingsChannelId: 'channel', channelSettingsWorkspaceId: 'workspace', channelMoveDestinationId: 'destination',
    channels: [{ record_id: 'channel', scope_id: 'source' }], scopes: [{ record_id: 'destination', title: 'Destination' }],
    canManageChannel: () => true, canManageScope: () => true,
    workspaceId: 'workspace', backendUrl: 'http://localhost:3100', currentWorkspace: { workspaceId: 'workspace', pgBackendMode: true },
    commandTowerWorkspace: vi.fn(),
  };
  Object.defineProperties(result, Object.getOwnPropertyDescriptors(channelMoveMixin));
  result.channelMoveDestinationId = 'destination';
  return result;
}
const preview = { channel_id: 'channel', source_scope_id: 'source', destination_scope_id: 'destination', confirmation_token: 'token', access_changes: { gained: [], lost: [], retained: [], direct_grants_preserved: true, direct_grant_count: 1 }, warnings: ['Direct grants remain authoritative.'] };
describe('channel move confirmation', () => {
  it('requires preview and preserves the exact request after an uncertain network failure', async () => {
    const s = ui();
    await s.confirmSettingsChannelMove(); expect(s.commandTowerWorkspace).not.toHaveBeenCalled();
    s.commandTowerWorkspace.mockResolvedValueOnce({ preview });
    await s.previewSettingsChannelMove(); expect(s.channelMovePreview).toEqual(preview);
    s.commandTowerWorkspace.mockRejectedValueOnce(new Error('network'));
    await s.confirmSettingsChannelMove(); const request = { ...s.channelMoveRequest };
    s.commandTowerWorkspace.mockResolvedValueOnce({ channel });
    await s.confirmSettingsChannelMove();
    expect(s.commandTowerWorkspace.mock.calls[2][1].args[2]).toEqual(request);
    expect(s.channelMoveNotice).toContain('Channel moved');
  });
  it.each([403, 404, 409])('invalidates confirmation after HTTP %i', async status => {
    const s = ui(); s.channelMovePreview = preview;
    s.commandTowerWorkspace.mockRejectedValue(Object.assign(new Error('denied'), { status }));
    await s.confirmSettingsChannelMove();
    expect(s.channelMovePreview).toBeNull(); expect(s.channelMoveRequest).toBeNull(); expect(s.channelMoveError).toBeTruthy();
  });
  it('rejects incomplete previews and filters denied, system and current scopes', async () => {
    const s = ui();
    s.scopes.push({ record_id: 'source' }, { record_id: 'system', system_key: 'daily' }, { record_id: 'denied' });
    s.canManageScope = scope => scope.record_id !== 'denied';
    expect(Object.getOwnPropertyDescriptor(channelMoveMixin, 'channelMoveDestinations').get.call(s).map(row => row.id)).toEqual(['destination']);
    s.commandTowerWorkspace.mockResolvedValue({ preview: { ...preview, access_changes: {} } });
    await s.previewSettingsChannelMove(); expect(s.channelMovePreview).toBeNull();
  });
});
