(() => {
  'use strict';
  const model = globalThis.WorkspaceReportModel, session = window.nappletSession;
  const $ = id => document.getElementById(id), number = n => n.toLocaleString();
  function displayCount(el,n){el.textContent=n>=1000000?new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(n):number(n);el.title=number(n);el.setAttribute('aria-label',number(n));}
  let pending = '', lastRequest = '', timer, value = null, shown = 20;
  function clear(message) { value = null; $('report').hidden = true; $('ranking').replaceChildren(); $('states').replaceChildren(); for(const id of ['messages','conversations','channels','open','completed','tasks','documents','files','archived','current-conversations','coverage','period','freshness','shown']) $(id).textContent=''; $('status').textContent = message; }
  function busy(on) { $('range').disabled = on; $('refresh').disabled = on; }
  function read() {
    if (pending) return;
    clear('Refreshing authorized counts…'); busy(true); shown = 20;
    if (!session) { clear('Open Workspace Report from Ambulando Apps to read your authorized counts.'); busy(false); return; }
    pending = crypto.randomUUID();
    parent.postMessage({type:'wingman-napplet-data',version:1,session,requestId:pending,operation:'read',binding:'report',range:$('range').value}, '*');
    timer = setTimeout(()=>{pending='';busy(false);clear('Counts could not be refreshed. Check your connection and try again.');},45000);
  }
  function rows() {
    const ranked = model.ranking(value); $('ranking').replaceChildren();
    for (const c of ranked.slice(0,shown)) {
      const tr=document.createElement('tr'), name=document.createElement('td'), label=document.createElement('span'), scope=document.createElement('small'), bar=document.createElement('div'), fill=document.createElement('i');
      label.textContent=c.name || 'Project channel';scope.textContent=c.scope_name || 'Scope';bar.className='bar';bar.setAttribute('aria-hidden','true');fill.style.width=`${ranked[0]?.messages ? c.messages/ranked[0].messages*100 : 0}%`;bar.append(fill);name.append(label,scope,bar);tr.append(name);
      for(const n of [c.messages,c.conversations]){const td=document.createElement('td');displayCount(td,n);tr.append(td);}$('ranking').append(tr);
    }
    $('more').hidden=shown>=ranked.length;$('shown').textContent=`Top ${ranked.length} of ${value.ranking.total_channels} accessible channels. Other channels: ${number(value.ranking.other_messages)} messages · ${number(value.ranking.other_conversations)} active conversations. Totals include all channels.`;
  }
  function render(v) {
    value=v;const t=v.inventory.tasks;
    for(const [id,n] of Object.entries({messages:v.activity.messages,conversations:v.activity.conversations,channels:v.inventory.channels,open:t.open,completed:t.completed,tasks:t.total,archived:t.archived,'current-conversations':v.inventory.conversations,documents:v.inventory.documents,files:v.inventory.files}))displayCount($(id),n);
    const fmt=s=>new Date(s).toLocaleString(undefined,{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'});
    $('period').textContent=`${v.from ? fmt(v.from) : 'All time'} → ${fmt(v.as_of)} UTC`;
    $('freshness').textContent=`Server snapshot · ${fmt(v.as_of)} UTC · Complete for your access`;
    $('coverage').textContent=`Inventory access: tasks in ${v.coverage.tasks_channels}, documents in ${v.coverage.documents_channels}, Files in ${v.coverage.files_channels} of ${v.inventory.channels} channels. Each total covers only records you can read.`;
    $('states').replaceChildren();for(const state of model.states){const el=document.createElement('span');el.textContent=`${state.replaceAll('_',' ')} · ${number(t.by_state[state])}`;$('states').append(el);}
    $('empty').hidden=v.activity.messages!==0;$('status').textContent='';rows();$('report').hidden=false;
  }
  addEventListener('message',event=>{
    const d=event.data;if(event.source!==parent||(!pending&&!lastRequest)||d?.type!=='wingman-napplet-result'||d.version!==1||d.session!==session||d.requestId!==(pending||lastRequest))return;
    clearTimeout(timer);lastRequest=d.requestId;pending='';busy(false);
    if(d.status!=='ready'||d.canWrite!==false||d.privacy!=='viewer-channels'){clear('Counts are unavailable. Refresh to check your current access.');return;}
    try{const v=model.validate(d.value);if(v.range!==$('range').value)throw Error();render(v);}catch{clear('The report was incomplete or invalid. Refresh to try again.');}
  });
  $('range').onchange=read;$('refresh').onclick=read;$('more').onclick=()=>{if(value){shown+=20;rows();}};
  addEventListener('pagehide',()=>{clearTimeout(timer);pending='';clear('Report closed.');});
  read();
})();
