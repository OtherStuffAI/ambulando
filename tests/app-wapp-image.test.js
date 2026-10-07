import { beforeEach, describe, expect, it, vi } from 'vitest';
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
beforeEach(() => { alpineStore.mockClear(); createWapp.mockReset(); updateWapp.mockReset(); });
describe('Add/Edit WApp image integration', () => {
  it('saves the uploaded URL and renders it from the returned launcher row after reopening', async () => {
    const s = await store(); s.openPersonalWappEditor();
    Object.assign(s, { personalWappFormTitle: 'Test', personalWappFormLaunchUrl: 'https://app.example', personalWappFormIconUrl: 'https://blossom.primal.net/icon.png' });
    createWapp.mockImplementation(async (_store, _workspace, body) => ({ personal_wapp: { id: 'wapp-1', ...body } }));
    await s.savePersonalWappEditor();
    expect(createWapp.mock.calls[0][2].icon_url).toBe('https://blossom.primal.net/icon.png');
    expect(s.personalWappEditorOpen).toBe(false);
    const row = s.wapps.find(w => w.record_id === 'wapp-1');
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
});
