const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');
test('workspace manager without org data read grants and revokes narrow direct permissions with CAS',async({page})=>{
 const fixture=buildGroupsAccessFixture(),actor=fixture.people.find(p=>p.actor_id==='actor-editor-agent');
 const state={permissions:['napplet.install'],writes:[],conflict:false,deny:false};
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(!['localhost','127.0.0.1'].includes(url.hostname))return route.abort();
  if(url.pathname.endsWith('/org-data/permissions')){
   if(req.method()==='GET')return route.fulfill({json:{members:[{id:actor.actor_id,npub:actor.npub,display_name:'Editor Agent',kind:'agent',permissions:state.permissions}]}});
   state.writes.push(req.postDataJSON());if(state.conflict)return route.fulfill({status:409,json:{code:'revision_conflict'}});if(state.deny)return route.fulfill({status:403,json:{code:'self_permission_escalation'}});
   state.permissions=req.postDataJSON().permissions;return route.fulfill({json:{actor_id:actor.actor_id,permissions:state.permissions}});
  }
  return serveBuiltFlightDeck(route);
 });
 await page.goto('/',{waitUntil:'domcontentloaded'});await seedGroupsAccess(page,fixture);
 const panel=page.getByRole('region',{name:'Organisation data permissions'});
 await panel.getByRole('button',{name:'Reload permissions'}).click();
 await panel.getByLabel('org_data.read',{exact:true}).check();await panel.getByLabel('org_data.write',{exact:true}).check();await panel.getByLabel('org_data.schema',{exact:true}).check();
 await panel.getByRole('button',{name:'Save direct permissions'}).click();await expect(panel.getByText('Direct permissions saved. Group permissions still apply.')).toBeVisible();
 expect(state.writes[0]).toEqual({actor_id:actor.actor_id,expected_permissions:['napplet.install'],permissions:['napplet.install','org_data.read','org_data.write','org_data.schema']});
 await panel.getByLabel('org_data.write',{exact:true}).uncheck();await panel.getByRole('button',{name:'Save direct permissions'}).click();await expect.poll(()=>state.writes.length).toBe(2);expect(state.permissions).toEqual(['napplet.install','org_data.read','org_data.schema']);
 state.conflict=true;await panel.getByRole('button',{name:'Save direct permissions'}).click();await expect(panel.getByText('Permissions changed elsewhere. Reload permissions before saving again.')).toBeVisible();
 state.conflict=false;state.deny=true;await panel.getByRole('button',{name:'Save direct permissions'}).click();await expect(panel.getByRole('alert')).toContainText('self_permission_escalation');
});
