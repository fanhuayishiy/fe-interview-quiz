(function(root){
  'use strict';
  const PENDING='quiz_cloud_pending_v1', BACKUP='quiz_cloud_backup_v1';
  const empty=()=>({wrong:{},fav:[],seen:{},rounds:[],session:null,settings:{count:10,excludedCats:[]}});
  const clone=value=>JSON.parse(JSON.stringify(value));
  function sameData(a,b){
    if(a===b)return true;
    if(!a || !b || typeof a!=='object' || typeof b!=='object' || Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length && keys.every(key=>Object.prototype.hasOwnProperty.call(b,key) && sameData(a[key],b[key]));
  }
  class SyncEngine{
    constructor({api,storage,getData,setData,onUpdate}){
      Object.assign(this,{api,storage,getData,setData,onUpdate});
      this.revision=0;this.dirty=false;this.gate='loading';this.status='正在连接服务器';this.sequence=0;this.epoch=0;this.saving=null;this.remote=null;this.storageError=false;
    }
    notify(){this.onUpdate(this);}
    read(key){try{return JSON.parse(this.storage.getItem(key));}catch{return null;}}
    write(key,value){try{this.storage.setItem(key,JSON.stringify(value));}catch{this.storageError=true;}}
    remove(key){try{this.storage.removeItem(key);}catch{this.storageError=true;}}
    backup(){this.write(BACKUP,{data:clone(this.getData()),savedAt:Date.now()});}
    pending(){this.write(PENDING,{revision:this.revision,data:clone(this.getData()),savedAt:Date.now()});}
    failed(error){
      this.status=error.status===401?'登录已过期，请重新登录':error.message||'网络连接中断，记录暂存本机';
      if(error.status===401) this.gate='login';
      else if(error.status>=500){if(this.gate)this.gate='offline';}
      else if(error.status && error.status!==409) this.gate='error';
      this.notify();
    }
    async connect(){
      this.epoch++;this.gate='loading';this.notify();
      try{
        const remote=await this.api('/api/state');this.remote=remote;this.revision=remote.revision;
        const pending=this.read(PENDING);
        if(pending && pending.data){
          if(sameData(pending.data,remote.data)){this.remove(PENDING);this.dirty=false;this.accept(remote);return;}
          this.setData(pending.data);this.dirty=true;
          if(pending.revision!==remote.revision){this.gate='conflict';this.status='有尚未上传的本机记录，服务器也已更新';this.notify();return;}
          this.gate=null;this.status='正在上传本机记录';await this.flush();return;
        }
        this.dirty=false;
        if(remote.data){this.accept(remote);return;}
        if(!sameData(this.getData(),empty())){this.gate='migrate';this.status='发现本机刷题记录';this.notify();return;}
        this.gate=null;this.status='云端已连接';this.notify();
      }catch(e){if(e.status!==401)this.gate='offline';this.failed(e);}
    }
    accept(remote){
      this.epoch++;
      if(!sameData(this.getData(),remote.data||empty())) this.backup();
      this.setData(remote.data||empty());this.revision=remote.revision;this.remote=remote;this.gate=null;this.dirty=false;
      this.remove(PENDING);this.status='已保存到服务器';this.notify();
    }
    changed(){
      this.sequence++;this.dirty=true;this.pending();this.status='等待保存';this.notify();
    }
    async flush(){
      if(this.saving) return this.saving;
      if(!this.dirty || this.gate) return;
      const sequence=this.sequence, snapshot=clone(this.getData());
      this.status='正在保存…';this.notify();
      this.saving=(async()=>{
        try{
          const result=await this.api('/api/state','PUT',{revision:this.revision,data:snapshot});
          this.revision=result.revision;this.remote={...result,data:snapshot};
          this.dirty=this.sequence!==sequence;
          if(this.dirty){this.pending();this.status='等待保存';}else{this.remove(PENDING);this.status='已保存到服务器';}
          this.notify();
        }catch(e){
          if(e.status===409){this.remote=e.payload;this.gate='conflict';this.status='其他设备已更新记录，请选择要保留的版本';this.notify();}
          else this.failed(e);
        }finally{this.saving=null;}
      })();
      return this.saving;
    }
    async useLocal(){
      if(this.remote) this.revision=this.remote.revision;
      this.gate=null;this.changed();await this.flush();
    }
    async useRemote(){if(this.remote)this.accept(this.remote);}
    async refresh(){
      if(this.gate==='offline'){await this.connect();return;}
      if(this.gate || this.saving)return;
      if(this.dirty){await this.flush();return;}
      const revision=this.revision,sequence=this.sequence,epoch=this.epoch;
      try{
        const remote=await this.api('/api/state');
        // A user action or logout may happen while the refresh request is in flight.
        if(this.gate || this.saving || this.dirty || this.revision!==revision || this.sequence!==sequence || this.epoch!==epoch || remote.revision<this.revision)return;
        if(remote.revision===this.revision)return;
        this.remote=remote;
        const session=this.getData().session;
        if(session && !session.done && session.idx<session.ids.length){this.gate='conflict';this.status='服务器记录已更新，当前仍有未完成练习';this.notify();}
        else this.accept(remote);
      }catch(e){this.failed(e);}
    }
    async importData(data){
      this.backup();this.setData(data);this.gate=null;this.changed();await this.flush();
    }
  }
  if(typeof module!=='undefined' && module.exports)module.exports={SyncEngine};
  else root.QuizSyncEngine=SyncEngine;
})(typeof window==='undefined'?{}:window);
