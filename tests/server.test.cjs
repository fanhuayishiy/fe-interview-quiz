const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, rm, readFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createApp} = require('../server.cjs');
const password = 'test-only-password-123';
function data(){return {wrong:{1:{count:1,streak:0,ts:1000,lastPick:1}},fav:[2],seen:{1:{r:0,w:1}},rounds:[],session:null,settings:{count:20,excludedCats:['Vue']}};}
async function fixture(t, extra={}){
  const dir=await mkdtemp(join(tmpdir(),'quiz-test-'));
  let app;
  async function boot(){
    app=await createApp({dbPath:join(dir,'quiz.sqlite'),username:'owner',password,secureCookie:false,publicOrigin:'http://quiz.test',...extra});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  let base=await boot();
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  let cookie='';
  async function req(path,method='GET',body,options={}){
    return fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Quiz-Request':'1',...(cookie?{Cookie:cookie}:{}),...options},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  async function login(){const r=await req('/api/login','POST',{username:'owner',password});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];return r;}
  return {req,login,dir,get store(){return app.store;},restart:async()=>{await app.close();base=await boot();}};
}
test('single account login, cookies, expiration and logout',async t=>{
  const f=await fixture(t);
  assert.equal((await f.req('/api/state')).status,401);
  assert.equal((await f.req('/api/login','POST',{username:'owner',password:'wrong'})).status,401);
  const login=await f.login();
  assert.match(login.headers.get('set-cookie'),/HttpOnly/);
  assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await (await f.req('/api/me')).json()).username,'owner');
  assert.equal((await f.req('/api/logout','POST',{})).status,200);
  assert.equal((await f.req('/api/state')).status,401);
  await f.login();
  f.store.db.prepare('UPDATE sessions SET expires_at = 0').run();
  assert.equal((await f.req('/api/me')).status,401);
});
test('state round trip, stale writers rejected, restart keeps data and session',async t=>{
  const f=await fixture(t);await f.login();
  assert.deepEqual(await (await f.req('/api/state')).json(),{revision:0,data:null,updatedAt:null});
  const first=await f.req('/api/state','PUT',{revision:0,data:data()});
  assert.equal(first.status,200);assert.equal((await first.json()).revision,1);
  const stale=await f.req('/api/state','PUT',{revision:0,data:{...data(),fav:[]}});
  assert.equal(stale.status,409);assert.equal((await stale.json()).revision,1);
  await f.restart();
  const saved=await (await f.req('/api/state')).json();
  assert.equal(saved.revision,1);assert.deepEqual(saved.data,data());
  const bytes=await readFile(join(f.dir,'quiz.sqlite'));
  assert.equal(bytes.includes(Buffer.from(password)),false);
});
test('origin, body, schema and static file protection',async t=>{
  const f=await fixture(t);await f.login();
  assert.equal((await f.req('/api/state','PUT',{revision:0,data:data()},{Origin:'https://evil.test'})).status,403);
  assert.equal((await f.req('/api/state','PUT',{revision:0,data:data()},{'X-Quiz-Request':''})).status,403);
  assert.equal((await f.req('/api/state','PUT',{revision:0,data:data()},{'Content-Type':'text/plain'})).status,415);
  for(const invalid of [{...data(),fav:[999]}, {...data(),settings:{count:-1}}, {...data(),seen:{1:{r:-1,w:0}}}, {...data(),session:{ids:[1,1]}}]){
    assert.equal((await f.req('/api/state','PUT',{revision:0,data:invalid})).status,400);
  }
  const big={...data(),junk:'x'.repeat(1024*1024)};
  assert.equal((await f.req('/api/state','PUT',{revision:0,data:big})).status,413);
  for(const p of ['/.env','/data/quiz.sqlite','/server.cjs','/.git/config','/api/register']) assert.equal((await f.req(p)).status,404);
  const html=await (await f.req('/')).text();assert.match(html,/src="\/sync.js"/);
  assert.equal((await f.req('/healthz')).status,200);
});
test('login rate limit and secure production cookie',async t=>{
  const f=await fixture(t,{loginLimit:2,secureCookie:true});
  const login=await f.login();assert.match(login.headers.get('set-cookie'),/; Secure/);
  for(let i=0;i<2;i++) assert.equal((await f.req('/api/login','POST',{username:'owner',password:'wrong'})).status,401);
  assert.equal((await f.req('/api/login','POST',{username:'owner',password})).status,429);
});
test('password reset revokes sessions without changing quiz data',async t=>{
  const f=await fixture(t);await f.login();
  await f.req('/api/state','PUT',{revision:0,data:data()});
  await f.store.resetPassword('new-owner','new-test-password-456');
  assert.equal((await f.req('/api/me')).status,401);
  assert.equal((await f.req('/api/login','POST',{username:'owner',password})).status,401);
  const login=await f.req('/api/login','POST',{username:'new-owner',password:'new-test-password-456'});
  assert.equal(login.status,200);assert.equal((await login.json()).username,'new-owner');
  assert.deepEqual(f.store.read().data,data());
});
test('validates legacy import without writing it and rejects malformed JSON',async t=>{
  const f=await fixture(t);await f.login();
  const legacy={...data(),settings:{count:10,catCount:{Vue:0,JavaScript:5}}};
  const validated=await f.req('/api/validate','POST',legacy);
  assert.equal(validated.status,200);
  assert.deepEqual((await validated.json()).data.settings,{count:10,excludedCats:['Vue']});
  assert.equal(f.store.read().revision,0);
  assert.equal((await f.req('/api/state','PUT',null)).status,400);
});
test('session option permutations survive server round trip and reject corruption',async t=>{
  const f=await fixture(t);await f.login();
  const snapshot={...data(),session:{ids:[1],idx:0,picks:{1:2},startAt:1000,cat:'全部',mode:'normal',optionOrders:{1:[2,0,3,1]}}};
  assert.equal((await f.req('/api/state','PUT',{revision:0,data:snapshot})).status,200);
  const saved=await (await f.req('/api/state')).json();
  assert.deepEqual(saved.data.session,snapshot.session);
  await f.restart();
  assert.deepEqual((await (await f.req('/api/state')).json()).data.session.optionOrders,{1:[2,0,3,1]});
  for(const optionOrders of [{1:[0,0,2,3]},{1:[0,1,2,4]},{1:[0,1,2]},{2:[0,1,2,3]},{}]){
    assert.equal((await f.req('/api/state','PUT',{revision:1,data:{...snapshot,session:{...snapshot.session,optionOrders}}})).status,400);
  }
});
test('existing legacy SQLite records load without overwriting source or revision',async t=>{
  const f=await fixture(t);await f.login();
  const old=require('./helpers/legacy-data.cjs')(),raw=JSON.stringify(old);
  f.store.db.prepare('UPDATE state SET data=?,revision=8,updated_at=1000 WHERE id=1').run(raw);
  const loaded=await (await f.req('/api/state')).json();
  assert.equal(loaded.revision,8);assert.equal(loaded.updatedAt,1000);
  assert.deepEqual(loaded.data.settings,{count:5,excludedCats:['Vue']});
  for(const key of ['wrong','fav','seen','rounds','session'])assert.deepEqual(loaded.data[key],old[key]);
  assert.equal(f.store.db.prepare('SELECT data FROM state WHERE id=1').get().data,raw);
  await f.restart();assert.equal((await (await f.req('/api/state')).json()).revision,8);
  const saved=await f.req('/api/state','PUT',{revision:8,data:loaded.data});assert.equal(saved.status,200);
  assert.equal((await saved.json()).revision,9);
});
test('public release metadata matches both pages and keeps its time after restart',async t=>{
  const revision='abcdef0123456789abcdef0123456789abcdef01';
  const f=await fixture(t,{release:{revision,updatedAt:'2026-10-24T18:30:00Z'}});
  const response=await f.req('/api/version');assert.equal(response.status,200);
  const metadata=await response.json();
  assert.equal(metadata.version,require('../package.json').version);
  assert.equal(metadata.revision,revision);
  assert.equal(metadata.updatedAt,'2026-10-24T18:30:00.000Z');
  assert.equal(metadata.updatedAtText,'2026-10-25 02:30');
  for(const route of ['/','/index.html']){
    const page=await (await f.req(route)).text();
    assert.ok(page.includes('v'+metadata.version+' · abcdef0'));
    assert.match(page,/2026-10-25 02:30（北京时间）/);
    assert.match(page,/id="release-info"/);
  }
  await f.restart();assert.deepEqual(await (await f.req('/api/version')).json(),metadata);
});
