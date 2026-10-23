// Count values and keys delivered by IndexedDB requests, including Dexie's
// internal reads for hooks. This does not count storage-engine B-tree node visits.
export function instrumentIndexedDb() {
  let counts;
  const restores=[];
  const reset=()=>{counts={valueRowsRead:0,keyRowsRead:0,readRequests:0,writeRequests:0,byStore:{}}};reset();
  const bump=(store,kind,count)=>{counts[kind]+=count;const row=counts.byStore[store] ||= {valueRowsRead:0,keyRowsRead:0,readRequests:0,writeRequests:0};row[kind]+=count};
  for(const proto of [IDBObjectStore.prototype,IDBIndex.prototype]) {
    for(const name of ['get','getAll','openCursor','getKey','getAllKeys','openKeyCursor']) {
      const original=proto[name];if(!original)continue;
      proto[name]=function(...args){
        const store=this.objectStore?.name || this.name;
        bump(store,'readRequests',1);
        const request=original.apply(this,args);
        request.addEventListener('success',()=>{
          const value=request.result;if(value==null)return;
          const count=name.startsWith('getAll')?value.length:1;
          bump(store,name.includes('Key')?'keyRowsRead':'valueRowsRead',count);
        });
        return request;
      };
      restores.push(()=>{proto[name]=original});
    }
  }
  for(const name of ['put','add','delete']) {
    const proto=IDBObjectStore.prototype,original=proto[name];
    proto[name]=function(...args){bump(this.name,'writeRequests',1);return original.apply(this,args)};
    restores.push(()=>{proto[name]=original});
  }
  return {reset,snapshot:()=>structuredClone(counts),restore:()=>restores.reverse().forEach(fn=>fn())};
}
