import { describe, it, expect, vi } from 'vitest';
import { beginInternalReferenceVisit, resolveInternalReference } from '../src/internal-reference-navigation.js';

const row = { record_id: 'target', record_state: 'active', pg_channel_id: 'other-channel' };
const store = () => ({ documents: [], tasks: [], scopes: [], channels: [], directories: [], reports: [], navSection: 'chat', selectedChannelId: 'origin', currentWorkspace: { workspaceId: 'workspace' }, applyDocuments(rows) { this.documents = rows; } });

describe('internal reference target resolution', () => {
  it('opens cached Dexie documents without transport or requiring rendered rows', async () => {
    const state = store();
    const hydrate = vi.fn();
    expect(await resolveInternalReference(state, 'document', 'target', { readLocal: async () => row, hydrate })).toBe(row);
    expect(state.documents).toEqual([row]);
    expect(hydrate).not.toHaveBeenCalled();
  });
  it('uses only the target family for cold document and task links', async () => {
    for (const [type, family, collection] of [['doc', 'document', 'documents'], ['task', 'task', 'tasks']]) {
      const state = store();
      const hydrate = vi.fn(async () => { state[collection] = [row]; });
      expect(await resolveInternalReference(state, type, 'target', { readLocal: async () => null, hydrate })).toBe(row);
      expect(hydrate).toHaveBeenCalledWith(family, 'target');
    }
  });
  it('resolves file links through the narrow file family and preserves the file destination marker', async () => {
    const state = store();
    const file = { ...row, pg_record_type: 'file', pg_storage_object_id: 'object' };
    const hydrate = vi.fn(async () => { state.documents = [file]; });
    expect(await resolveInternalReference(state, 'file', 'target', { readLocal: async () => null, hydrate })).toBe(file);
    expect(hydrate).toHaveBeenCalledWith('file', 'target');
  });
  it('rejects deleted and unreadable targets even when rendered', async () => {
    for (const patch of [{ record_state: 'deleted' }, { can_read: false }, { readable: false }]) {
      const state = store(); state.documents = [{ ...row, ...patch }];
      await expect(resolveInternalReference(state, 'doc', 'target')).rejects.toThrow('unavailable');
    }
  });
  it('rejects a foreign workspace row even if it is in a rendered collection', async () => {
    const state = store(); state.documents = [{ ...row, pg_workspace_id: 'foreign' }];
    await expect(resolveInternalReference(state, 'doc', 'target')).rejects.toThrow('unavailable');
  });
  it('reports unsupported and unavailable destinations instead of silently ignoring them', async () => {
    await expect(resolveInternalReference(store(), 'flow', 'target')).rejects.toThrow('cannot open');
    await expect(resolveInternalReference(store(), 'report', 'target', { readLocal: async () => null })).rejects.toThrow('unavailable');
  });
  it('cancels a pending target after the same task was closed and reopened or its scope board changed', async () => {
    for (const change of [state => { state.taskDetailOpenGeneration += 2; }, state => { state.selectedBoardId = 'other-scope'; }]) {
      const state = store(); state.activeTaskId = 'source-task'; state.taskDetailOpenGeneration = 1;
      const visit = beginInternalReferenceVisit(state);
      let finish;
      const pending = resolveInternalReference(state, 'doc', 'target', { isCurrent: visit.isCurrent, readLocal: () => new Promise(resolve => { finish = resolve; }) });
      change(state); finish(row);
      expect(await pending).toBe(null);
      expect(state.documents).toEqual([]);
    }
  });
  it('does not apply a late cold response after another click or a view change', async () => {
    for (const mutate of [state => beginInternalReferenceVisit(state), state => { state.navSection = 'docs'; }, state => { state.selectedChannelId = 'changed'; }, state => { state.currentWorkspace = { workspaceId: 'other' }; }]) {
      const state = store(); const visit = beginInternalReferenceVisit(state);
      let finish;
      const readLocal = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(row);
      const result = resolveInternalReference(state, 'doc', 'target', { isCurrent: visit.isCurrent, readLocal, hydrate: () => new Promise(resolve => { finish = resolve; }) });
      await Promise.resolve(); await Promise.resolve();
      mutate(state); finish();
      expect(await result).toBe(null);
      expect(state.documents).toEqual([]);
    }
  });
});

import { hydrateTowerPgChannel, hydrateTowerPgFile } from '../src/pg-read-hydrator.js';

describe('narrow typed reference reads', () => {
  const state = () => ({ currentWorkspace: { workspaceId: 'workspace', workspaceOwnerNpub: 'owner', directHttpsUrl: 'http://localhost:7080' }, session: { npub: 'actor' } });
  it.each([
    ['channel', hydrateTowerPgChannel, 'getTowerPgChannel', 'upsertPgListedChannel'],
    ['file', hydrateTowerPgFile, 'getTowerPgFile', 'upsertDocument'],
  ])('reads just the requested %s and persists through the existing mapper', async (kind, hydrate, readName, writeName) => {
    const read = vi.fn(async () => ({ [kind]: { id: 'target', workspace_id: 'workspace', channel_id: 'channel', title: 'Target' } }));
    const write = vi.fn();
    const result = await hydrate(state(), 'target', { [readName]: read, [writeName]: write, getSyncState: async () => null, runWorkspaceSyncTransaction: async callback => callback() });
    expect(read).toHaveBeenCalledWith('workspace', 'target', expect.objectContaining({ baseUrl: 'http://localhost:7080' }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'target' }));
    expect(result.record_id).toBe('target');
  });
  it('refuses foreign workspace metadata before materialization', async () => {
    const write = vi.fn();
    expect(await hydrateTowerPgChannel(state(), 'target', { getTowerPgChannel: async () => ({ channel: { id: 'target', workspace_id: 'foreign' } }), upsertPgListedChannel: write, getSyncState: async () => null, runWorkspaceSyncTransaction: async callback => callback() })).toBe(null);
    expect(write).not.toHaveBeenCalled();
  });
  it('does not commit a channel response after a workspace switch', async () => {
    const target = state(); const write = vi.fn();
    await expect(hydrateTowerPgChannel(target, 'target', { getTowerPgChannel: async () => { target.currentWorkspace = { workspaceId: 'other' }; return { channel: { id: 'target', workspace_id: 'workspace' } }; }, upsertPgListedChannel: write, getSyncState: async () => null, runWorkspaceSyncTransaction: async callback => callback() })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});

import { rememberReferenceComposerDraft, restoreReferenceComposerDraft } from '../src/internal-reference-navigation.js';

it('restores source comment text and attachments only for the same workspace and target', () => {
  const state = store();
  state.newTaskCommentBody = 'Unsent source comment';
  state.taskCommentAudioDrafts = [{ id: 'source-audio' }];
  rememberReferenceComposerDraft(state, 'task', 'source');
  state.newTaskCommentBody = '';
  state.taskCommentAudioDrafts = [];
  restoreReferenceComposerDraft(state, 'task', 'other');
  expect(state.newTaskCommentBody).toBe('');
  state.currentWorkspace = { workspaceId: 'foreign' };
  restoreReferenceComposerDraft(state, 'task', 'source');
  expect(state.newTaskCommentBody).toBe('');
  state.currentWorkspace = { workspaceId: 'workspace' };
  restoreReferenceComposerDraft(state, 'task', 'source');
  expect(state.newTaskCommentBody).toBe('Unsent source comment');
  expect(state.taskCommentAudioDrafts).toEqual([{ id: 'source-audio' }]);
});
