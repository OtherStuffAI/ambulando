import { validGenericRequest } from './generic-protocol.js';
export class GenericNappletFrame {
  constructor(data,{onDirty=()=>{},onBusy=()=>{},onRevoke=()=>{}}={}){this.data=data;this.onDirty=onDirty;this.onBusy=onBusy;this.onRevoke=onRevoke;this.active=null;}
  attach(frame,session){
    this.detach();const s={frame,session,used:new Set(),busy:false,checking:false};this.active=s;
    const current=()=>this.active===s&&!this.data.stopped;
    const revoke=()=>{if(!current())return;this.stop();this.onBusy(false);this.onRevoke();};
    s.listener=async event=>{
      if(!current()||!validGenericRequest(event,frame.contentWindow,session,this.data.binding)||s.used.has(event.data.requestId))return;
      const d=event.data;if(s.busy)return;if(s.checking){s.queued=event;return;}
      if(s.used.size>=10000){revoke();return;}s.used.add(d.requestId);
      if(d.operation==='dirty'){this.onDirty(d.dirty);return;}
      s.busy=true;this.onBusy(true);const timer=setTimeout(revoke,45000);
      const reply=value=>{if(current())frame.contentWindow?.postMessage({type:'wingman-napplet-result',version:2,session,requestId:d.requestId,...value},'*');};
      try{
        let result=d.operation==='read'?await this.data.read(d.range):await this.data.save(d.baseVersionId,d.value);
        if(s.checkRequested&&this.data.binding.capability==='workspace-aggregate'){s.checkRequested=false;result=await this.data.read(d.range);if(s.checkRequested){revoke();return;}}
        await this.data.authority();s.checkRequested=false;
        if(d.operation==='read'&&this.data.binding.capability==='workspace-aggregate'&&this.data.binding.version===2)s.last={requestId:d.requestId,range:d.range};
        reply({status:'ready',...result});
      }catch(error){
        if(!current())return;
        try{await this.data.authority();const forbidden=this.data.binding.capability==='workspace-aggregate'&&this.data.binding.version===2&&error.status===403;reply({status:'error',code:forbidden?'forbidden':error.status===409?'conflict':'unavailable',message:forbidden?'Workspace management permission required.':error.status===409?'A newer version exists.':'Operation could not be confirmed.'});}catch{revoke();}
      }finally{clearTimeout(timer);if(current()){s.busy=false;this.onBusy(false);}}
    };
    s.check=async()=>{if(!current()||s.checking)return;if(s.busy){s.checkRequested=true;return;}s.checking=true;frame.inert=true;const timer=setTimeout(revoke,45000);try{if(s.last){const result=await this.data.read(s.last.range);await this.data.authority();if(current()&&!s.queued)frame.contentWindow?.postMessage({type:'wingman-napplet-result',version:2,session,requestId:s.last.requestId,status:'ready',...result},'*');}else await this.data.authority();}catch{revoke();}finally{clearTimeout(timer);s.checking=false;if(current()){frame.inert=false;const next=s.queued;s.queued=null;if(next)void s.listener(next);}}};
    s.visibility=()=>{if(document.visibilityState==='visible')void s.check();};
    addEventListener('message',s.listener);addEventListener('focus',s.check);addEventListener('visibilitychange',s.visibility);s.timer=setInterval(s.check,30000);
  }
  async check(){await this.active?.check();}
  detach(){const s=this.active;this.active=null;if(!s)return;removeEventListener('message',s.listener);removeEventListener('focus',s.check);removeEventListener('visibilitychange',s.visibility);clearInterval(s.timer);}
  stop(){this.detach();this.data.stop();}
}
