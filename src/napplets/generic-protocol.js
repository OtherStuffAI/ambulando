// Portable v2 contract. v1 adapters deliberately do not use these parsers.
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
const fail = () => { throw Error('Invalid generic napplet contract.'); };
const scalar = s => typeof s === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
const controls = s => Array.from(s).some(c => c.codePointAt(0)<32 || c.codePointAt(0)>=127 && c.codePointAt(0)<=159);
const utf8 = s => new TextEncoder().encode(s).length;
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function canonical(value) {
  const compare = (a,b) => {const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const d=x[i].codePointAt(0)-y[i].codePointAt(0);if(d)return d;}return x.length-y.length;};
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort(compare).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export async function sha256(value) { const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join(''); }
export function validateJson(value) {
  let nodes=0;
  const visit=(v,depth)=>{
    if(++nodes>50000||depth>32)fail();
    if(v===null||typeof v==='boolean')return;
    if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0)||Math.abs(v)>Number.MAX_SAFE_INTEGER)fail();return;}
    if(typeof v==='string'){if(!scalar(v)||utf8(v)>65536)fail();return;}
    if(!v||typeof v!=='object'||(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null))fail();
    if(Array.isArray(v)){
      // Structured-clone can carry sparse/extended arrays that JSON cannot.
      // Bound length before key enumeration or canonical serialization.
      if(v.length>50000)fail();
      const keys=Object.keys(v);
      if(keys.length!==v.length||keys.some((key,index)=>key!==String(index)))fail();
    }
    for(const k of Object.keys(v)){if(unsafe.has(k)||!scalar(k)||utf8(k)>65536)fail();visit(v[k],depth+1);}
  };
  if(!value||typeof value!=='object'||Array.isArray(value))fail();visit(value,1);
  if(utf8(canonical(value))>1048576)fail();return value;
}
// Token scan rejects duplicate keys before JSON.parse loses that information.
export function decodeJson(source) {
  if(typeof source!=='string'||utf8(source)>1048576||source.charCodeAt(0)===0xfeff)fail();
  let i=0;const ws=()=>{while(/[\x20\t\r\n]/.test(source[i]||'!'))i++;};
  const str=()=>{const start=i++;while(i<source.length){if(source[i]==='\\'){i+=2;continue;}if(source[i++]==='"')return JSON.parse(source.slice(start,i));}fail();};
  let count=0;
  const scan=(depth)=>{if(depth>32||++count>50000)fail();ws();const c=source[i];
    if(c==='{'||c==='['){i++;ws();const end=c==='{'?'}':']',keys=new Set();if(source[i]===end){i++;return;}while(i<source.length){if(c==='{'){if(source[i]!=='"')fail();const key=str();if(keys.has(key))fail();keys.add(key);ws();if(source[i++]!==':')fail();}scan(depth+1);ws();if(source[i]===end){i++;return;}if(source[i++]!==',')fail();ws();}fail();}
    if(c==='"'){str();return;}const m=source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);if(!m)fail();i+=m[0].length;
  };scan(1);ws();if(i!==source.length)fail();return validateJson(JSON.parse(source));
}
export const capabilities = Object.freeze({
  'private-json-file@1': Object.freeze({operations:['read','save'],resource:'file_id',privacy:'self-channel'}),
  'workspace-aggregate@1': Object.freeze({operations:['read'],resource:'workspace_id',privacy:'viewer-channels'}),
});
export function parseGenericNapplet(html,metadata) {
  const matches=[...String(html).matchAll(/<script\b[^>]*[\t\n\f\r ]id\s*=\s*["']wingman-napplet-manifest["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  let m;try{m=matches.length===1?decodeJson(matches[0][1]):null;}catch{fail();}
  const n=metadata?.napplet;
  if(m?.version!==2&&n?.version!==2)return null;
  if(matches.length!==1||!exact(m,['version','app_id','title','icon','bindings'])||m.version!==2||typeof m.app_id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(m.app_id)||!scalar(m.title)||Array.from(m.title).length<1||Array.from(m.title).length>80||controls(m.title)||!scalar(m.icon)||Array.from(m.icon).length<1||Array.from(m.icon).length>8||(controls(m.icon)||/[<>:/\\]/u.test(m.icon)))fail();
  const names=Object.keys(m.bindings||{}),name=names[0],b=m.bindings?.[name];
  if(names.length!==1||!/^[a-z][a-z0-9_]{0,31}$/.test(name)||!exact(b,['capability','version','operations']))fail();
  const spec=capabilities[`${b.capability}@${b.version}`];
  if(typeof b.capability!=='string'||!spec||b.version!==1||!(JSON.stringify(b.operations)===JSON.stringify(spec.operations)||b.capability==='private-json-file'&&JSON.stringify(b.operations)==='["read"]'))fail();
  if(!exact(n,['version','app_id','bindings'])||n.version!==2||n.app_id!==m.app_id||!exact(n.bindings,[name])||!exact(n.bindings[name],[spec.resource])||!UUID.test(n.bindings[name][spec.resource]))fail();
  return Object.freeze({manifest:JSON.parse(canonical(m)),resources:JSON.parse(canonical(n.bindings)),name,capability:b.capability,version:b.version,appId:m.app_id,title:m.title,icon:m.icon,fileId:n.bindings[name].file_id,workspaceId:n.bindings[name].workspace_id});
}
export function validGenericRequest(event,frame,session,binding) {
  const d=event?.data,common=['type','version','session','requestId','operation'];
  if(!frame||event.source!==frame||event.origin!=='null'||d?.type!=='wingman-napplet-data'||d.version!==2||d.session!==session||!/^[a-f0-9]{32}$/.test(session)||typeof d.requestId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(d.requestId))return false;
  if(d.operation==='dirty')return exact(d,[...common,'dirty'])&&typeof d.dirty==='boolean';
  if(d.binding!==binding.name)return false;
  if(binding.capability==='workspace-aggregate')return exact(d,[...common,'binding','range'])&&d.operation==='read'&&['7d','30d','90d','all'].includes(d.range);
  if(d.operation==='read')return exact(d,[...common,'binding']);
  if(!binding.manifest.bindings[binding.name].operations.includes('save')||d.operation!=='save'||!exact(d,[...common,'binding','baseVersionId','value'])||!UUID.test(d.baseVersionId))return false;
  try{validateJson(d.value);return true;}catch{return false;}
}
export async function genericReceipt(context,codeFileId,digest,binding,canWrite) {
  if([context.baseUrl,context.appNpub,context.workspaceId,context.viewer,codeFileId].some(v=>typeof v!=='string'||!v)||!UUID.test(codeFileId)||!/^[a-f0-9]{64}$/.test(digest)||typeof canWrite!=='boolean')fail();
  const url=new URL(context.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail();
  canWrite = canWrite && binding.manifest.bindings[binding.name].operations.includes('save');
  const identity=[url.href.replace(/\/$/,''),context.tower||'',context.service||'',context.appNpub,context.workspaceId,context.viewer];
  return {version:2,key:'napplet-approval-v2:'+await sha256(canonical([...identity,codeFileId])),fingerprint:await sha256(canonical({version:2,identity,codeFileId,digest,manifest:binding.manifest,resources:binding.resources,canWrite}))};
}
