import {it,expect} from 'vitest';
import manifest from './fixtures/napplet-runtime-v3/manifest.json';
import {runtimeApprovalKey,approveRuntime,readRuntimeApproval,runtimeNeedsApproval,revokeRuntimeApproval} from '../src/napplets/runtime-consent.js';
const context={baseUrl:'https://example.test',tower:'tower',service:'service',workspaceId:'workspace',appNpub:'app',viewer:'alice'};
it('partitions approvals by identity, workspace, app, backend and service',async()=>{
 const key=await runtimeApprovalKey(context,manifest.napplet_id);
 for(const field of Object.keys(context))expect(await runtimeApprovalKey({...context,[field]:field==='baseUrl'?'https://elsewhere.test':'different'},manifest.napplet_id)).not.toBe(key);
});
it('automatic code updates preserve access grants; expansions, publisher changes and revocation require consent',async()=>{
 const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)},key=await runtimeApprovalKey(context,manifest.napplet_id);
 expect(approveRuntime(key,'publisher',manifest,{file_id:'f',version_id:'v',sha256:'digest'},storage)).toBe(true);
 const a=readRuntimeApproval(key,storage),next=structuredClone(manifest);next.bundle_version='2';next.title='New title';expect(runtimeNeedsApproval(a,'publisher',next)).toBe(false);
 next.collections.team_notes.operations.push('create');expect(runtimeNeedsApproval(a,'publisher',next)).toBe(true);
 expect(runtimeNeedsApproval(a,'other-publisher',manifest)).toBe(true);
 expect(revokeRuntimeApproval(key,storage)).toBe(true);expect(readRuntimeApproval(key,storage)).toBeNull();
});
