(() => {
  const M = globalThis.DailyTrackerModel, $ = id => document.getElementById(id);
  let model = M.empty(), base = '', dirty = false, busy = false, canWrite = false, mode = 'checkin', sequence = 0;
  let pending = null, invalidNumber = false, reloadConfirmed = false;
  const session = window.nappletSession;
  const send = (operation, extra = {}) => {
    const requestId = `tracker_${++sequence}`;
    parent.postMessage({type:'wingman-napplet-data',version:1,session,requestId,operation,...extra},'*');
    return requestId;
  };
  const notice = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'error' : ''; };
  const mark = () => { reloadConfirmed=false;$('reload').textContent='Reload saved';dirty = true; send('dirty',{dirty:true}); $('save').disabled = !canWrite || busy; notice('Unsaved changes'); };
  const el = (tag, text, parentNode, attributes = {}) => {
    const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
    for (const [k,v] of Object.entries(attributes)) node.setAttribute(k,v);
    parentNode.append(node); return node;
  };
  const button = (label, parentNode, action, attrs = {}) => { const b = el('button',label,parentNode,{type:'button',...attrs}); b.disabled = busy || !canWrite; b.onclick = action; return b; };
  function setAnswer(id, value) {
    const date = $('date').value; if (!M.validDate(date)) return;
    const values = model.days[date] ||= {};
    if (value === undefined) delete values[id]; else values[id] = value;
    if (!Object.keys(values).length) delete model.days[date]; mark();
  }
  function render() {
    const root = $('content'); root.replaceChildren();
    for (const tab of ['checkin','manage','history']) $(tab).setAttribute('aria-pressed',String(mode===tab));
    $('save').disabled = !dirty || !canWrite || busy || invalidNumber;
    for (const tab of ['checkin','manage','history']) $(tab).disabled = busy || invalidNumber;
    $('date').disabled = busy || invalidNumber; $('today').disabled = busy || invalidNumber;
    $('reload').disabled = busy;
    if (mode === 'history') {
      el('h2','Saved days and current edits',root);
      const list = el('div',undefined,root,{id:'history-list'});
      for (const date of Object.keys(model.days).sort().reverse()) {
        const b = el('button',`${date} · ${Object.keys(model.days[date]).length} answered`,list,{type:'button'});
        b.onclick = () => { $('date').value=date; mode='checkin';render(); };
      }
      if (!Object.keys(model.days).length) el('p','No entries yet. Start with today or choose an earlier day.',root);
      return;
    }
    if (mode === 'manage') {
      el('h2','Your metrics',root);
      el('p','Rename or reorder any metric. Archive a metric to keep its history.',root,{class:'subtle'});
      model.metrics.forEach((m,index) => {
        const card = el('div',undefined,root,{class:`metric${m.archived?' archived':''}`});
        const fields = el('div',undefined,card,{class:'edit-fields'});
        const label = el('label','Label',fields), input = el('input',undefined,label,{value:m.label,maxlength:'120'});
        input.disabled = busy || !canWrite; input.oninput = () => { m.label=input.value;mark(); };
        const units = el('label','Units (optional)',fields), unit = el('input',undefined,units,{value:m.unit,maxlength:'24'});
        unit.disabled = busy || !canWrite || m.type!=='number'; unit.oninput=()=>{m.unit=unit.value;mark();};
        el('p',m.type==='boolean'?'Yes / No':'Number',fields,{class:'subtle'});
        const row=el('div',undefined,card,{class:'row'});
        const up=button('↑ Move up',row,()=>{[model.metrics[index-1],model.metrics[index]]=[m,model.metrics[index-1]];mark();render();});up.disabled ||= index===0;
        const down=button('↓ Move down',row,()=>{[model.metrics[index+1],model.metrics[index]]=[m,model.metrics[index+1]];mark();render();});down.disabled ||= index===model.metrics.length-1;
        button(m.archived?'Restore':'Archive',row,()=>{m.archived=!m.archived;mark();render();});
      });
      const add=el('div',undefined,root,{class:'metric'});el('h2','Add a metric',add);
      const label=el('label','Metric label',add), input=el('input',undefined,label,{maxlength:'120',placeholder:'For example, ate well'});
      const typeLabel=el('label','Answer type',add), select=el('select',undefined,typeLabel);
      el('option','Yes / No',select,{value:'boolean'});el('option','Number',select,{value:'number'});
      button('Add metric',add,()=>{if(!input.value.trim()){input.focus();return;}if(model.metrics.length>=200){notice('A tracker supports up to 200 metrics.',true);return;}model.metrics.push({id:M.uuid(),label:input.value.trim(),type:select.value,unit:'',archived:false});mark();render();});
      return;
    }
    const date=$('date').value, values=model.days[date]||{};
    const visible=model.metrics.filter(m=>!m.archived || Object.hasOwn(values,m.id));
    if(!visible.length) {el('p','Define the things you want to check each day.',root);button('Define metrics',root,()=>{mode='manage';render();});}
    for(const m of visible){
      const card=el('div',undefined,root,{class:'metric'});el('h2',`${m.label}${m.unit?' · '+m.unit:''}${m.archived?' (archived)':''}`,card);
      if(m.type==='boolean'){
        const row=el('div',undefined,card,{class:'answers'});
        for(const [label,value] of [['Yes',true],['No',false],['Unanswered',undefined]])button(label,row,()=>{setAnswer(m.id,value);render();},{'aria-pressed':String(value===undefined?!Object.hasOwn(values,m.id):values[m.id]===value)});
      }else{
        const label=el('label',m.unit?`Value (${m.unit})`:'Value',card), input=el('input',undefined,label,{type:'number',step:'any',placeholder:'Unanswered',value:Object.hasOwn(values,m.id)?String(values[m.id]):''});
        input.disabled=busy||!canWrite;input.oninput=()=>{invalidNumber=input.validity.badInput; $('save').disabled=invalidNumber||busy||!dirty||!canWrite; for(const id of ['checkin','manage','history','date','today'])$(id).disabled=invalidNumber||busy; if(invalidNumber){notice('Enter a valid number.',true);return;}const value=input.value===''?undefined:Number(input.value);if(value!==undefined&&!Number.isFinite(value))return;setAnswer(m.id,value);};
        button('Clear answer',card,()=>{invalidNumber=false;setAnswer(m.id,undefined);render();});
      }
    }
  }
  function requestRead(){if(busy)return;if(dirty&&!reloadConfirmed){reloadConfirmed=true;$('reload').textContent='Discard edits and reload';notice('Reloading will discard your unsaved edits. Click Discard edits and reload to continue.',true);return;}reloadConfirmed=false;$('reload').textContent='Reload saved';busy=true;pending=send('read',{binding:'tracker'});notice('Loading private tracker…');render();}
  $('date').value=M.localDate();$('date').onchange=()=>{if(!M.validDate($('date').value)){$('date').value=M.localDate();}render();};
  $('today').onclick=()=>{$('date').value=M.localDate();render();};
  for(const tab of ['checkin','manage','history'])$(tab).onclick=()=>{mode=tab;render();};
  $('reload').onclick=requestRead;
  $('save').onclick=()=>{if(busy||invalidNumber||!canWrite||!dirty)return;try{model=M.validate(model);}catch(e){notice('Check your metric labels and values before saving.',true);return;}busy=true;pending=send('save',{binding:'tracker',baseVersionId:base,value:model});notice('Saving to NStack…');render();};
  addEventListener('message',event=>{
    const r=event.data;if(event.source!==parent||!r||r.type!=='wingman-napplet-result'||r.version!==1||r.session!==session||r.requestId!==pending)return;
    busy=false;pending=null;
    if(r.status==='ready'){
      try{model=M.validate(r.value);if(r.privacy!=='self-channel'||typeof r.baseVersionId!=='string')throw Error();base=r.baseVersionId;canWrite=r.canWrite===true;dirty=false;invalidNumber=false;send('dirty',{dirty:false});$('controls').hidden=false;notice(canWrite?'Saved in NStack · private conversation':'Private tracker · read only');render();}catch{canWrite=false;$('controls').hidden=true;notice('The host did not confirm a valid private tracker.',true);}
    }else{notice(r.code==='conflict'?'Another device saved changes. Your draft remains here. Review it before Reload saved; reloading discards this draft.':'Save or load could not be confirmed. Your draft remains here. Reload saved to check NStack before retrying.',true);render();}
  });
  if(session)requestRead();
})();
