const {version}=require('../package.json');
const escape=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function releaseInfo(html,options={}){
  const fallback=html.match(/id="release-updated-at" datetime="([^"]+)"/)[1];
  const requested=options.updatedAt||process.env.APP_UPDATED_AT||fallback;
  const date=new Date(Number.isFinite(Date.parse(requested))?requested:fallback);
  const requestedRevision=options.revision||process.env.APP_REVISION||'';
  const revision=/^[a-f0-9]{40}$/i.test(requestedRevision)?requestedRevision.toLowerCase():null;
  const updatedAtText=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date).replaceAll('/','-');
  return {version,revision,updatedAt:date.toISOString(),updatedAtText};
}
function renderRelease(html,info){
  const label='v'+info.version+(info.revision?' · '+info.revision.slice(0,7):'');
  return html.replace(/(<span id="release-version">)[\s\S]*?(<\/span>)/,(_,start,end)=>start+escape(label)+end)
    .replace(/<time id="release-updated-at" datetime="[^"]*">[\s\S]*?<\/time>/,
      '<time id="release-updated-at" datetime="'+escape(info.updatedAt)+'">'+escape(info.updatedAtText)+'（北京时间）</time>');
}
module.exports={releaseInfo,renderRelease};
