import { describe, expect, it, vi } from 'vitest';
import { createContextTreeView, contextArtifactOrigin, disposeContextTreeView, resumeContextTreeView } from '../src/context-tree-view.js';
const component = (id, parent_id = null) => ({ id, title: id, parent_id, row_version: 1 });
function harness(extra = {}) {
  let next;
  const unsubscribe = vi.fn(), cached = new Map(), db = { transaction: async (...args) => args.at(-1)(), context_references: { get: async id => cached.get(id) }, context_reference_resolutions: { get: async id => cached.get(id) } }, service = { ensureLoaded: vi.fn(async () => ({})) };
  const store = { getTowerSyncService: () => service, handleMentionNavigate: vi.fn() };
  const view = createContextTreeView({ ...extra, store, getDb: () => db, isDbReady: () => true,
    observe: () => ({ subscribe(observer) { next = observer.next; return { unsubscribe }; } }) });
  view.init(); view.sync('workspace', 'scope', 'key');
  const emit = (components = [component('root'), component('child', 'root')], references = [], status = 'complete') => { for (const row of references) cached.set(row.id, {workspace_id:'workspace',scope_id:'scope',...row}); next({ components, references, status }); };
  return { view, service, store, emit, unsubscribe, db };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
describe('read-only Context Tree controller', () => {
  it('shows a load error for an unregistered route and neutral denial for an inaccessible scope', async () => {
    const h = harness(); await tick();
    h.service.ensureLoaded.mockRejectedValueOnce(Object.assign(new Error('404 Not Found'), { status: 404 }));
    await h.view.loadTree();
    expect(h.view.status).toBe('error');
    expect(h.view.stateMessage).toContain('could not be loaded');
    expect(h.view.canManage).toBe(false);
    h.service.ensureLoaded.mockRejectedValueOnce(Object.assign(new Error('Context unavailable'), { status: 404, code: 'context_not_found' }));
    await h.view.loadTree();
    expect(h.view.status).toBe('denied');
    expect(h.view.stateMessage).toContain('unavailable for your access');
    expect(h.view.canManage).toBe(false);
  });
  it('search reveals a collapsed match by path and selects it without changing persisted layout',async()=>{
    const h=harness();h.emit();h.view.toggle('root');h.view.nodeSearch='root / child';expect(h.view.nodeResults.map(r=>r.id)).toEqual(['child']);
    h.view.scale=2.5;h.view.viewportWidth=340;h.view.chooseNode(h.view.nodeResults[0]);expect(h.view.scale).toBeLessThanOrEqual(1);expect(h.view.selectedId).toBe('child');expect(h.view.collapsed).toEqual([]);expect(h.view.nodeSearchOpen).toBe(false);
  });
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

it('defaults to Outline, safely persists only the view, and shares selection/collapse without transport', async () => {
  const storage = { getItem: vi.fn(() => 'invalid'), setItem: vi.fn() };
  const h = harness({ storage }); h.emit(); h.view.select('child'); h.view.toggle('root'); await tick();
  expect(h.view.viewMode).toBe('outline');
  h.service.ensureLoaded.mockClear();
  h.view.setView('visual'); expect(h.view.selectedId).toBe('child'); expect(h.view.collapsed).toEqual(['root']);
  expect(h.view.scale).toBeGreaterThanOrEqual(0.65);
  h.view.setView('outline'); expect(h.view.collapsed).toEqual(['root']); expect(h.view.selectedId).toBe('child');
  expect(storage.setItem).toHaveBeenLastCalledWith('flightdeck.context-tree.view', 'outline');
  expect(h.service.ensureLoaded).not.toHaveBeenCalled();
  expect(harness({ storage: { getItem: () => 'visual' } }).view.viewMode).toBe('visual');
  const blocked = harness({ storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } } });
  expect(blocked.view.viewMode).toBe('outline'); expect(() => blocked.view.setView('visual')).not.toThrow();
});
it('reveals hidden search matches in both views and bounds a large outline without altering rows', () => {
  const h = harness();
  const rows = [component('root'), ...Array.from({length:4000}, (_,i) => ({...component('child-'+i,'root'),sort_order:i}))];
  h.emit(rows);
  expect(h.view.visibleNodes.length).toBeLessThan(40);
  for (const mode of ['outline','visual']) {
    h.view.setView(mode); h.view.toggle('root'); h.view.nodeSearch = 'child-3999';
    h.view.chooseNode(h.view.nodeResults[0]);
    expect(h.view.selectedId).toBe('child-3999'); expect(h.view.collapsed).toEqual([]);
    expect(h.view.visibleNodes.some(n=>n.id==='child-3999')).toBe(true);
  }
  expect(h.view.components).toEqual(rows);
});

it('defers native Outline scrolling until the switched DOM geometry is committed', () => {
  const h = harness(), pending = [];
  h.emit([component('root'), ...Array.from({length:2000}, (_,i) => ({...component('child-'+i,'root'),sort_order:i}))]);
  const canvas = { scrollTop:0, querySelectorAll:()=>[] };
  h.view.$refs = { canvas }; h.view.$nextTick = fn => pending.push(fn);
  h.view.setView('visual'); pending.splice(0).forEach(fn=>fn());
  h.view.focusedId = 'child-1999'; h.view.setView('outline');
  expect(h.view.outlineScroll).toBeGreaterThan(90000);
  expect(canvas.scrollTop).toBe(0);
  pending.splice(0).forEach(fn=>fn());
  expect(canvas.scrollTop).toBe(h.view.outlineScroll);
  expect(h.view.visibleNodes.some(n=>n.id==='child-1999')).toBe(true);
});

it('applies L1/L2/L3 across forests and views, preserves hidden selection, and allows manual/search overrides', async () => {
  const h=harness(); const rows=[component('root'),component('child','root'),component('grandchild','child'),component('leaf','grandchild'),component('other')];
  h.emit(rows); h.view.select('leaf'); await tick(); h.service.ensureLoaded.mockClear();
  for(const mode of ['outline','visual']) {
    h.view.setView(mode);
    for(const level of [1,2,3]) {
      h.view.setLevelPreset(String(level));
      expect(h.view.activeLevelPreset).toBe(String(level));
      expect(h.view.layout.nodes.filter(n=>n.depth>=level)).toEqual([]);
      expect(h.view.layout.nodes.map(n=>n.id)).toContain('other');
      expect(h.view.selectedId).toBe('leaf');
      expect(h.view.layout.nodes.some(n=>n.id===h.view.focusedId)).toBe(true);
    }
  }
  expect(h.service.ensureLoaded).not.toHaveBeenCalled(); expect(h.view.components).toEqual(rows);
  h.view.toggle('grandchild'); expect(h.view.activeLevelPreset).toBe('All'); expect(h.view.layout.nodes.map(n=>n.id)).toContain('leaf');
  h.view.setLevelPreset('1');h.view.nodeSearch='leaf';h.view.chooseNode(h.view.nodeResults[0]);
  expect(h.view.activeLevelPreset).toBe('All');expect(h.view.layout.nodes.map(n=>n.id)).toContain('leaf');
  h.view.busy=true;h.view.setLevelPreset('1');expect(h.view.activeLevelPreset).toBe('All');
});

for (const mode of ['outline', 'visual']) it(`${mode} level presets collapse every boundary branch in a forest, retain selection and reveal search`, async () => {
  const h = harness();
  const rows = [component('a'), component('b','a'), component('c','b'), component('d','c'), component('e'), component('f','e'), component('g','f'), component('h','g')];
  const references = [{id:'ref',component_id:'d',row_version:1}];
  h.emit(rows, references); h.view.setView(mode); h.view.select('d'); await tick(); h.service.ensureLoaded.mockClear();
  for (const [level, visible, closed, focus] of [
    ['1',['a','e'],['a','b','c','e','f','g'],'a'],
    ['2',['a','b','e','f'],['b','c','f','g'],'b'],
    ['3',['a','b','c','e','f','g'],['c','g'],'c'],
    ['All',['a','b','c','d','e','f','g','h'],[],'d'],
  ]) {
    h.view.setLevelPreset(level);
    expect(h.view.layout.nodes.map(n=>n.id)).toEqual(visible);
    expect(h.view.collapsed).toEqual(closed);
    expect(h.view.activeLevelPreset).toBe(level);
    expect(h.view.focusedId).toBe(focus);
    expect(h.view.selectedId).toBe('d'); expect(h.view.directReferences).toEqual(references);
  }
  expect(h.service.ensureLoaded).not.toHaveBeenCalled();
  h.view.setLevelPreset('1'); h.view.toggle('a');
  expect(h.view.activeLevelPreset).toBe('Custom');
  expect(h.view.layout.nodes.map(n=>n.id)).toEqual(['a','b','e']);
  h.view.toggle('a'); expect(h.view.activeLevelPreset).toBe('1');
  h.view.nodeSearch='d'; h.view.chooseNode(h.view.nodeResults[0]);
  expect(h.view.selectedId).toBe('d'); expect(h.view.focusedId).toBe('d');
  expect(h.view.activeLevelPreset).toBe('Custom');
  expect(h.view.components).toEqual(rows); expect(h.view.references).toEqual(references);
});
