import { describe,it,expect } from 'vitest';
import { validateRuntimeManifest,parseRuntimeManifest,runtimeAccess,accessExpansion,runtimeSupport,validRuntimeRequest } from '../src/napplets/runtime-protocol.js';
const manifest=()=>({version:3,napplet_id:'arbitrary-cartridge',bundle_version:'1',title:'A new app',icon:'🌱',runtime:{protocol:3,min_host:3},collections:{entries:{scope:'personal',schema_version:1,operations:['list','get','create','update','delete']}},capabilities:{}});
describe('common cartridge protocol',()=>{
 it('loads an arbitrary manifest and rejects duplicate keys, ambient authority and future hosts',()=>{
  const m=manifest();expect(parseRuntimeManifest(`<script id="wingman-napplet-manifest">${JSON.stringify(m)}</script>`)).toEqual(m);
  expect(()=>validateRuntimeManifest({...m,signer:true})).toThrow();
  expect(()=>parseRuntimeManifest('<script id="wingman-napplet-manifest">{"version":3,"version":3}</script>')).toThrow();
  m.runtime.min_host=4;expect(runtimeSupport(m)).toMatch(/newer host/);
 });
 it('does not request re-consent for code/name/version changes or narrower access',()=>{
  const a=manifest(),b=manifest();b.title='Renamed';b.bundle_version='2';b.collections.entries.operations=['list'];
  expect(accessExpansion(runtimeAccess(a),runtimeAccess(b))).toEqual([]);
 });
 it('requires review for broader resources, scopes, schema and separate personal grants',()=>{
  const a=runtimeAccess(manifest()),b=manifest();b.collections.entries.scope='team';expect(accessExpansion(a,runtimeAccess(b))).toEqual(['collection:entries']);
  b.collections.entries.scope='personal';b.collections.entries.schema_version=2;expect(accessExpansion(a,runtimeAccess(b))).toEqual(['collection:entries']);
  b.capabilities={'nostr-dm':{version:1,resources:['wss://relay.example'],operations:['read','decrypt']}};
  expect(runtimeSupport(b)).toMatch(/does not support/);const approved=runtimeAccess(b);b.capabilities['nostr-dm'].operations.push('send');expect(accessExpansion(approved,runtimeAccess(b))).toContain('capability:nostr-dm');
 });
 it('bounds pagination, enforces CAS and rejects namespace overrides and forged frames',()=>{
  const frame={},session='a'.repeat(32),m=manifest();const request={type:'wingman-napplet-data',version:3,session,requestId:'r1',operation:'list',collection:'entries',limit:100,cursor:null};
  const valid=d=>validRuntimeRequest({source:frame,origin:'null',data:d},frame,session,m);
  expect(valid(request)).toBe(true);expect(valid({...request,limit:101})).toBe(false);expect(valid({...request,workspace_id:'elsewhere'})).toBe(false);
  const update={type:request.type,version:3,session,requestId:'u1',operation:'update',collection:'entries',record_id:'entry-1',base_revision:1,value:{answered:false,zero:0}};
  expect(valid(update)).toBe(true);expect(valid({...update,base_revision:0})).toBe(false);expect(valid({...update,value:JSON.parse('{"__proto__":{}}')})).toBe(false);
  expect(validRuntimeRequest({source:{},origin:'null',data:request},frame,session,m)).toBe(false);
 });
});
