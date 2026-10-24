const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
module.exports=function app(saved,options={}){
  const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8'),events={},elements={};
  const stub=()=>({innerHTML:'',textContent:'',style:{},dataset:{},classList:{add(){},remove(){},toggle(){},contains(){return false;}},addEventListener(){}});
  const memory=saved?{fe_quiz_mcq_v1:JSON.stringify(saved)}:{};
  const seededMath=Object.create(Math);let seed=123456789;
  seededMath.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const context=vm.createContext({console,Math:seededMath,Date,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},
    document:{querySelector:s=>elements[s] ||= stub(),querySelectorAll:()=>[],addEventListener:(name,fn)=>events[name]=fn},
    window:{scrollTo(){},scrollY:0},localStorage:{getItem:k=>memory[k]||null,setItem:(k,v)=>{if(options.failBackup && k.endsWith('_before_upgrade'))throw new Error('Quota exceeded');memory[k]=v;}}});
  for(const [,code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(code,context);
  return {run:code=>vm.runInContext(code,context),events,elements,memory};
};
