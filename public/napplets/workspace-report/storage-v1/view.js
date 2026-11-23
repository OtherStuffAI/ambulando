(() => {
  'use strict';
  const root=document.getElementById('storage'),groups=document.getElementById('storage-groups');
  const labels={postgres:'PostgreSQL · logical workspace estimate',object_storage:'S3 / object storage · retained metadata',rows:'Retained rows',row_json_bytes:'Logical row bytes',metadata_json_bytes:'Metadata bytes (subset)',history_rows:'History rows (subset)',history_row_json_bytes:'History bytes (subset)',tables_measured:'Tables measured',physical_bytes:'Physical database bytes',objects:'Retained completed objects',bytes:'Retained object bytes',pending_objects:'Pending objects',provider_actual_bytes:'Provider-measured bytes'};
  const label=id=>labels[id]||id.replaceAll('_',' ').replaceAll('-',' ');
  const stamp=s=>s?new Date(s).toLocaleString(undefined,{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'})+' UTC':'Unavailable';
  function clear(){root.hidden=true;groups.replaceChildren();document.getElementById('storage-caveats').replaceChildren();document.getElementById('storage-asof').textContent='';}
  function render(storage){
    clear();
    document.getElementById('storage-asof').textContent=`Measured snapshot: ${stamp(storage.as_of)}. Provider measurement: ${stamp(storage.provider_measured_at)}. Last recorded object completion: ${stamp(storage.last_object_completed_at)}.`;
    for(const group of storage.groups){
      const section=document.createElement('section'),heading=document.createElement('h3'),list=document.createElement('div');
      heading.textContent=label(group.id);list.className='storage-metrics';section.append(heading,list);
      for(const metric of group.metrics){
        const card=document.createElement('article'),title=document.createElement('p'),value=document.createElement('strong'),method=document.createElement('small');
        title.textContent=label(metric.id);
        value.textContent=metric.status==='unavailable'?'Unavailable':`${metric.value.toLocaleString()}${metric.unit==='bytes'?' bytes':''}`;
        value.title=metric.status==='unavailable'?'Not measured':`${metric.value} ${metric.unit}`;
        method.textContent=`${metric.status} · ${metric.method}`;card.append(title,value,method);list.append(card);
      }
      groups.append(section);
    }
    for(const caveat of storage.caveats){const li=document.createElement('li');li.textContent=caveat;document.getElementById('storage-caveats').append(li);}
    root.hidden=false;
  }
  globalThis.WorkspaceStorageView=Object.freeze({render,clear});
})();
