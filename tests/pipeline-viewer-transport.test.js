import {expect,it,vi} from 'vitest';
import {createAutopilotDiscoveryClient} from '../src/autopilot-connect-client.js';
import {createPipelineViewerClient} from '../src/pipeline-viewer-client.js';
import {viewerContext} from './fixtures/pipeline-viewer.js';
const verified={installationId:'installation',installationNpub:'signer',transportNpub:'peer',fipsEndpoint:'http://peer.fips:43101',httpsEndpoint:'https://public.invalid',apiVersion:1,healthPath:'/api/owners/owner/control-plane/v1/health',agentsPath:'/api/owners/owner/control-plane/v1/agents',pipelineViewerPath:'/api/owners/owner/control-plane/v1/pipeline-viewer',capabilities:['pipelines.viewer.read.v1']};
function setup(payload={version:1,serviceId:'installation',runs:[],nextCursor:null},status=200){
  const fetch=vi.fn(async()=>new Response(JSON.stringify(payload),{status}));const disconnect=vi.fn();
  const transport={version:2,connect:vi.fn(async args=>({version:2,...args,fetch,disconnect}))};const authHeader=vi.fn(async()=> 'Nostr synthetic');
  const connection=createAutopilotDiscoveryClient(verified,{transport,authHeader});return {connection,client:createPipelineViewerClient(connection,viewerContext),transport,fetch,authHeader,disconnect};
}
it('uses one immutable pinned handle and signs the exact viewer URL with abort/redirect policy',async()=>{
  const {client,connection,transport,fetch,authHeader,disconnect}=setup();const controller=new AbortController();
  await client.read('runs',{},controller.signal);await client.read('definitions',{},controller.signal);
  expect(transport.connect).toHaveBeenCalledTimes(1);expect(transport.connect).toHaveBeenCalledWith({endpoint:verified.fipsEndpoint,peerNpub:'peer',purpose:'autopilot'});
  const url=fetch.mock.calls[0][0];expect(url).toContain('http://peer.fips:43101/api/owners/owner/control-plane/v1/pipeline-viewer/runs?workspace_id=workspace');
  expect(authHeader).toHaveBeenCalledWith(url,'GET',null);expect(fetch.mock.calls[0][1]).toMatchObject({signal:controller.signal,redirect:'error',credentials:'omit'});
  await connection.disconnect();expect(disconnect).toHaveBeenCalledTimes(1);
});
it('fails closed on transport failure, mismatched service and denied responses',async()=>{
  const failed=setup();failed.fetch.mockRejectedValue(Error('mesh disconnected'));await expect(failed.client.read('runs')).rejects.toMatchObject({code:'connection_failed'});expect(failed.fetch).toHaveBeenCalledTimes(1);expect(failed.fetch.mock.calls[0][0]).not.toContain('public.invalid');
  const foreign=setup({version:1,serviceId:'foreign'});await expect(foreign.client.read('runs')).rejects.toMatchObject({code:'response_invalid'});
  const denied=setup({},403);await expect(denied.client.read('runs')).rejects.toMatchObject({status:403});
});
it('rejects old connections or unsigned viewer paths before fetching',async()=>{
  const authHeader=vi.fn();const transport={version:2,connect:vi.fn()};
  for(const packageValue of [{...verified,capabilities:[]},{...verified,pipelineViewerPath:'/api/foreign'}]){
    const connection=createAutopilotDiscoveryClient(packageValue,{transport,authHeader});await expect(createPipelineViewerClient(connection,viewerContext).read('runs')).rejects.toMatchObject({code:'capability_unavailable'});
  }
  expect(transport.connect).not.toHaveBeenCalled();expect(authHeader).not.toHaveBeenCalled();
});
it('revokes a handle that finishes connecting after its client was disconnected',async()=>{
  let release;const disconnect=vi.fn();const transport={version:2,connect:vi.fn(args=>new Promise(resolve=>{release=()=>resolve({version:2,...args,fetch:vi.fn(),disconnect});}))};
  const connection=createAutopilotDiscoveryClient(verified,{transport,authHeader:vi.fn()});const pending=connection.readPipelineViewer(viewerContext,'runs');await Promise.resolve();await connection.disconnect();release();
  await expect(pending).rejects.toMatchObject({code:'connection_failed'});expect(disconnect).toHaveBeenCalledTimes(1);
});
