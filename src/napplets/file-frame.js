import { validFileNappletRequest } from './file-data.js';

export class FileNappletFrame {
  constructor(data, {onDirty=()=>{},onBusy=()=>{},onRevoke=()=>{}}={}) {this.data=data;this.onDirty=onDirty;this.onBusy=onBusy;this.onRevoke=onRevoke;this.active=null;}
  attach(frame, session) {
    this.detach();const state={frame,session,busy:false,checking:false,used:new Set()};this.active=state;
    const current=()=>this.active===state&&!this.data.stopped;
    const revoke=()=>{if(!current())return;this.detach();this.data.stop();this.onRevoke();};
    state.listener=async event=>{
      if(!current()||!validFileNappletRequest(event,frame.contentWindow,session))return;
      const d=event.data;if(d.operation==='dirty'){this.onDirty(d.dirty);return;}
      if(state.busy||state.checking||state.used.has(d.requestId))return;
      if(state.used.size>=10000){revoke();return;}state.used.add(d.requestId);state.busy=true;this.onBusy(true);
      const deadline=setTimeout(revoke,45000);
      const reply=value=>{if(current())frame.contentWindow?.postMessage({type:'wingman-napplet-result',version:1,session,requestId:d.requestId,...value},'*');};
      try{const value=d.operation==='read'?await this.data.read():await this.data.save(d.baseVersionId,d.value);
        if(state.checkRequested){state.checkRequested=false;const access=await this.data.authority();if(value.canWrite&&!access.canWrite){revoke();return;}}
        state.canWrite=value.canWrite;reply({status:'ready',...value});}
      catch(error){if(!current())return;if(d.operation==='read'||[401,403,404].includes(error.status)){revoke();return;}
        try{await this.data.authority();if(!current())return;reply({status:'error',code:error.status===409?'conflict':'unavailable',message:error.status===409?'A newer version exists.':'Save could not be confirmed.'});}catch{revoke();}}
      finally{clearTimeout(deadline);if(current()){state.busy=false;this.onBusy(false);}}
    };
    state.check=async()=>{if(!current()||state.checking)return;if(state.busy){state.checkRequested=true;return;}state.checking=true;frame.inert=true;try{const deadline=setTimeout(revoke,45000);let access;try{access=await this.data.authority();}finally{clearTimeout(deadline);}if(state.canWrite===true&&!access.canWrite)throw new Error('Write access changed.');}catch{revoke();}finally{state.checking=false;if(current())frame.inert=false;}};
    addEventListener('message',state.listener);addEventListener('focus',state.check);
    state.visibility=()=>{if(document.visibilityState==='visible')void state.check();};addEventListener('visibilitychange',state.visibility);
    state.timer=setInterval(state.check,30000);
  }
  async check(){ await this.active?.check(); }
  detach(){const s=this.active;this.active=null;if(!s)return;removeEventListener('message',s.listener);removeEventListener('focus',s.check);removeEventListener('visibilitychange',s.visibility);clearInterval(s.timer);}
  stop(){this.detach();this.data.stop();}
}
