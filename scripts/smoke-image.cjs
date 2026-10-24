// Also runs under QEMU on CI to validate the exact target-architecture image.
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomBytes}=require('node:crypto');
const assert=require('node:assert/strict');
const exec=promisify(execFile),image=process.argv[2];
if(!/^fe-interview-quiz:git-[a-f0-9]{40}$/.test(image||''))throw new Error('Pass the target image tag');
const name=`quiz-smoke-${process.pid}`,volume=`${name}-data`,password=randomBytes(20).toString('hex');
const docker=(...args)=>exec('docker',args,{maxBuffer:1024*1024});
async function main(){
  try{
    await docker('volume','create',volume);
    await docker('run','-d','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:size=16m,mode=1777',
      '--mount',`type=volume,source=${volume},target=/app/data`,'-p','127.0.0.1::3000',
      '-e','ADMIN_USERNAME=ci','-e',`ADMIN_PASSWORD=${password}`,'-e','PUBLIC_URL=http://localhost','-e','COOKIE_SECURE=false',image);
    let address=(await docker('port',name,'3000/tcp')).stdout.trim().split('\n')[0];
    async function ready(){
      for(let i=0;i<60;i++){
        try{if((await fetch(`http://${address}/healthz`,{signal:AbortSignal.timeout(2000)})).ok)return;}catch{}
        await new Promise(r=>setTimeout(r,1000));
      }
      throw new Error('Target image did not become healthy');
    }
    await ready();
    const login=await fetch(`http://${address}/api/login`,{method:'POST',headers:{'Content-Type':'application/json','X-Quiz-Request':'1'},body:JSON.stringify({username:'ci',password})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const data={wrong:{},fav:[1],seen:{1:{r:1,w:0}},rounds:[],session:null,settings:{count:10,excludedCats:[]}};
    const save=await fetch(`http://${address}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json','X-Quiz-Request':'1',Cookie:cookie},body:JSON.stringify({revision:0,data})});
    assert.equal(save.status,200);
    await docker('restart',name);
    // Docker may allocate a different ephemeral host port on restart.
    address=(await docker('port',name,'3000/tcp')).stdout.trim().split('\n')[0];
    await ready();
    const saved=await fetch(`http://${address}/api/state`,{headers:{Cookie:cookie}});
    assert.equal(saved.status,200);assert.deepEqual((await saved.json()).data,data);
    console.log('PASS target architecture: login, SQLite save and restart persistence');
  }catch(error){
    const state=await docker('inspect','--format','{{json .State}}',name).catch(()=>({stdout:'Container unavailable'}));
    const logs=await docker('logs','--tail','50',name).catch(e=>({stdout:e.stdout||'',stderr:e.stderr||''}));
    console.error('Target container state:',state.stdout.trim());
    console.error('Target container logs:',logs.stdout||logs.stderr||'(empty)');
    throw error;
  }finally{
    await docker('rm','-f',name).catch(()=>{});await docker('volume','rm',volume).catch(()=>{});
  }
}
main().catch(error=>{console.error(error.stderr||error.message);process.exitCode=1;});
