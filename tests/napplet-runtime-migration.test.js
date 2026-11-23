import {it,expect,vi} from 'vitest';
import {reviewLegacySnapshot,legacySnapshotMigration} from '../src/napplets/runtime-migration.js';
import {publishNapplet,installationForReinstall} from '../src/napplets/runtime-publisher.js';
import {sha256} from '../src/napplets/generic-protocol.js';
import manifest from './fixtures/napplet-runtime-v3/manifest.json';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
it('imports a verified private File snapshot additively, retaining false/zero/history references',async()=>{
 const data={days:{'2026-01-01':{done:false,count:0}},history:[{date:'2025-12-31',value:null}]},bytes=new TextEncoder().encode(JSON.stringify(data)),digest=await sha256(bytes),context={workspaceId:id(1),viewer:'alice'};
 const files={getTowerPgFile:vi.fn(async()=>({file:{id:id(2),workspace_id:id(1),channel_id:id(3),current_version_id:id(4)}})),getTowerPgChannel:vi.fn(async()=>({channel:{id:id(3),workspace_id:id(1),kind:'dm',participant_npubs:['alice']}})),getTowerPgFileVersions:vi.fn(async()=>({versions:[{id:id(4),file_id:id(2),content_type:'application/json',size_bytes:bytes.length,sha256_hex:digest}]})),getTowerPgFileVersionObjectBytes:vi.fn(async()=>({bytes,contentType:'application/json'}))};
 const snapshot=await reviewLegacySnapshot(context,id(2),files);expect(snapshot.data).toEqual(data);
 const collection={name:'entries',scope:'personal',owner_npub:'alice',schema_version:1,revision:1};const body=legacySnapshotMigration(collection,manifest,'alice',snapshot);expect(body.records).toEqual([{id:'legacy-snapshot',data}]);expect(body.source).toEqual({file_id:id(2),file_version_id:id(4),sha256_hex:digest});expect(body.compatible).toBe(true);
 expect(()=>legacySnapshotMigration({...collection,scope:'team'},manifest,'alice',snapshot)).toThrow();expect(()=>legacySnapshotMigration(collection,manifest,'bob',snapshot)).toThrow();
 files.getTowerPgChannel.mockResolvedValue({channel:{id:id(3),workspace_id:id(1),kind:'project'}});await expect(reviewLegacySnapshot(context,id(2),files)).rejects.toThrow('private self');
});
it('uses actual agreed requester-private install and publisher release routes with no host code dependencies',async()=>{
 const html='<script id="wingman-napplet-manifest">'+JSON.stringify(manifest)+'</script>',bundle={file_id:id(2),file_version_id:id(3),sha256_hex:await sha256(html)},request=vi.fn(async()=>({installation:{}}));
 await publishNapplet({request,html,bundle,requesterNpub:'alice',publisherNpub:'bot',delegationId:'delegation'});
 expect(request).toHaveBeenCalledWith('field-notes',{method:'PUT',body:{expected_revision:0,requester_npub:'alice',publisher_npub:'bot',display_name:'Field Notes',bundle,manifest,delegation_id:'delegation'}});
 await publishNapplet({request,html,bundle,expectedRevision:3,update:true});expect(request).toHaveBeenLastCalledWith('field-notes/releases',{method:'POST',body:{expected_revision:3,bundle,manifest}});
 await expect(publishNapplet({request,html:html+'bad',bundle,requesterNpub:'alice',publisherNpub:'bot'})).rejects.toThrow('matching HTML');expect(request).toHaveBeenCalledTimes(2);
});

it('reinstalls the same namespace with server revision and never creates a second active install',()=>{
 const c={workspaceId:id(1),appNpub:'app',nappletId:'notes',requesterNpub:'alice',publisherNpub:'bot'},row={workspace_id:id(1),app_npub:'app',napplet_id:'notes',owner_npub:'alice',publisher_npub:'bot',removed:true,revision:7};
 expect(installationForReinstall(null,c)).toEqual({expectedRevision:0,alreadyInstalled:false});expect(installationForReinstall(row,c)).toEqual({expectedRevision:7,alreadyInstalled:false});expect(installationForReinstall({...row,removed:false},c)).toEqual({expectedRevision:7,alreadyInstalled:true});expect(()=>installationForReinstall({...row,publisher_npub:'other'},c)).toThrow('rebound');
});
