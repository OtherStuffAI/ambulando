import './setup.js';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { closeWorkspaceDb, createWorkspaceDb, getWorkspaceDb, openWorkspaceDb, openWorkspaceDbProgressively } from '../src/db.js';

afterEach(() => closeWorkspaceDb());

it('publishes a fully registered schema with the same versions, indexes and hooks', async () => {
  const regular = createWorkspaceDb('startup-reference');
  const progressive = await openWorkspaceDbProgressively('startup-progressive');
  const schema = db => db.tables.map(table => ({ name: table.name, indexes: table.schema.indexes.map(index => index.src) })).sort((a,b) => a.name.localeCompare(b.name));
  expect(progressive.verno).toBe(regular.verno);
  expect(schema(progressive)).toEqual(schema(regular));
  expect(getWorkspaceDb()).toBe(progressive);
  await progressive.open();
  await progressive.documents.put({ record_id: 'doc', content: 'body', updated_at: '2026-10-24', record_state: 'active' });
  expect(await progressive.documents.get('doc')).toMatchObject({ cache_active: 1, cache_time: '2026-10-24' });
  regular.close(); await progressive.delete();
});

it('coalesces same-workspace preparation and never exposes a partial handle', async () => {
  closeWorkspaceDb();
  const first = openWorkspaceDbProgressively('startup-shared');
  const second = openWorkspaceDbProgressively('startup-shared');
  expect(() => getWorkspaceDb()).toThrow();
  expect(await first).toBe(await second);
});

it('rejects completion after logout or a newer workspace selection', async () => {
  const logout = openWorkspaceDbProgressively('startup-cancelled');
  closeWorkspaceDb();
  await expect(logout).rejects.toMatchObject({ name: 'AbortError' });
  const old = openWorkspaceDbProgressively('startup-old');
  const current = openWorkspaceDb('startup-current');
  await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  expect(getWorkspaceDb()).toBe(current);
});


it('cancels a different pending workspace when selecting the already-open workspace', async () => {
  const current = openWorkspaceDb('startup-retained');
  const old = openWorkspaceDbProgressively('startup-unwanted');
  expect(await openWorkspaceDbProgressively('startup-retained')).toBe(current);
  await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  expect(getWorkspaceDb()).toBe(current);
});


it('opens an existing database through the unchanged upgrade callbacks without losing cached identities', async () => {
  const key = 'startup-upgrade';
  const old = new Dexie(`wingman-fd-ws-${key}`);
  old.version(43).stores({ canvas_snapshots: '&key, context, canvas_id, authorized_at', canvas_board_drafts: '&key, context, file_id' });
  await old.open();
  await old.table('canvas_snapshots').put({ key: 'viewer:canvas', context: 'viewer-authority', canvas_id: 'canvas', comments: ['legacy'], naplets: [{ id: 'original' }] });
  await old.table('canvas_board_drafts').put({ key: 'viewer:board', context: 'viewer-authority', file_id: 'board', scene: { elements: [{ id: 'unsaved' }] } });
  old.close();
  const upgraded = await openWorkspaceDbProgressively(key);
  await upgraded.open();
  expect(await upgraded.canvas_snapshots.get('viewer:canvas')).toEqual({ key: 'viewer:canvas', context: 'viewer-authority', canvas_id: 'canvas', naplets: [{ id: 'original' }] });
  expect((await upgraded.canvas_board_drafts.get('viewer:board')).scene.elements[0].id).toBe('unsaved');
  await upgraded.delete();
});
