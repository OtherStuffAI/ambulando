// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { orgDataMixin } from '../src/org-data/manager.js';
import { openWorkspaceDb, getWorkspaceDb } from '../src/db.js';
let store;
afterEach(async()=>{store?.closeOrgData(true);vi.useRealTimers();await getWorkspaceDb().delete();document.body.replaceChildren()});
async function host(load) {
 await openWorkspaceDb('org-host-'+crypto.randomUUID()).open();
 document.body.innerHTML='<dialog id="org-data-modal"><button data-napplet-close></button><iframe></iframe></dialog>';
 const dialog=document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true};dialog.close=()=>{dialog.open=false};
 const s={session:{npub:'reader'},workspaceDbKey:'db',selectedBoardId:'scope',currentWorkspace:{workspaceId:'workspace',workspaceOwnerNpub:'owner',directHttpsUrl:'http://localhost:3100',appNpub:'app',towerServiceNpub:'tower',workspaceServiceNpub:'service'},getTowerSyncService:()=>({ensureLoaded:load})};
 Object.defineProperties(s,Object.getOwnPropertyDescriptors(orgDataMixin));store=s;await s.openOrgData({view:'people'});return s;
}
it('completed reads with no matching persisted hydration surface an error and destroy the loading frame',async()=>{
 const s=await host(async()=>({complete:true}));await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('error'));
 expect(s.orgDataHostError).toBe('Organisation data was not loaded. Refresh to retry.');expect(s.orgDataSrc).toBe('about:blank');
});
it('stalled hydration has an explicit timeout/retry boundary and cancels the read',async()=>{
 let signal;const s=await host((_family,_id,options)=>{signal=options.signal;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))});
 vi.useFakeTimers(); // Timer was installed by refresh before switching clocks; retry installs it on this clock.
 s.refreshOrgData();await vi.advanceTimersByTimeAsync(45001);
 expect(s.orgDataHostStatus).toBe('error');expect(s.orgDataHostError).toContain('timed out');expect(signal.aborted).toBe(true);
});
