const {DatabaseSync} = require('node:sqlite');
const {randomBytes, scrypt, timingSafeEqual, createHash} = require('node:crypto');
const {promisify} = require('node:util');
const {mkdirSync} = require('node:fs');
const {dirname} = require('node:path');
const derive = promisify(scrypt);
const hashToken = token=>createHash('sha256').update(token).digest('hex');
const object = v=>v !== null && typeof v==='object' && !Array.isArray(v);
const integer = (v,min=0,max=1e9)=>Number.isSafeInteger(v) && v>=min && v<=max;
function invalid(){const e=new Error('刷题数据格式不正确，请使用本站导出的记录文件');e.status=400;throw e;}

function normalizeLegacyData(value){
  if(object(value) && value.format==='fe-quiz-backup-v1')value=value.data;
  if(!object(value) || !['wrong','fav','seen','rounds','session','settings'].some(key=>Object.hasOwn(value,key))) invalid();
  const data={wrong:{},fav:[],seen:{},rounds:[],session:null,settings:{count:10},...value};
  const records=(items, defaults)=>object(items)?Object.fromEntries(Object.entries(items).map(([id,item])=>[id,object(item)?{...defaults,...item}:item])):items;
  data.seen=records(data.seen,{r:0,w:0});
  data.wrong=records(data.wrong,{count:0,streak:0,ts:0});
  if(Array.isArray(data.rounds))data.rounds=data.rounds.map(r=>object(r)?{cat:'全部',mode:'normal',...r}:r);
  if(object(data.session))data.session={idx:0,picks:{},cat:'全部',mode:'normal',...data.session};
  if(object(data.settings)){
    data.settings={count:10,...data.settings};
    // The old "全部设为 0" control also set the global count to zero.
    if(data.settings.count===0 && object(data.settings.catCount) && data.settings.excludedCats===undefined)data.settings.count=10;
  }
  return data;
}
function validateData(value,questions){
  value=normalizeLegacyData(value);
  const ids=new Set(questions.map(q=>q.id)), cats=new Set(questions.map(q=>q.c));
  const isId=id=>integer(id,1) && ids.has(id);
  const idList=v=>Array.isArray(v) && v.length<=ids.size && v.every(isId) && new Set(v).size===v.length;
  const string=v=>typeof v==='string' && v.length<=100;
  const map=(source,convert)=>{
    if(!object(source) || Object.keys(source).length>ids.size) invalid();
    const out={};
    for(const [key,item] of Object.entries(source)){
      if(!/^[1-9]\d*$/.test(key) || !isId(Number(key)) || !object(item)) invalid();
      out[key]=convert(item);
    }
    return out;
  };
  const seen=map(value.seen,s=>{if(!integer(s.r)||!integer(s.w)) invalid();return {r:s.r,w:s.w};});
  const wrong=map(value.wrong,s=>{
    if(!integer(s.count)||!integer(s.streak)||!integer(s.ts,0,Number.MAX_SAFE_INTEGER) || (s.lastPick!==undefined && !integer(s.lastPick,0,3))) invalid();
    return {count:s.count,streak:s.streak,ts:s.ts,...(s.lastPick===undefined?{}:{lastPick:s.lastPick})};
  });
  if(!idList(value.fav)||!Array.isArray(value.rounds)||value.rounds.length>50) invalid();
  const rounds=value.rounds.map(r=>{
    if(!object(r)||!integer(r.ts,0,Number.MAX_SAFE_INTEGER)||!integer(r.total,1,ids.size)||!integer(r.correct,0,r.total)||!string(r.cat)||!['normal','wrong','fav'].includes(r.mode)) invalid();
    return {ts:r.ts,total:r.total,correct:r.correct,cat:r.cat,mode:r.mode};
  });
  let session=null;
  if(value.session!==null){
    const s=value.session;
    if(!object(s)||!idList(s.ids)||!s.ids.length||!integer(s.idx,0,s.ids.length)||!object(s.picks)||!integer(s.startAt,0,Number.MAX_SAFE_INTEGER)||!string(s.cat)||!['normal','wrong','fav'].includes(s.mode)||(s.done!==undefined && typeof s.done!=='boolean')) invalid();
    const picks={};
    for(const [key,pick] of Object.entries(s.picks)){
      if(!/^[1-9]\d*$/.test(key)||!s.ids.includes(Number(key))||(pick!==null && !integer(pick,0,3))) invalid();
      picks[key]=pick;
    }
    session={ids:s.ids,idx:s.idx,picks,startAt:s.startAt,cat:s.cat,mode:s.mode,...(s.done===undefined?{}:{done:s.done})};
    if(s.optionOrders!==undefined){
      if(!object(s.optionOrders)||Object.keys(s.optionOrders).length!==s.ids.length) invalid();
      const optionOrders={};
      for(const id of s.ids){
        const order=s.optionOrders[id], length=questions.find(q=>q.id===id).o.length;
        if(!Array.isArray(order)||order.length!==length||new Set(order).size!==length||!order.every(i=>integer(i,0,length-1))) invalid();
        optionOrders[id]=order;
      }
      session.optionOrders=optionOrders;
    }
  }
  const settings=value.settings;
  if(!object(settings)||!integer(settings.count,1,ids.size)) invalid();
  const excluded=Array.isArray(settings.excludedCats) ? settings.excludedCats : Object.keys(settings.catCount||{}).filter(c=>Number(settings.catCount[c])===0);
  if(excluded.length>cats.size || !excluded.every(c=>cats.has(c)) || new Set(excluded).size!==excluded.length) invalid();
  return {wrong,fav:value.fav,seen,rounds,session,settings:{count:settings.count,excludedCats:excluded}};
}

