import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { diagnosticsManagerMixin, diagnosticsScope } from '../src/diagnostics-manager.js';
import { createDiagnosticsDb, DiagnosticsStore } from '../src/diagnostics-store.js';
import { DiagnosticsWorkerClient } from '../src/diagnostics-runtime.js';

let db, recorder, store;
const saved = { enabled: true, automatic: true, scopeId: 'project', channelId: 'bugs', agentNpub: 'agent' };
beforeEach(() => {
  db = createDiagnosticsDb(`defaults-${crypto.randomUUID()}`); recorder = new DiagnosticsStore(db);
  store = Object.defineProperties({}, Object.getOwnPropertyDescriptors(diagnosticsManagerMixin));
  Object.assign(store, { isTowerPgMode: true, session: {npub:'actor'}, backendUrl:'http://tower', currentWorkspace:{workspaceId:'w'},
    scopes:[{record_id:'project',name:'Project'},{record_id:'other',name:'Other'}],
    channels:[{record_id:'bugs',scope_id:'project',name:'Bugs'},{record_id:'elsewhere',scope_id:'other'}, {record_id:'foreign',scope_id:'project',workspace_id:'foreign'}],
    pgWorkspaceMembers:[{kind:'agent',npub:'agent',display_name:'Triage'}] });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete(); });

it('preserves the exact default across database close/relaunch and uses it for manual and automatic reports', async () => {
  const key = diagnosticsScope(store);
  await recorder.configure(key,saved); db.close(); await db.open();
  const reopened = new DiagnosticsStore(db,()=>Date.now()+16000);
  store.applyDiagnosticsInfo(await reopened.info(key));
  expect(store.diagnosticsSettings).toEqual(saved);
  expect(store.diagnosticsDefaultDestination).toBe('Saved default: Project > Bugs · Triage');
  await reopened.queue(key,{incidentId:'manual',manualAuthorized:true});
  await reopened.queue(key,{incidentId:'auto',automatic:true});
  const row = await db.scopes.get(key);
  expect(row.queue.map(i=>[i.scopeId,i.channelId,i.agentNpub])).toEqual([['project','bugs','agent'],['project','bugs','agent']]);
});

it('derives a legacy channel scope, retaining channel/agent and consent revision until an intentional Save', async () => {
  const key = diagnosticsScope(store); await recorder.configure(key,saved);
  const row = await db.scopes.get(key); delete row.settings.scopeId; await db.scopes.put(row);
  store.applyDiagnosticsInfo(await recorder.info(key));
  expect(store.diagnosticsSettings.scopeId).toBe('project');
  expect(store.diagnosticsSettingsDirty).toBe(false);
  expect(store.diagnosticsDefaultError).toBe('');
  expect((await recorder.info(key)).revision).toBe(row.revision);
  await recorder.configure(key,store.diagnosticsSettings);
  expect((await recorder.info(key)).settings.scopeId).toBe('project');
});

it('filters by project scope and clears incompatible channel on change/reset, with explicit discard', () => {
  store.selectedScopeId='navigation-scope'; store.selectedChannelId='navigation-channel';
  store.applyDiagnosticsInfo({settings:saved});
  expect(store.diagnosticsChannelOptions.map(c=>c.record_id)).toEqual(['bugs']);
  store.changeDiagnosticsScope('other'); expect(store.diagnosticsSettings.channelId).toBe('');
  expect(store.diagnosticsChannelOptions.map(c=>c.record_id)).toEqual(['elsewhere']);
  expect(store.diagnosticsSettingsDirty).toBe(true); store.discardDiagnosticsSettings();
  expect(store.diagnosticsSettings).toEqual(saved); store.changeDiagnosticsScope('');
  expect(store.diagnosticsChannelOptions).toEqual([]); expect(store.diagnosticsSettings.channelId).toBe('');
  expect(store.selectedScopeId).toBe('navigation-scope'); expect(store.selectedChannelId).toBe('navigation-channel');
});

