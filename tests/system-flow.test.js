import { expect, it } from 'vitest';
import { readSystemFlow, updateFlowEntity, renderFlowSvg } from '../src/system-flow.js';
import { ARTEFACT_TEMPLATES, templateSource, templateDescriptor } from '../src/artefact-templates.js';
import { artefactType } from '../src/artefact-registry.js';
it('creates controlled templates and rejects unapproved extensions', () => {
  for (const t of ARTEFACT_TEMPLATES) expect(templateSource(t.type,t.id,'paper','Test')).toBeDefined();
  expect(() => templateDescriptor('html','https://unapproved/template')).toThrow();
  expect(() => templateSource('html','explorer','remote')).toThrow();
  expect(templateSource('html','explorer','paper','<script>')).toContain('&lt;script&gt;');
});
it('retains typed relationships, owners and parent coordinates through edits', () => {
  const flow = templateSource('system-flow','system');
  flow.nodes[0].data.owner = 'Owner';
  const before = JSON.stringify(flow);
  const edited = updateFlowEntity(flow,'root','nodes','start',{data:{label:'Begin'},position:{x:32}});
  const linked = updateFlowEntity(edited,'root','edges','start-action',{label:'Proceed',target:'start'});
  expect(JSON.stringify(flow)).toBe(before);
  expect(readSystemFlow(JSON.stringify(linked))).toEqual(linked);
  expect(linked.nodes[0].data.owner).toBe('Owner');
  expect(linked.edges[0]).toMatchObject({id:'start-action',source:'start',target:'start',relationship:'flow',label:'Proceed'});
  expect(() => updateFlowEntity(flow,'root','edges','start-action',{target:'missing'})).toThrow();
});
it('keeps nested diagrams and embedded scenes while rejecting incomplete collections', () => {
  const sample = templateSource('system-flow','system');
  const scene = {elements:[],appState:{},files:{}};
  const flow = {schemaVersion:3,title:'Collection',rootDiagramId:'main',diagrams:[{id:'main',title:'Main',nodes:sample.nodes,edges:sample.edges}],whiteboards:[{id:'board',title:'Board',sceneId:'scene'}],scenes:{scene}};
  const next=updateFlowEntity(flow,'main','nodes','start',{data:{description:'More detail'}});
  expect(next.scenes).toEqual(flow.scenes);
  expect(next.whiteboards).toEqual(flow.whiteboards);
  expect(() => readSystemFlow(JSON.stringify({...flow,scenes:undefined}))).toThrow('all scene data');
});
it('renders untrusted labels as SVG text and fails closed for unknown File descriptors', () => {
  const flow=templateSource('system-flow','system');flow.nodes[0].data.label='<script>alert(1)</script>';
  expect(renderFlowSvg(flow,'root')).not.toContain('<script>');
  expect(artefactType({pg_record_type:'file',content_type:'application/vnd.ambulando.system-flow+json',metadata:{artefact:templateDescriptor('system-flow','system')}})).toBe('system-flow');
  expect(artefactType({pg_record_type:'file',content_type:'application/json',title:'flow.json'})).toBe(null);
});

// Image hydration is a view adapter; immutable imported scene fields stay untouched.
it('hydrates only validated pending embedded board images on a view copy', async () => {
  const {boardEditorElements}=await import('../src/canvas/board-scene.js');
  const element={id:'image',type:'image',fileId:'picture',status:'pending'};
  const scene={elements:[element],files:{picture:{id:'picture',mimeType:'image/png',dataURL:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}}};
  const before=JSON.stringify(scene);expect(boardEditorElements(scene)[0].status).toBe('saved');expect(JSON.stringify(scene)).toBe(before);
  expect(boardEditorElements({...scene,files:{}})[0]).toBe(element);
  expect(boardEditorElements({...scene,files:{picture:{...scene.files.picture,dataURL:'data:image/png;base64,bad'}}})[0]).toBe(element);
});
