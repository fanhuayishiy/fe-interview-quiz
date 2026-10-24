const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SyncEngine}=require('../public/sync-engine.js');
const empty=()=>({wrong:{},fav:[],seen:{},rounds:[],session:null,settings:{count:10,excludedCats:[]}});
function fixture(remote={revision:0,data:null}){
  const memory={}, state={remote:structuredClone(remote),local:empty(),fail:false};
  const storage={getItem:k=>memory[k]||null,setItem:(k,v)=>memory[k]=v,removeItem:k=>delete memory[k]};
  const api=async(path,method,body)=>{
    if(state.fail) throw new Error('network down');
    if(method==='PUT'){
      if(body.revision!==state.remote.revision) throw Object.assign(new Error('conflict'),{status:409,payload:structuredClone(state.remote)});
      state.remote={revision:body.revision+1,data:structuredClone(body.data),updatedAt:100};
      return {revision:state.remote.revision,updatedAt:100};
    }
    return structuredClone(state.remote);
  };
  const engine=new SyncEngine({api,storage,getData:()=>state.local,setData:d=>state.local=structuredClone(d),onUpdate(){}});
  return {engine,state,storage,memory};
}
test('first login offers local migration and uploads only after choice',async()=>{
  const f=fixture();f.state.local.fav=[1];await f.engine.connect();
  assert.equal(f.engine.gate,'migrate');assert.equal(f.state.remote.data,null);
  await f.engine.useLocal();assert.deepEqual(f.state.remote.data.fav,[1]);
});
test('offline pending survives reload and retries',async()=>{
  const f=fixture();await f.engine.connect();f.state.local.fav=[2];f.engine.changed();
  f.state.fail=true;await f.engine.flush();assert.equal(f.engine.dirty,true);
  assert.deepEqual(JSON.parse(f.memory.quiz_cloud_pending_v1).data.fav,[2]);
  f.state.fail=false;
  const e=new SyncEngine({api:f.engine.api,storage:f.storage,getData:()=>f.state.local,setData:d=>f.state.local=d,onUpdate(){}});
  await e.connect();assert.deepEqual(f.state.remote.data.fav,[2]);assert.equal(e.dirty,false);
});
test('stale device cannot overwrite remote without conflict choice',async()=>{
  const f=fixture({revision:1,data:empty()});await f.engine.connect();
  f.state.local.fav=[1];f.engine.changed();f.state.remote={revision:2,data:{...empty(),fav:[3]}};
  await f.engine.flush();assert.equal(f.engine.gate,'conflict');assert.deepEqual(f.state.local.fav,[1]);
  assert.deepEqual(f.state.remote.data.fav,[3]);await f.engine.useRemote();
  assert.deepEqual(f.state.local.fav,[3]);assert.equal(f.engine.dirty,false);
});
test('changes during in-flight write are saved at the next revision',async()=>{
  const f=fixture();await f.engine.connect();f.state.local.fav=[1];f.engine.changed();
  const original=f.engine.api;let release;
  f.engine.api=async(...args)=>{await new Promise(r=>release=r);return original(...args);};
  const first=f.engine.flush();f.state.local.fav=[1,2];f.engine.changed();release();await first;
  f.engine.api=original;await f.engine.flush();
  assert.deepEqual(f.state.remote.data.fav,[1,2]);assert.equal(f.state.remote.revision,2);
});
test('lost save response is recognized on reconnect',async()=>{
  const f=fixture();await f.engine.connect();f.state.local.fav=[1];f.engine.changed();
  const original=f.engine.api;
  f.engine.api=async(...args)=>{await original(...args);throw new Error('response lost');};
  await f.engine.flush();f.engine.api=original;await f.engine.connect();
  assert.equal(f.engine.gate,null);assert.equal(f.engine.dirty,false);assert.equal(f.engine.revision,1);
});
test('background refresh cannot discard edits made while request is pending',async()=>{
  const f=fixture({revision:1,data:empty()});await f.engine.connect();
  let release;const original=f.engine.api;
  f.engine.api=async(...args)=>{await new Promise(r=>release=r);return original(...args);};
  const refresh=f.engine.refresh();f.state.local.fav=[4];f.engine.changed();
  f.state.remote={revision:2,data:{...empty(),fav:[3]}};release();await refresh;
  assert.deepEqual(f.state.local.fav,[4]);assert.equal(f.engine.dirty,true);
});
test('stale GET arriving after a successful PUT cannot roll back saved data',async()=>{
  const f=fixture({revision:1,data:empty()});await f.engine.connect();
  let release;const original=f.engine.api,old=structuredClone(f.state.remote);
  f.engine.api=(path,method,body)=>method==='PUT'?original(path,method,body):new Promise(r=>release=()=>r(old));
  const refresh=f.engine.refresh();f.state.local.fav=[1];f.engine.changed();await f.engine.flush();
  release();await refresh;
  assert.deepEqual(f.state.local.fav,[1]);assert.equal(f.engine.revision,2);assert.equal(f.engine.dirty,false);
});
test('periodic refresh reconnects after initial network or service failure',async()=>{
  for(const status of [undefined,503]){
    const f=fixture(),original=f.engine.api;
    f.engine.api=async()=>{throw Object.assign(new Error('temporarily unavailable'),{status});};
    await f.engine.connect();f.engine.api=original;await f.engine.refresh();
    assert.equal(f.engine.gate,null);assert.equal(f.engine.status,'云端已连接');
  }
});
test('lost response with a shuffled session reconnects despite server property normalization',async()=>{
  const app=require('./helpers/quiz-app.cjs')(),{validateData}=require('../lib/store.cjs');
  app.run('startSession({ids:[1]})');
  const snapshot=JSON.parse(app.run('JSON.stringify(DB)')),questions=JSON.parse(app.run('JSON.stringify(QUESTIONS)'));
  const f=fixture();await f.engine.connect();f.state.local=snapshot;f.engine.changed();
  const original=f.engine.api;
  f.engine.api=async(...args)=>{
    const result=await original(...args);
    if(args[1]==='PUT'){
      f.state.remote.data=validateData(f.state.remote.data,questions);
      throw new Error('response lost after database write');
    }
    return result;
  };
  await f.engine.flush();f.engine.api=original;await f.engine.connect();
  assert.equal(f.engine.gate,null);assert.equal(f.engine.dirty,false);assert.equal(f.engine.revision,1);
  assert.deepEqual(f.state.local.session.optionOrders,snapshot.session.optionOrders);
});
