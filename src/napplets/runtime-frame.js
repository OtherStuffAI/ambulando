import { validRuntimeRequest } from './runtime-protocol.js';
// No transport or signer is exposed to the document. Data is bound by the host.
export class NappletRuntimeFrame {
  constructor(data,{onDirty=()=>{},onBusy=()=>{},onRevoke=()=>{},onUpdate=()=>{}}={}) {
    Object.assign(this,{data,onDirty,onBusy,onRevoke,onUpdate});this.active=null;
  }
  attach(frame,session) {
    this.detach();const s={frame,session,used:new Set(),busy:false,checking:false};this.active=s;
    const current=()=>this.active===s&&!this.data.stopped;
    const revoke=()=>{if(!current())return;this.stop();this.onBusy(false);this.onRevoke();};
    const authority=async()=>{const state=await this.data.authority();if(current()&&state?.updateAvailable)this.onUpdate();};
    s.listener=async event=>{
      if(!current()||s.busy||s.checking||!validRuntimeRequest(event,frame.contentWindow,session,this.data.manifest)||s.used.has(event.data.requestId))return;
      if(s.used.size>=10000){revoke();return;}
      const d=event.data;s.used.add(d.requestId);
      if(d.operation==='dirty'){this.onDirty(d.dirty);return;}
      s.busy=true;this.onBusy(true);const timer=setTimeout(revoke,45000);
      const reply=value=>{if(current())frame.contentWindow?.postMessage({type:'wingman-napplet-result',version:3,session,requestId:d.requestId,...value},'*');};
      try {
        await authority();if(!current())return;
        const result=await this.data.execute(d);await authority();reply({status:'ready',result});
      } catch(error) {
        if(!current())return;
        try { await authority();reply({status:'error',code:error.status===409?'conflict':error.code==='unsupported'?'unsupported':'unavailable',message:error.status===409?'A newer revision exists. Reload before editing.':'Operation could not be confirmed.'}); } catch { revoke(); }
      } finally {clearTimeout(timer);if(current()){s.busy=false;this.onBusy(false);}}
    };
    s.check=async()=>{
      if(!current()||s.checking||s.busy)return;
      s.checking=true;frame.inert=true;const timer=setTimeout(revoke,45000);
      try{await authority();}catch{revoke();}finally{clearTimeout(timer);s.checking=false;if(current())frame.inert=false;}
    };
    s.visibility=()=>{if(document.visibilityState==='visible')void s.check();};
    addEventListener('message',s.listener);addEventListener('focus',s.check);addEventListener('visibilitychange',s.visibility);s.timer=setInterval(s.check,30000);
    s.offline=revoke;addEventListener('offline',s.offline);
  }
  async check(){await this.active?.check();}
  detach(){const s=this.active;this.active=null;if(!s)return;removeEventListener('message',s.listener);removeEventListener('focus',s.check);removeEventListener('visibilitychange',s.visibility);removeEventListener('offline',s.offline);clearInterval(s.timer);}
  stop(){this.detach();this.data.stop();}
}