it.each(['deleted','archived','absent','foreign'])('blocks %s scope/channel defaults without replacement', kind => {
  store.applyDiagnosticsInfo({settings:saved});
  for (const collection of ['channels','scopes']) {
    const original = store[collection];
    store[collection] = kind === 'absent' ? [] : original.map((r,i)=>i ? r : {...r,...(kind==='foreign' ? {workspace_id:'foreign'} : {record_state:kind})});
    expect(store.diagnosticsDefaultError).toContain('Saved report destination is unavailable');
    expect(store.diagnosticsSavedSettings.channelId).toBe('bugs'); store[collection]=original;
  }
});

it('does not leak defaults between backend, actor or workspace contexts', async () => {
  const key = diagnosticsScope(store); await recorder.configure(key,saved);
  store.session={npub:'another'}; expect((await recorder.info(diagnosticsScope(store))).settings.channelId).toBe('');
  store.session={npub:'actor'}; store.currentWorkspace={workspaceId:'another'};
  expect((await recorder.info(diagnosticsScope(store))).settings.channelId).toBe('');
  store.currentWorkspace={workspaceId:'w'}; store.backendUrl='http://other';
  expect((await recorder.info(diagnosticsScope(store))).settings.channelId).toBe('');
  expect((await recorder.info(key)).settings).toEqual(saved);
});

it('cancels old queue and rejects its revision when saved scope changes', async () => {
  const key=diagnosticsScope(store); await recorder.configure(key,saved);
  await recorder.queue(key,{incidentId:'old'}); const incident=await recorder.next(key);
  await recorder.configure(key,{...saved,scopeId:'other'});
  expect((await recorder.info(key)).pending).toBe(0);
  await expect(recorder.patch(key,'old',incident.revision,{sent:true})).rejects.toThrow('changed');
});

it('manual Send uses saved worker settings without configure and blocks unsaved/unavailable destinations', async () => {
  vi.stubGlobal('window',new EventTarget()); vi.stubGlobal('navigator',{});
  vi.spyOn(globalThis,'setInterval').mockReturnValue(1);
  const call=vi.spyOn(DiagnosticsWorkerClient.prototype,'call').mockImplementation((method,key,...args)=>recorder[method](key,...args));
  const key=diagnosticsScope(store); await recorder.configure(key,{...saved,enabled:false});
  await store.openDiagnosticsDialog(); store.retryDiagnosticsReports=vi.fn();
  store.diagnosticsDescription='Expected drawing'; await store.queueManualDiagnosticReport();
  expect((await recorder.next(key)).channelId).toBe('bugs');
  expect(call.mock.calls.filter(([method])=>method==='configure')).toHaveLength(0);
  store.diagnosticsDescription='Another report'; store.changeDiagnosticsScope('other');
  await store.queueManualDiagnosticReport(); expect(store.diagnosticsError).toContain('unsaved');
  store.discardDiagnosticsSettings(); store.channels=[];
  await store.queueManualDiagnosticReport(); expect(store.diagnosticsError).toContain('unavailable');
  expect((await recorder.info(key)).pending).toBe(1);
});

it('allows capture opt-out even when the unchanged saved destination becomes unavailable', async () => {
  vi.stubGlobal('window',new EventTarget()); vi.stubGlobal('navigator',{});
  vi.spyOn(globalThis,'setInterval').mockReturnValue(1);
  vi.spyOn(DiagnosticsWorkerClient.prototype,'call').mockImplementation((method,key,...args)=>recorder[method](key,...args));
  // Avoid capture hooks in this unit test while still exercising lifecycle/save.
  await recorder.configure(diagnosticsScope(store),{...saved,enabled:false});
  await store.openDiagnosticsDialog();
  await recorder.configure(diagnosticsScope(store),saved);
  store.applyDiagnosticsInfo(await recorder.info(diagnosticsScope(store)));
  store.channels=[]; store.diagnosticsSettings.enabled=false;
  await store.saveDiagnosticsSettings();
  expect((await recorder.info(diagnosticsScope(store))).settings.enabled).toBe(false);
  expect((await recorder.info(diagnosticsScope(store))).settings.channelId).toBe('bugs');
});
