(() => {
  'use strict';
  const ranges = ['7d', '30d', '90d', 'all'];
  const states = ['new', 'ready', 'in_progress', 'review', 'done', 'backlog', 'blocked', 'archive', 'archived'];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
  const fail = () => { throw new Error('A complete, valid workspace report is required.'); };
  const count = n => { if (!Number.isSafeInteger(n) || n < 0) fail(); return n; };
  const sum = values => count(values.reduce((a, b) => a + count(b), 0));
  const date = v => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail(); return Date.parse(v); };
  function validate(v) {
    if (!exact(v, ['format','workspace_id','range','from','to','as_of','timezone','complete','channel_policy','channels','activity','inventory','ranking','coverage']) || v.format !== 'workspace-report-v1' || !uuid.test(v.workspace_id) || !ranges.includes(v.range) || v.timezone !== 'UTC' || v.complete !== true || v.channel_policy !== 'active-project-channels') fail();
    const end = date(v.as_of); if (v.to !== v.as_of) fail();
    if (v.range === 'all' ? v.from !== null : date(v.from) !== end - Number.parseInt(v.range,10)*86400000) fail();
    if (!Array.isArray(v.channels) || v.channels.length > 50) fail();
    const ids = new Set();
    for (const c of v.channels) {
      if (!exact(c,['channel_id','scope_id','name','scope_name','messages','conversations']) || !uuid.test(c.channel_id) || !uuid.test(c.scope_id) || ids.has(c.channel_id)) fail();
      ids.add(c.channel_id);
      for (const label of [c.name,c.scope_name]) if (typeof label !== 'string' || label.length > 300) fail();
      count(c.messages); count(c.conversations); if (c.conversations > c.messages) fail();
    }
    const r=v.ranking;
    if (!exact(r,['total_channels','returned_channels','has_more','other_messages','other_conversations']) || count(r.total_channels)>2000 || count(r.returned_channels)!==v.channels.length || r.returned_channels>r.total_channels || typeof r.has_more!=='boolean' || r.has_more!==(r.returned_channels<r.total_channels)) fail();
    if(r.has_more && r.returned_channels===0)fail();
    for(let i=1;i<v.channels.length;i++){const a=v.channels[i-1],b=v.channels[i];if(a.messages<b.messages || (a.messages===b.messages && a.channel_id>=b.channel_id))fail();}
    count(r.other_messages);count(r.other_conversations);
    if(r.other_conversations>r.other_messages || (!r.has_more && (r.other_messages!==0 || r.other_conversations!==0))) fail();
    if (!exact(v.activity,['messages','conversations']) || v.activity.messages !== sum([...v.channels.map(c=>c.messages),r.other_messages]) || v.activity.conversations !== sum([...v.channels.map(c=>c.conversations),r.other_conversations])) fail();
    if(!exact(v.coverage,['tasks_channels','documents_channels','files_channels']))fail();
    for(const n of Object.values(v.coverage))if(count(n)>r.total_channels)fail();
    const i = v.inventory, t = i?.tasks;
    if (!exact(i,['channels','conversations','tasks','documents','files']) || count(i.channels) !== r.total_channels || !exact(t,['total','open','completed','archived','by_state']) || !exact(t.by_state,states)) fail();
    count(i.conversations); count(i.documents); count(i.files);
    if (count(t.total) !== sum(Object.values(t.by_state)) || count(t.completed) !== t.by_state.done || count(t.archived) !== sum([t.by_state.archive,t.by_state.archived]) || count(t.open) !== t.total - t.completed - t.archived) fail();
    return JSON.parse(JSON.stringify(v));
  }
  // Administrative extension is opt-in; validate() remains the strict legacy contract.
  function validateWithStorage(value) {
    if(!value || !Object.hasOwn(value,'storage'))fail();
    const {storage,...base}=value;
    validate(base);
    const safeId=s=>typeof s==='string' && /^[a-z][a-z0-9_-]{0,63}$/.test(s);
    if (!exact(storage,['format','workspace_id','scope','as_of','activity_range_applies','groups','provider_measured_at','last_object_completed_at','caveats']) || storage.format!=='workspace-storage-v1' || storage.workspace_id!==base.workspace_id || storage.scope!=='current-workspace' || storage.as_of!==base.as_of || storage.activity_range_applies!==false) fail();
    for (const stamp of [storage.provider_measured_at,storage.last_object_completed_at]) if(stamp!==null && date(stamp)>date(base.as_of)) fail();
    if(!Array.isArray(storage.groups)||storage.groups.length>8)fail();
    const groups=new Set();
    for(const g of storage.groups){
      if(!exact(g,['id','metrics'])||!safeId(g.id)||groups.has(g.id)||!Array.isArray(g.metrics)||g.metrics.length>32)fail();
      groups.add(g.id);const ids=new Set();
      for(const m of g.metrics){
        if(!exact(m,['id','value','unit','method','status'])||!safeId(m.id)||ids.has(m.id)||!safeId(m.method)||!['bytes','count'].includes(m.unit)||!['estimated','actual','unavailable'].includes(m.status))fail();
        ids.add(m.id);
        if(m.status==='unavailable'){if(m.value!==null)fail();}else{count(m.value);if(Object.is(m.value,-0))fail();}
      }
    }
    if(!Array.isArray(storage.caveats)||storage.caveats.length>16||storage.caveats.some(s=>typeof s!=='string'||s.length>1024||/[\p{Cc}\p{Cs}]/u.test(s)))fail();
    const result=JSON.stringify(value);if(new TextEncoder().encode(result).length>65536)fail();
    return JSON.parse(result);
  }
  function ranking(value) { return [...value.channels].sort((a,b)=>b.messages-a.messages || (a.channel_id < b.channel_id ? -1 : a.channel_id > b.channel_id ? 1 : 0)); }
  globalThis.WorkspaceReportModel = Object.freeze({ validate, validateWithStorage, ranking, ranges, states });
})();
