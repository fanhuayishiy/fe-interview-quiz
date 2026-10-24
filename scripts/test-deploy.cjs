// Run on a Linux CI runner with Docker; uses disposable containers and volumes.
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {mkdtemp,writeFile,copyFile,readFile,mkdir,rm,readdir}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {createHash,randomBytes}=require('node:crypto');
const assert=require('node:assert/strict');
const exec=promisify(execFile),repo=resolve(__dirname,'..');
const base=process.argv[2];
if(!/^fe-interview-quiz:git-[a-f0-9]{40}$/.test(base||''))throw new Error('Pass the CI image tag');
const run=(cmd,args,options={})=>exec(cmd,args,{maxBuffer:4*1024*1024,...options});
const docker=(...args)=>run('docker',args);
async function main(){
  const root=await mkdtemp(join(tmpdir(),'quiz-deploy-'));
  const project=`quiz-ci-${process.pid}`,volume=`${project}-data`,otherVolume=`${project}-other`,proxyNetwork=`${project}-proxy`;
  const password=randomBytes(20).toString('hex');
  const env=`ADMIN_USERNAME=ci\nADMIN_PASSWORD=${password}\nPUBLIC_URL=http://localhost\nCOOKIE_SECURE=false\nQUIZ_PORT=0\nCOMPOSE_PROJECT_NAME=${project}\nQUIZ_DATA_VOLUME=${volume}\n`;
  const good='a'.repeat(40),bad='b'.repeat(40),mismatch='c'.repeat(40);
  async function packageRelease(revision,image){
    const dir=join(root,'releases',revision);await mkdir(dir,{recursive:true});
    await copyFile(join(repo,'compose.production.yaml'),join(dir,'compose.production.yaml'));
    await docker('tag',image,`fe-interview-quiz:git-${revision}`);
    // gzip is not necessary here: Docker accepts an uncompressed archive too.
    await docker('save','--output',join(dir,'image.tar.gz'),`fe-interview-quiz:git-${revision}`);
    return createHash('sha256').update(await readFile(join(dir,'image.tar.gz'))).digest('hex');
  }
  async function deploy(revision,sum){return run('bash',[join(repo,'scripts/deploy.sh'),root,revision,sum],{env:{...process.env,QUIZ_HEALTH_ATTEMPTS:'3'}});}
  async function container(){return (await docker('ps','-q','--filter',`label=com.docker.compose.project=${project}`,'--filter','label=com.docker.compose.service=quiz')).stdout.trim();}
  async function request(path,method='GET',body,cookie){
    const id=await container(),address=(await docker('port',id,'3000/tcp')).stdout.trim().split('\n')[0];
    return fetch(`http://${address}${path}`,{method,headers:{'Content-Type':'application/json','X-Quiz-Request':'1',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  async function proxyReachable(){
    await docker('run','--rm','--network',proxyNetwork,'--entrypoint','node',base,'-e',
      'fetch("http://quiz:3000/healthz",{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))');
  }
  try{
    await docker('volume','create',volume);await writeFile(join(root,'.env'),env,{mode:0o600});
    const sum=await packageRelease(good,base);await deploy(good,sum);
    const login=await request('/api/login','POST',{username:'ci',password});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const state={wrong:{},fav:[1],seen:{1:{r:1,w:0}},rounds:[],session:null,settings:{count:10,excludedCats:[]}};
    assert.equal((await request('/api/state','PUT',{revision:0,data:state},cookie)).status,200);
    await docker('restart',await container());
    for(let i=0;i<20;i++){
      try{if((await request('/healthz')).ok)break;}catch{}
      await new Promise(r=>setTimeout(r,500));
    }
    assert.deepEqual((await (await request('/api/state','GET',undefined,cookie)).json()).data,state);
    console.log('PASS Docker image, volume permissions, login, save and restart persistence');
    await docker('network','create',proxyNetwork);
    await docker('network','connect','--alias','quiz',proxyNetwork,await container());
    await proxyReachable();

    // Successful updates must keep proxy networking as well as data.
    const update='d'.repeat(40),updateSum=await packageRelease(update,base);
    await deploy(update,updateSum);await proxyReachable();
    assert.deepEqual((await (await request('/api/state','GET',undefined,cookie)).json()).data,state);
    console.log('PASS successful update preserves proxy network and service alias');

    await writeFile(join(root,'Dockerfile.bad'),`FROM ${base}\nCMD ["node", "-e", "process.exit(1)"]\n`);
    await docker('build','--tag',`${project}:bad`,'--file',join(root,'Dockerfile.bad'),root);
    const badSum=await packageRelease(bad,`${project}:bad`);
    await assert.rejects(()=>deploy(bad,badSum));
    await proxyReachable();
    assert.deepEqual((await (await request('/api/state','GET',undefined,cookie)).json()).data,state);
    assert.equal(await readFile(join(root,'.env'),'utf8'),env);
    assert.equal((await readFile(join(root,'.current-release'),'utf8')).trim(),'d'.repeat(40));
    assert.ok((await readdir(join(root,'backups'))).length>=2);
    console.log('PASS failed update rolls back original image without resetting progress or credentials');

    await docker('volume','create',otherVolume);
    await writeFile(join(root,'.env'),env.replace(`QUIZ_DATA_VOLUME=${volume}`,`QUIZ_DATA_VOLUME=${otherVolume}`));
    const mismatchSum=await packageRelease(mismatch,base);
    const before=await container();await assert.rejects(()=>deploy(mismatch,mismatchSum));assert.equal(await container(),before);
    assert.deepEqual((await (await request('/api/state','GET',undefined,cookie)).json()).data,state);
    console.log('PASS changing the configured data volume is refused before stopping the existing service');
  }finally{
    const ids=(await docker('ps','-aq','--filter',`label=com.docker.compose.project=${project}`).catch(()=>({stdout:''}))).stdout.trim().split(/\s+/).filter(Boolean);
    if(ids.length)await docker('rm','-f',...ids).catch(()=>{});
    await docker('volume','rm',volume,otherVolume).catch(()=>{});
    await docker('network','rm',proxyNetwork,`${project}_default`).catch(()=>{});
    // Only a directory created by mkdtemp above is removed.
    assert.ok(root.startsWith(join(tmpdir(),'quiz-deploy-')));
    await rm(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.stderr||error.message);process.exitCode=1;});
