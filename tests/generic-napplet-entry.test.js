import {it,expect} from 'vitest';
import {loadGenericCode} from '../src/napplets/generic-reads.js';
import {genericAppsMixin} from '../src/napplets/generic-apps.js';
import {sha256} from '../src/napplets/generic-protocol.js';
import vectors from './fixtures/napplets/generic-v2.json';
const versionId='22222222-2222-4222-8222-222222222222';
it('generic entry never downgrades missing, duplicate or unbound manifests to ordinary HTML',async()=>{
 const script=`<script id="wingman-napplet-manifest">${JSON.stringify(vectors.manifest)}</script>`;
 for(const [html,metadata]of [['<p>ordinary</p>',{}],[script+script,{}],[script,{}],[script+script,vectors.metadata]]){
  const bytes=new TextEncoder().encode(html),transport={getTowerPgFile:async()=>({file:{id:vectors.codeFileId,workspace_id:vectors.context.workspaceId,current_version_id:versionId,metadata}}),getTowerPgFileVersions:async()=>({versions:[{id:versionId,file_id:vectors.codeFileId,content_type:'text/html',size_bytes:bytes.length,sha256_hex:await sha256(bytes)}]}),getTowerPgFileVersionObjectBytes:async()=>({bytes})};
  await expect(loadGenericCode(vectors.context,vectors.codeFileId,transport)).rejects.toThrow();
 }
});
it('stable generic route always requests generic app mode',async()=>{let args;await genericAppsMixin.openGenericNapplet.call({openArtefact:async(...a)=>{args=a;}},vectors.codeFileId);expect(args[1]).toEqual({appMode:true,generic:true});});
