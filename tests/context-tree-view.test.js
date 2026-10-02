import { describe, expect, it, vi } from 'vitest';
import { createContextTreeView, contextArtifactOrigin, disposeContextTreeView, resumeContextTreeView } from '../src/context-tree-view.js';
const component = (id, parent_id = null) => ({ id, title: id, parent_id, row_version: 1 });
function harness() {
  let next;
  const unsubscribe = vi.fn(), cached = new Map(), db = { transaction: async (...args) => args.at(-1)(), context_references: { get: async id => cached.get(id) }, context_reference_resolutions: { get: async id => cached.get(id) } }, service = { ensureLoaded: vi.fn(async () => ({})) };
  const store = { getTowerSyncService: () => service, handleMentionNavigate: vi.fn() };
  const view = createContextTreeView({ store, getDb: () => db, isDbReady: () => true,
    observe: () => ({ subscribe(observer) { next = observer.next; return { unsubscribe }; } }) });
  view.init(); view.sync('workspace', 'scope', 'key');
  const emit = (components = [component('root'), component('child', 'root')], references = [], status = 'complete') => { for (const row of references) cached.set(row.id, {workspace_id:'workspace',scope_id:'scope',...row}); next({ components, references, status }); };
  return { view, service, store, emit, unsubscribe, db };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
describe('read-only Context Tree controller', () => {
  it('loads only through TowerSyncService; expansion and view transforms never fetch or persist', async () => {
    const h = harness(); h.emit(); await tick();
    expect(h.service.ensureLoaded).toHaveBeenCalledWith('context-tree', 'scope', { force: true });
    h.service.ensureLoaded.mockClear();
    h.view.toggle('root'); expect(h.view.layout.nodes).toHaveLength(1);
    h.view.toggle('root'); expect(h.view.layout.nodes).toHaveLength(2);
    h.view.zoom(1.25); h.view.fit();
    expect(h.service.ensureLoaded).not.toHaveBeenCalled();
    h.view.select('child'); await tick();
    expect(h.view.path.map(r => r.id)).toEqual(['root', 'child']);
    expect(h.service.ensureLoaded).toHaveBeenCalledWith('context-references', 'child', { scopeId: 'scope', force: true });
  });
  it('clears deleted selection and resets view state on workspace/scope change', async () => {
    const h = harness(); h.emit(); h.view.select('child'); await tick();
    h.emit([component('root')]); expect(h.view.selectedId).toBe(''); expect(h.view.notice).toContain('no longer available');
    h.view.toggle('root'); h.view.sync('other', 'otherScope', 'otherKey');
    expect(h.unsubscribe).toHaveBeenCalled(); expect(h.view.components).toEqual([]); expect(h.view.collapsed).toEqual([]);
    expect(h.view.selected).toBeNull();
  });
  it('ignores stale scope emissions and late failed loads', async () => {
    const h = harness(); let reject;
    h.service.ensureLoaded.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const loading = h.view.loadTree(); h.view.sync('other', 'otherScope', 'otherKey');
    reject(new Error('old failure')); await loading; expect(h.view.status).toBe('loading');
    h.emit([component('new')]); expect(h.view.components[0].id).toBe('new');
  });
  it('supports tree keyboard selection, expansion, parent/child and end navigation', async () => {
    const h = harness(); h.emit(); h.view.$nextTick = fn => fn();
    const key = (value, id) => h.view.keydown({ key: value, preventDefault: vi.fn() }, id);
    key('ArrowRight', 'root'); expect(h.view.focusedId).toBe('child');
    key('Enter', 'child'); expect(h.view.selectedId).toBe('child');
    key('ArrowLeft', 'child'); expect(h.view.focusedId).toBe('root');
    key('ArrowLeft', 'root'); expect(h.view.layout.nodes).toHaveLength(1);
    key('ArrowRight', 'root'); expect(h.view.layout.nodes).toHaveLength(2);
    key('End', 'root'); expect(h.view.focusedId).toBe('child'); await tick();
  });
  it('never derives reference titles or access from cached identifiers or document rows', async () => {
    const h = harness(); h.emit(); h.view.select('root'); await tick();
    const ref = { id: 'ref', component_id: 'root', row_version: 1, target_type: 'doc', target: { record_id: 'private' }, title: 'PRIVATE' };
    h.emit(undefined, [ref]); await tick();
    expect(h.view.referenceTitle(ref)).toBe('Reference unavailable'); expect(h.view.canOpen(ref)).toBe(false);
    await h.view.openReference(ref); expect(h.store.handleMentionNavigate).not.toHaveBeenCalled();
    const allowed = { ...ref, resolution: { status: 'available', title: 'Current authorized title' } };
    h.emit(undefined, [allowed]); await tick();
    expect(h.view.referenceTitle(allowed)).toBe('Current authorized title');
    await h.view.openReference(allowed); expect(h.store.handleMentionNavigate).toHaveBeenCalledWith('doc', 'private');
  });
  it('distinct unloaded/loading/empty/denied/error states and neutral reference error', async () => {
    const h = harness(); expect(h.view.stateMessage).toContain('Loading');
    h.emit([], [], 'complete'); expect(h.view.stateMessage).toContain('No components');
    h.emit([], [], 'denied'); expect(h.view.stateMessage).toContain('access');
    h.emit([], [], 'error'); expect(h.view.stateMessage).toContain('could not');
    h.emit(); h.service.ensureLoaded.mockRejectedValueOnce(new Error('private metadata'));
    h.view.select('root'); await tick(); expect(h.view.refsError).not.toContain('private metadata');
    h.view.sync('', '', ''); expect(h.view.stateMessage).toContain('Choose a scope');
  });
  it('disposes with the workspace lifecycle and can resume the mounted view', () => {
    const h = harness(); h.emit(); disposeContextTreeView(h.store);
    expect(h.unsubscribe).toHaveBeenCalled(); expect(h.view.components).toEqual([]);
    h.view.sync('other', 'scope', 'other'); h.emit([component('other')]); expect(h.view.components[0].id).toBe('other');
    h.view.destroy(); expect(h.unsubscribe).toHaveBeenCalledTimes(2);
  });
  it('reloads ACL resolution after row change or authority reset without loops', async () => {
    const h = harness(); h.emit(); h.view.select('root'); await tick();
    const ref = { id: 'r', row_version: 1, component_id: 'root', resolution: { status: 'available', title: 'A' } };
    h.emit(undefined, [ref]); await tick(); h.service.ensureLoaded.mockClear();
    h.emit(undefined, [ref]); await tick(); expect(h.service.ensureLoaded).not.toHaveBeenCalled();
    h.emit(undefined, [{ ...ref, resolution: { status: 'unavailable' } }]); await tick();
    expect(h.service.ensureLoaded).toHaveBeenCalledTimes(1);
  });
});
it('canonical external artifact origins preserve latest policy and reject executable/credential/path descriptors', () => {
  const target = { origin: 'https://artifacts.example', project: 'Suite', artifact: 'Design', page: 'index.html', version_policy: 'latest' };
  expect(contextArtifactOrigin(target)).toBe('https://artifacts.example');
  for (const patch of [{ origin: 'javascript:alert(1)' }, { origin: 'https://user:pass@example.com' }, { origin: 'https://example.com/path' }, { project: '../private' }, { page: 'evil.html' }, { version_policy: 'v4' }]) expect(contextArtifactOrigin({ ...target, ...patch })).toBe('');
});

it('opens from committed ACL resolution when liveQuery still shows cleared resolutions', async () => {
  const h = harness(); h.emit(); h.view.select('root'); await tick();
  const ref = { id: 'r', component_id: 'root', target_type: 'doc', target: { record_id: 'doc' }, row_version: 1, resolution: { status: 'available', title: 'Authorized' } };
  h.emit(undefined, [ref]); await tick();
  h.service.ensureLoaded.mockImplementationOnce(async () => {
    h.emit(undefined, [{ ...ref, resolution: { status: 'unavailable' } }]);
    h.db.context_reference_resolutions.get = async () => ({row_version:1,resolution:{status:'available'}});
  });
  await h.view.openReference(ref);
  expect(h.store.handleMentionNavigate).toHaveBeenCalledWith('doc', 'doc');
});
it('resumes on the same workspace after sync-service/lifecycle suspension', async () => {
  const h = harness(); h.emit(); disposeContextTreeView(h.store);
  Object.assign(h.store, { currentWorkspace: {workspaceId:'workspace'}, pgContextScope:{record_id:'scope',title:'Scope'}, workspaceDbKey:'key', isLoggedIn:true, isTowerPgMode:true });
  resumeContextTreeView(h.store); await tick(); h.emit();
  expect(h.view.status).toBe('complete'); expect(h.view.layout.nodes).toHaveLength(2);
});
