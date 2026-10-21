import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRuntimeData, getWappById, openWorkspaceDb } from '../src/db.js';
const { alpineStore, createWapp, updateWapp } = vi.hoisted(() => ({ alpineStore: vi.fn(), createWapp: vi.fn(), updateWapp: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: alpineStore, start: vi.fn() } }));
vi.mock('../src/tower-command-intents.js', async original => ({ ...await original(), createTowerPgPersonalWapp: createWapp, updateTowerPgPersonalWapp: updateWapp }));
async function store() {
  const { initApp } = await import('../src/app.js');
  initApp();
  const s = alpineStore.mock.calls.find(([name]) => name === 'chat')[1];
  Object.assign(s, { backendUrl: 'https://tower.example', selectedWorkspaceKey: 'one', knownWorkspaces: [{ workspaceKey: 'one', workspaceId: 'workspace-1', workspaceOwnerNpub: 'npub-human', directHttpsUrl: 'https://tower.example', appNpub: 'flightdeck_pg', pgBackendMode: true, pgMe: { actor: { actor_id: 'synthetic-reader' } } }] });
  return s;
}
beforeEach(async () => {
  alpineStore.mockClear(); createWapp.mockReset(); updateWapp.mockReset();
  const db = openWorkspaceDb('one');
  await db.open();
  await clearRuntimeData();
});
describe('Add/Edit WApp image integration', () => {
  it('saves the uploaded URL and renders it from the returned launcher row after reopening', async () => {
    const s = await store(); s.openPersonalWappEditor();
    Object.assign(s, { personalWappFormTitle: 'Test', personalWappFormLaunchUrl: 'https://app.example', personalWappFormIconUrl: 'https://blossom.primal.net/icon.png' });
    createWapp.mockImplementation(async (_store, _workspace, body) => ({ personal_wapp: { id: 'wapp-1', ...body } }));
    await s.savePersonalWappEditor();
    expect(createWapp.mock.calls[0][2].icon_url).toBe('https://blossom.primal.net/icon.png');
    expect(s.personalWappEditorOpen).toBe(false);
    const row = await getWappById('wapp-1');
    expect(s.getPersonalWappIconUrl(row)).toBe('https://blossom.primal.net/icon.png');
    s.openPersonalWappEditor(row);
    expect(s.personalWappFormIconUrl).toBe(row.icon_url);
    updateWapp.mockResolvedValue({ personal_wapp: { id: 'wapp-1', title: 'Test', launch_url: 'https://app.example', icon_url: row.icon_url } });
    await s.savePersonalWappEditor(); expect(updateWapp).toHaveBeenCalledTimes(1);
  });
  it('blocks save before upload completion and prevents close/reopen while saving', async () => {
    const s = await store(); s.openPersonalWappEditor();
    Object.assign(s, { personalWappFormTitle: 'Test', personalWappFormLaunchUrl: 'https://app.example', personalWappImagePending: true });
    await s.savePersonalWappEditor(); expect(createWapp).not.toHaveBeenCalled();
    s.personalWappImagePending = false; s.personalWappImageBusy = true;
    await s.savePersonalWappEditor(); expect(createWapp).not.toHaveBeenCalled();
    s.personalWappImageBusy = false;
    let finish; createWapp.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = s.savePersonalWappEditor();
    await s.savePersonalWappEditor(); s.closePersonalWappEditor(); s.openPersonalWappEditor({ title: 'Other' });
    expect(s.personalWappEditorOpen).toBe(true); expect(s.personalWappFormTitle).toBe('Test'); expect(createWapp).toHaveBeenCalledTimes(1);
    finish({ personal_wapp: { id: 'one' } }); await pending;
  });
  it('retains URL and form on save failure and preserves existing fallback', async () => {
    const s = await store(); s.openPersonalWappEditor();
    Object.assign(s, { personalWappFormTitle: 'Test', personalWappFormLaunchUrl: 'https://app.example', personalWappFormIconUrl: 'https://image.example/icon.png' });
    createWapp.mockRejectedValue(new Error('offline')); await s.savePersonalWappEditor();
    expect(s.personalWappEditorOpen).toBe(true); expect(s.personalWappFormIconUrl).toBe('https://image.example/icon.png');
    expect(s.getPersonalWappIconUrl({ launch_url: 'https://app.example/path' })).toBe('https://app.example/favicon.ico');
    s.closePersonalWappEditor(); expect(s.personalWappEditorOpen).toBe(false);
  });
  it('keeps the editor open when Tower does not confirm the save or placement persistence fails', async () => {
    const s = await store();
    s.openPersonalWappEditor({ record_id: 'wapp-1', title: 'Wingman App', launch_url: 'https://app.example' });
    s.personalWappFormTitle = 'Nostr Browser';
    updateWapp.mockResolvedValue({ stale: true, acknowledgement: { personal_wapp: { id: 'wapp-1', title: 'Wingman App' } } });

    await s.savePersonalWappEditor();

    expect(s.personalWappEditorOpen).toBe(true);
    expect(s.personalWappEditorError).toContain('superseded');
    expect(s.personalWappFormTitle).toBe('Nostr Browser');

    updateWapp.mockResolvedValue({ personal_wapp: { id: 'wapp-1', title: 'Nostr Browser', launch_url: 'https://app.example', row_version: 2 } });
    s.saveAppEditorPlacement = vi.fn(async () => { throw new Error('Placement storage unavailable'); });
    await s.savePersonalWappEditor();

    expect(s.personalWappEditorOpen).toBe(true);
    expect(s.personalWappEditorError).toBe('Placement storage unavailable');
  });
});
