const http=require('node:http');
const {readFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {openStore,validateData}=require('./lib/store.cjs');
const root=__dirname;
const html=readFileSync(join(root,'index.html'),'utf8');
const questions=JSON.parse(html.match(/const QUESTIONS = (\[[^\r\n]+\]);\r?\n/)[1]);

async function createApp(options={}){
  const publicOrigin=new URL(options.publicOrigin||process.env.PUBLIC_URL||'http://localhost:3000').origin;
  const secure=options.secureCookie ?? process.env.COOKIE_SECURE!=='false';
  const store=await openStore({dbPath:options.dbPath||resolve(process.env.DATA_DIR||join(root,'data'),'quiz.sqlite'),username:options.username||process.env.ADMIN_USERNAME,password:options.password||process.env.ADMIN_PASSWORD,questions});
  const limit=options.loginLimit||10, attempts={count:0,until:0};
  const files={
    '/':['text/html; charset=utf-8',()=>html.replace('<!-- server-sync -->','<link rel="stylesheet" href="/sync.css"><script defer src="/sync-engine.js"></script><script defer src="/sync.js"></script>')],
    '/index.html':['text/html; charset=utf-8',()=>html.replace('<!-- server-sync -->','<link rel="stylesheet" href="/sync.css"><script defer src="/sync-engine.js"></script><script defer src="/sync.js"></script>')],
    '/sync-engine.js':['text/javascript; charset=utf-8',()=>readFileSync(join(root,'public/sync-engine.js'))],
    '/sync.js':['text/javascript; charset=utf-8',()=>readFileSync(join(root,'public/sync.js'))],
    '/sync.css':['text/css; charset=utf-8',()=>readFileSync(join(root,'public/sync.css'))]
  };
  function json(res,status,value,extra={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(value));}
  function error(status,message){const e=new Error(message);e.status=status;return e;}
  async function body(req){
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) throw error(415,'需要 JSON 请求');
    if(Number(req.headers['content-length'])>1024*1024) throw error(413,'记录文件不能超过 1 MB');
    let size=0,chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>1024*1024) throw error(413,'记录文件不能超过 1 MB');chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error(400,'JSON 格式不正确');}
  }
  function cookie(token,expired=false){return `quiz_session=${expired?'':token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired?0:7*86400}${secure?'; Secure':''}`;}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    try{
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/healthz' && req.method==='GET') return json(res,200,{ok:true});
      if(!path.startsWith('/api/')){
        const file=files[path];
        if(!file||!['GET','HEAD'].includes(req.method)) return json(res,404,{error:'页面不存在'});
        res.writeHead(200,{'Content-Type':file[0]});return res.end(req.method==='HEAD'?undefined:file[1]());
      }
      if(!['/api/login','/api/logout','/api/me','/api/state','/api/validate'].includes(path)) return json(res,404,{error:'接口不存在'});
      if(!['GET','HEAD'].includes(req.method)){
        if(req.headers['x-quiz-request']!=='1' || (req.headers.origin && req.headers.origin!==publicOrigin) || req.headers['sec-fetch-site']==='cross-site') throw error(403,'请求来源不允许，请检查 PUBLIC_URL 与访问域名是否一致');
      }
      const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('quiz_session='))?.slice(13);
      if(path==='/api/login' && req.method==='POST'){
        const now=Date.now();
        if(now>=attempts.until){attempts.count=0;attempts.until=now+15*60000;}
        if(attempts.count>=limit) return json(res,429,{error:'尝试次数过多，请 15 分钟后重试'},{'Retry-After':String(Math.ceil((attempts.until-now)/1000))});
        attempts.count++;
        const input=await body(req);
        if(!input || !await store.authenticate(input.username,input.password)) return json(res,401,{error:'用户名或密码不正确'});
        attempts.count=0;store.revoke(token);
        return json(res,200,{username:store.username},{'Set-Cookie':cookie(store.createSession())});
      }
      if(!store.authorized(token)) return json(res,401,{error:'请先登录'});
      if(path==='/api/me' && req.method==='GET') return json(res,200,{username:store.username});
      if(path==='/api/logout' && req.method==='POST'){await body(req);store.revoke(token);return json(res,200,{ok:true},{'Set-Cookie':cookie('',true)});}
      if(path==='/api/state' && req.method==='GET') return json(res,200,store.read());
      if(path==='/api/validate' && req.method==='POST') return json(res,200,{data:validateData(await body(req),questions)});
      if(path==='/api/state' && req.method==='PUT'){
        const input=await body(req);
        if(!input || typeof input!=='object') throw error(400,'请求格式不正确');
        const result=store.write(input.revision,input.data);
        return result ? json(res,200,result) : json(res,409,{error:'其他设备已更新记录，请选择要保留的版本',...store.read()});
      }
      json(res,405,{error:'请求方法不允许'});
    }catch(e){if(!res.headersSent) json(res,e.status||500,{error:e.status?e.message:'服务暂时不可用，请稍后重试'});else res.end();if(!e.status) console.error('Request failed:',e.message);}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,close:async()=>{if(server.listening) await new Promise(r=>server.close(r));store.close();}};
}
if(require.main===module){
  createApp().then(async app=>{
    if(process.argv.includes('--reset-password')){
      await app.store.resetPassword(process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD);await app.close();console.log('账号密码已更新，所有旧会话已失效');return;
    }
    const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
    app.server.listen(port,host,()=>console.log(`Quiz server listening at ${host}:${port}`));
    for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>app.close().then(()=>process.exit(0)));
  }).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={createApp};
