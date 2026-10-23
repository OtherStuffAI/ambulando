// Test-only local Tower host. Production requests are never intercepted.
import { resolve } from 'node:path';
const checkout=process.env.TOWER_TEST_CHECKOUT;
const port=Number(process.env.RECORD_TEST_PORT);
if(!checkout || !port || port===5432)throw new Error('Disposable Tower checkout and non-production PostgreSQL port required');
const {default:postgres}=await import(resolve(checkout,'node_modules/postgres/src/index.js'));
const {setDb}=await import(resolve(checkout,'src/db.ts'));
const {createApp}=await import(resolve(checkout,'src/server.ts'));
const {splitSqlStatements}=await import(resolve(checkout,'src/schema/sql-statements.ts'));
const db=postgres({host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}});
for(const s of splitSqlStatements(await Bun.file(resolve(checkout,'src/schema/001_init.sql')).text()))await db.unsafe(s);
setDb(db);const app=createApp();
const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
 if(new URL(req.url).pathname==='/test/bootstrap'){
 const {npub}=await req.json();const [actor]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`;
 const [workspace]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('npub1canvastower',${'npub1canvasworkspace'+crypto.randomUUID()},${npub},'npub1canvasapp','Roundtrip') RETURNING *`;
 await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace.id},${actor.id},'owner')`;
 const scopes=[],channels=[];for(const name of ['Alpha','Beta']){const [s]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspace.id},${name},'project') RETURNING *`;scopes.push(s);const [c]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace.id},${s.id},${name+' channel'}) RETURNING *`;channels.push(c);for(const permission of ['channel.read','task.read','task.create','task.update'])await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace.id},'actor',${actor.id},'channel',${c.id},${permission})`;await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${workspace.id},'actor',${actor.id},'scope',${s.id},'scope.read')`;}
 const [canvas]=await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${workspace.id},'Roundtrip',1,${actor.id},${actor.id}) RETURNING *`;
 return Response.json({workspace,actor,scopes,channels,canvas},{headers:{'access-control-allow-origin':'*'}});
 }
 return app.fetch(req);
}});console.log('READY '+JSON.stringify({url:String(server.url)}));
