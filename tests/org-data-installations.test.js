// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceDb, getWorkspaceDb, closeWorkspaceDb } from '../src/db.js';
import { orgDataMixin } from '../src/org-data/manager.js';
import { orgDataContext, orgDataPartition, orgDataInstallationsPartition } from '../src/org-data/projection.js';
let store;
beforeEach(async () => { await openWorkspaceDb('installs-' + crypto.randomUUID()).open(); });
afterEach(async () => { store?.closeOrgData(true); store?.disposeOrgDataInstallations(); document.body.replaceChildren(); try { await getWorkspaceDb().delete(); } catch { /* unopened activation */ } });
function setup(load) {
  const s = { session: { npub: 'reader' }, workspaceDbKey: 'db', currentWorkspace: { workspaceId: 'workspace', workspaceOwnerNpub: 'owner', directHttpsUrl: 'http://localhost:3100', appNpub: 'app' }, getTowerSyncService: () => ({ ensureLoaded: load }) };
  Object.defineProperties(s, Object.getOwnPropertyDescriptors(orgDataMixin)); store = s; return s;
}
async function persist(s, requestId, version = 5) {
  await getWorkspaceDb().org_data.put({ key: orgDataInstallationsPartition(orgDataContext(s)), request_id: requestId, installations: [{ key: 'register', title: 'Project Register', version, html: 'private' }] });
}
it('discovers before any modal, coalesces navigation and observes republished installs without exposing HTML', async () => {
  const load = vi.fn(async (_family, _key, { requestId }) => persist(s, requestId)); const s = setup(load);
  await Promise.all([s.loadOrgDataInstallations(), s.loadOrgDataInstallations()]);
  expect(s.orgDataOpen).toBe(false); expect(load).toHaveBeenCalledTimes(1);
  expect(s.orgDataInstallations).toEqual([{ key: 'register', title: 'Project Register', version: 5 }]);
  await s.loadOrgDataInstallations(); expect(load).toHaveBeenCalledTimes(1);
  await persist(s, 'modal-refresh', 6);
  await vi.waitFor(() => expect(s.orgDataInstallations[0]?.version).toBe(6));
  s.closeOrgData(true); expect(s.orgDataInstallations).toHaveLength(1);
});
it('never trusts persisted cache before authorization and clears denial or missing projections', async () => {
  let denied = false;
  const s = setup(async (_family, _key, { requestId }) => { if (denied) throw { status: 403 }; await persist(s, requestId); });
  await persist(s, 'cached'); expect(s.orgDataInstallations).toEqual([]);
  await s.loadOrgDataInstallations(); expect(s.orgDataInstallations).toHaveLength(1);
  denied = true; await s.loadOrgDataInstallations({ force: true }); expect(s.orgDataInstallations).toEqual([]); expect(s.orgDataInstallationContext).toBe('');
  denied = false; await s.loadOrgDataInstallations({ force: true });
  await getWorkspaceDb().org_data.delete(orgDataInstallationsPartition(orgDataContext(s)));
  await vi.waitFor(() => expect(s.orgDataInstallations).toEqual([]));
});
it.each(['workspace', 'signer', 'backend'])('rejects a late %s context result and cancels the old subscriber', async kind => {
  let finish; const s = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = s.loadOrgDataInstallations(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  if (kind === 'workspace') s.currentWorkspace = { ...s.currentWorkspace, workspaceId: 'other' };
  if (kind === 'signer') s.signingNpub = 'other';
  if (kind === 'backend') s.currentWorkspace = { ...s.currentWorkspace, directHttpsUrl: 'http://localhost:3101' };
  finish(); await pending; expect(s.orgDataInstallations).toEqual([]);
  s.disposeOrgDataInstallations(); expect(s.orgDataInstallationContext).toBe('');
});

it('waits for the workspace database to open during sign-in and then discovers on activation', async () => {
 const load=vi.fn(async (_family,_key,{requestId})=>persist(s,requestId));const s=setup(load);
 await getWorkspaceDb().delete();closeWorkspaceDb();
 await expect(s.loadOrgDataInstallations()).resolves.toBeUndefined();expect(load).not.toHaveBeenCalled();
 await openWorkspaceDb('activated-'+crypto.randomUUID()).open();
 await s.loadOrgDataInstallations();expect(s.orgDataInstallations).toHaveLength(1);
});

function modal() {
 document.body.innerHTML='<dialog id="org-data-modal"><button data-napplet-close></button><iframe></iframe></dialog>';
 const dialog=document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true};dialog.close=()=>{dialog.open=false};
}
async function snapshot(s,requestId) {
 const metadata=await getWorkspaceDb().org_data.get(orgDataInstallationsPartition(orgDataContext(s)));
 await getWorkspaceDb().org_data.put({key:orgDataPartition(orgDataContext(s)),request_id:requestId,types:[],records:{},capabilities:{},identities:{},installations:metadata?.installations||[]});
}
it('launch waits for pending discovery and the open modal exclusively owns SSE reauthorization', async () => {
 modal();let release;const load=vi.fn(async (family,_key,{requestId})=>{
  if(family==='org-data-installations'){await new Promise(r=>release=r);await persist(s,requestId);}
  else await snapshot(s,requestId);
 });const s=setup(load);const discovery=s.loadOrgDataInstallations();
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));const launch=s.openOrgData();
 expect(load).toHaveBeenCalledTimes(1);release();await discovery;await launch;
 await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));
 await s.loadOrgDataInstallations({force:true});expect(load).toHaveBeenCalledTimes(2);
 await s.syncOrgData();await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));
 expect(load.mock.calls.map(c=>c[0])).toEqual(['org-data-installations','org-data','org-data']);
 s.closeOrgData(true);expect(s.orgDataInstallations).toHaveLength(1);
});
it('modal read denial revokes discovery authority even if a retained metadata row emits again', async () => {
 modal();let denied=false;const load=vi.fn(async (family,_key,{requestId})=>{
  if(denied)throw {status:403};
  if(family==='org-data-installations')await persist(s,requestId);else await snapshot(s,requestId);
 });const s=setup(load);await s.loadOrgDataInstallations();await s.openOrgData();
 await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));denied=true;await s.syncOrgData();
 expect(s.orgDataHostStatus).toBe('error');expect(s.orgDataInstallations).toEqual([]);
 await persist(s,'retained-cache');await new Promise(r=>setTimeout(r,100));
 expect(s.orgDataInstallations).toEqual([]);expect(s.orgDataInstallationContext).toBe('');
});