async function passwordHash(password,salt){return Buffer.from(await derive(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}));}
function checkCredentials(username,password){
  if(typeof username!=='string'||!username.trim()||username.length>80) throw new Error('请配置有效的 ADMIN_USERNAME');
  if(typeof password!=='string'||password.length<12||password.length>256) throw new Error('首次启动需配置 ADMIN_PASSWORD（12–256 个字符）');
}
async function openStore({dbPath,username,password,questions}){
  mkdirSync(dirname(dbPath),{recursive:true});
  const db=new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS account(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, data TEXT, updated_at INTEGER);
    INSERT OR IGNORE INTO state(id,revision) VALUES(1,0);`);
  let account=db.prepare('SELECT * FROM account WHERE id=1').get();
  if(!account){
    try{
      checkCredentials(username,password);
      const salt=randomBytes(16).toString('hex');
      const hash=(await passwordHash(password,salt)).toString('hex');
      db.prepare('INSERT INTO account VALUES(1,?,?,?)').run(username.trim(),salt,hash);
      account=db.prepare('SELECT * FROM account WHERE id=1').get();
    }catch(e){db.close();throw e;}
  }
  return {
    db,get username(){return account.username;},
    async authenticate(name,pass){
      if(typeof name!=='string'||typeof pass!=='string'||pass.length>256) return false;
      const key=await passwordHash(pass,account.salt);
      return timingSafeEqual(key,Buffer.from(account.hash,'hex')) && name===account.username;
    },
    createSession(){
      const now=Date.now();
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
      const token=randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES(?,?)').run(hashToken(token),now+7*86400000);
      return token;
    },
    authorized(token){return typeof token==='string' && /^[a-f0-9]{64}$/.test(token) && !!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(hashToken(token),Date.now());},
    revoke(token){if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));},
    read(){const row=db.prepare('SELECT * FROM state WHERE id=1').get();return {revision:row.revision,data:row.data?validateData(JSON.parse(row.data),questions):null,updatedAt:row.updated_at};},
    write(revision,data){
      if(!integer(revision)) invalid();
      const clean=validateData(data,questions), now=Date.now();
      const result=db.prepare('UPDATE state SET revision=revision+1,data=?,updated_at=? WHERE id=1 AND revision=?').run(JSON.stringify(clean),now,revision);
      return result.changes ? {revision:revision+1,updatedAt:now} : null;
    },
    async resetPassword(name,pass){
      checkCredentials(name,pass);
      const salt=randomBytes(16).toString('hex'), hash=(await passwordHash(pass,salt)).toString('hex');
      db.exec('BEGIN IMMEDIATE');
      try{db.prepare('UPDATE account SET username=?,salt=?,hash=? WHERE id=1').run(name.trim(),salt,hash);db.exec('DELETE FROM sessions; COMMIT');}
      catch(e){db.exec('ROLLBACK');throw e;}
      account=db.prepare('SELECT * FROM account WHERE id=1').get();
    },
    close(){db.close();}
  };
}
module.exports={openStore,validateData};
