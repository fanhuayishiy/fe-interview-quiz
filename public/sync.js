(function(){
  'use strict';
  const app=window.QuizApp;
  if(!app || !window.QuizSyncEngine)return;
  const shell=document.querySelector('.app');
  const bar=document.createElement('div');bar.className='cloud-bar';
  const gate=document.createElement('div');gate.className='cloud-gate';
  const upload=document.createElement('input');upload.type='file';upload.accept='.json,application/json';upload.hidden=true;
  document.body.append(bar,gate,upload);
  let username='',loginError='',timer,dialogMode='',candidate=null,uiBusy=false;
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(path,method='GET',data){
    let response;
    try{response=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Quiz-Request':'1'},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(15000)});}
    catch{throw new Error('连接中断，未上传记录保留在本机，将自动重试');}
    let payload;
    try{payload=await response.json();}catch{throw new Error('服务器响应异常，请检查部署配置');}
    if(!response.ok)throw Object.assign(new Error(payload.error||'请求失败'),{status:response.status,payload});
    return payload;
  }
  const engine=new window.QuizSyncEngine({api,storage:localStorage,getData:app.getData,setData:app.replaceData,onUpdate:draw});
  window.quizSync={blocked:()=>Boolean(engine.gate||dialogMode),changed(){engine.changed();clearTimeout(timer);timer=setTimeout(()=>engine.flush(),500);}};
  function summary(data){
    if(!data)return '暂无刷题记录';
    return `${Object.keys(data.seen||{}).length} 道已练 · ${Object.keys(data.wrong||{}).length} 道错题 · ${(data.fav||[]).length} 道收藏`;
  }
  function content(title,text,body){
    return `<section class="cloud-card" role="dialog" aria-modal="true" aria-labelledby="cloud-title"><div class="cloud-logo">FE</div><h1 id="cloud-title">${title}</h1><p class="cloud-description">${text}</p>${body}</section>`;
  }
  function button(action,label,primary=false){return `<button type="button" data-cloud="${action}" class="btn ${primary?'primary':'ghost'}">${label}</button>`;}
  function draw(){
    bar.innerHTML=`<span class="cloud-user">${escape(username||'个人刷题空间')}</span><span class="cloud-status" role="status">${escape(engine.status)}${engine.storageError?' · 本机缓存不可用，请保持页面打开直至保存成功':''}</span><div class="cloud-tools">${button('retry','立即同步')}${button('import','导入旧记录')}${button('backup','本机备份')}${button('logout','退出登录')}</div>`;
    const mode=dialogMode||engine.gate||'';
    bar.hidden=!!mode;
    gate.hidden=!mode;shell.inert=!!mode;document.body.classList.add('cloud-enabled');
    if(!mode){gate.innerHTML='';return;}
    if(mode==='login'){
      // Preserve focus and typed credentials when background sync finishes.
      if(gate.dataset.mode==='login' && gate.querySelector('form')){
        gate.querySelector('[role="alert"]').textContent=loginError;return;
      }
      gate.innerHTML=content('登录个人刷题空间','登录后自动保存进度，换设备也能接着练。',`
        <form id="cloud-login">
          <label for="cloud-username">用户名</label><input id="cloud-username" name="username" autocomplete="username" required maxlength="80">
          <label for="cloud-password">密码</label><input id="cloud-password" name="password" type="password" autocomplete="current-password" required maxlength="256">
          <p class="cloud-error" role="alert">${escape(loginError)}</p><button class="btn primary" type="submit">登录</button>
        </form><p class="cloud-caption">仅限个人账号，不开放注册。</p>`);
    }else if(mode==='loading'){
      gate.innerHTML=content('正在连接个人空间','正在读取服务器上的刷题记录，请稍候。','');
    }else if(mode==='migrate'){
      gate.innerHTML=content('导入本机刷题记录','服务器还没有记录，发现这个浏览器里保存过刷题数据。',`
        <div class="cloud-summary">${escape(summary(app.getData()))}</div><div class="cloud-actions">${button('use-local','导入并继续',true)}${button('use-remote','从空白记录开始')}</div>`);
    }else if(mode==='conflict'){
      gate.innerHTML=content('选择要保留的记录','服务器和本机记录不同，暂未覆盖任何一份。建议先下载本机副本。',`
        <div class="cloud-summary">本机：${escape(summary(app.getData()))}<br>服务器：${escape(summary(engine.remote?.data))}</div>
        <div class="cloud-actions">${button('use-remote','使用服务器记录',true)}${button('export','下载本机副本')}${button('use-local','用本机记录覆盖服务器')}</div>`);
    }else if(mode==='import'){
      gate.innerHTML=content('导入旧记录','导入会替换当前账号的全部刷题数据。当前记录会备份在本机，也可以先下载副本。',`
        <div class="cloud-summary">将导入：${escape(summary(candidate))}</div><div class="cloud-actions">${button('confirm-import','确认导入并替换',true)}${button('export','下载当前记录')}${button('cancel-import','取消')}</div>`);
    }else{
      gate.innerHTML=content('暂时无法同步',escape(engine.status),`<div class="cloud-actions">${button('reconnect','重新连接',true)}${button('export','下载本机记录')}${engine.remote?button('use-remote','使用服务器记录'):''}</div>`);
    }
    gate.dataset.mode=mode;
  }
  async function connect(){
    try{const me=await api('/api/me');username=me.username;loginError='';await engine.connect();}
    catch(e){engine.gate=e.status===401?'login':'offline';engine.status=e.message;draw();}
  }
  document.addEventListener('submit',async e=>{
    if(e.target.id!=='cloud-login')return;
    e.preventDefault();if(uiBusy)return;uiBusy=true;
    const form=e.target,button=form.querySelector('button');button.disabled=true;button.textContent='正在登录…';
    try{
      const input=new FormData(form);
      const me=await api('/api/login','POST',{username:input.get('username'),password:input.get('password')});
      username=me.username;loginError='';form.reset();await engine.connect();
    }catch(error){loginError=error.message;engine.gate='login';draw();}
    finally{uiBusy=false;if(button.isConnected){button.disabled=false;button.textContent='登录';}}
  });
  document.addEventListener('click',async e=>{
    const action=e.target.closest('[data-cloud]')?.dataset.cloud;if(!action || uiBusy)return;
    uiBusy=true;
    try{
      switch(action){
        case 'retry':await engine.refresh();break;
        case 'reconnect':await connect();break;
        case 'export':app.exportRecords();break;
        case 'backup':{
          const backup=engine.read('quiz_cloud_backup_v1');
          if(backup?.data)app.exportRecords(backup.data);else alert('暂无本机备份。覆盖或导入记录前会自动备份。');
          break;
        }
        case 'use-local':
          if(engine.gate==='conflict' && !confirm('确定用本机记录替换服务器记录？建议先下载本机副本，并确认服务器记录不再需要。'))break;
          await engine.useLocal();break;
        case 'use-remote':await engine.useRemote();break;
        case 'import':await engine.flush();if(!engine.gate){upload.value='';upload.click();}break;
        case 'confirm-import':{const data=candidate;dialogMode='';candidate=null;await engine.importData(data);break;}
        case 'cancel-import':dialogMode='';candidate=null;draw();break;
        case 'logout':
          await engine.flush();
          if(engine.dirty && !confirm('还有尚未上传的记录，已暂存在本机。仍要退出登录吗？'))break;
          await api('/api/logout','POST',{});username='';engine.gate='login';engine.status='已退出登录';draw();break;
      }
    }catch(error){if(error.status===401){engine.gate='login';draw();}else alert(error.message);}
    finally{uiBusy=false;}
  });
  upload.addEventListener('change',async()=>{
    const file=upload.files[0];if(!file)return;
    try{
      if(file.size>1024*1024)throw new Error('记录文件不能超过 1 MB');
      const parsed=JSON.parse(await file.text());
      const validated=await api('/api/validate','POST',parsed.format==='fe-quiz-backup-v1'?parsed.data:parsed);
      candidate=validated.data;dialogMode='import';draw();
    }catch(error){alert(error.message);}
  });
  window.addEventListener('online',()=>engine.gate==='offline'?connect():engine.refresh());
  window.addEventListener('focus',()=>engine.refresh());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')engine.flush();else engine.refresh();});
  window.addEventListener('beforeunload',e=>{if(engine.dirty){e.preventDefault();e.returnValue='';}});
  setInterval(()=>engine.gate==='offline'?connect():engine.refresh(),15000);
  draw();connect();
})();
