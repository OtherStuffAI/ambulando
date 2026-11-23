import { canonical, decodeJson, sha256, UUID } from './generic-protocol.js';
// Deliberate, additive migration: an app must declare compatibility with a whole
// legacy JSON snapshot. Original File and every File version remain untouched.
export async function reviewLegacySnapshot(context,fileId,files,signal) {
  if(!UUID.test(fileId))throw Error('Enter the legacy data File ID.');
  const options={baseUrl:context.baseUrl,appNpub:context.appNpub,signal};
  const file=(await files.getTowerPgFile(context.workspaceId,fileId,options)).file;
  if(file?.id!==fileId||file.workspace_id!==context.workspaceId||file.archived_at||file.deleted_at||!UUID.test(file.current_version_id))throw Error('Legacy File unavailable.');
  const channel=(await files.getTowerPgChannel(context.workspaceId,file.channel_id,options)).channel;
  if(channel?.workspace_id!==context.workspaceId||channel.id!==file.channel_id||channel.kind!=='dm'||channel.participant_npubs?.length!==1||channel.participant_npubs[0]!==context.viewer||channel.archived_at||channel.deleted_at)throw Error('Legacy data must belong to your private self conversation.');
  const history=await files.getTowerPgFileVersions(context.workspaceId,fileId,options),v=history.versions?.find(v=>v.id===file.current_version_id);
  if(!v||v.file_id!==fileId||v.content_type!=='application/json'||!Number.isSafeInteger(v.size_bytes)||v.size_bytes>262144||v.size_bytes<2||!/^[a-f0-9]{64}$/.test(v.sha256_hex))throw Error('Legacy snapshot is not a compatible JSON record (maximum 256 KiB).');
  const object=await files.getTowerPgFileVersionObjectBytes(context.workspaceId,fileId,v.id,options);
  if(object.contentType!=='application/json'||object.bytes.byteLength!==v.size_bytes||await sha256(object.bytes)!==v.sha256_hex)throw Error('Legacy snapshot integrity check failed.');
  const data=decodeJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(object.bytes));
  if(new TextEncoder().encode(canonical(data)).length>262144)throw Error('Legacy snapshot exceeds the collection record limit.');
  return {source:{file_id:fileId,file_version_id:v.id,sha256_hex:v.sha256_hex},displayName:file.display_name,data};
}
export function legacySnapshotMigration(collection,manifest,viewer,snapshot) {
  const d=manifest.collections[collection.name];
  if(collection.scope!=='personal'||collection.owner_npub!==viewer||!d||d.scope!=='personal'||d.schema_version!==collection.schema_version)throw Error('Import requires your own compatible personal collection.');
  return {expected_revision:collection.revision,from_schema_version:collection.schema_version,to_schema_version:collection.schema_version,compatible:true,source:snapshot.source,records:[{id:'legacy-snapshot',data:snapshot.data}]};
}
