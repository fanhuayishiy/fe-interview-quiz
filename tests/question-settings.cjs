const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');
function app(saved) {
  const events = {}, elements = {};
  const el = () => ({innerHTML:'', textContent:'', style:{}, dataset:{}, classList:{add(){},remove(){},toggle(){}}, addEventListener(){}});
  const store = saved ? {fe_quiz_mcq_v1:JSON.stringify(saved)} : {};
  const context = vm.createContext({console, Math, Date, setTimeout:()=>0, clearTimeout(){}, setInterval:()=>0, clearInterval(){},
    document:{querySelector:s=>elements[s] ||= el(), querySelectorAll:()=>[], addEventListener:(k,fn)=>events[k]=fn},
    window:{scrollTo(){},scrollY:0}, localStorage:{getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v}});
  for (const [,code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(code, context);
  return {run:code=>vm.runInContext(code,context),events,elements,store};
}
let passed=0;
function test(name,fn){try{fn();passed++;console.log('PASS',name);}catch(e){console.error('FAIL',name);throw e;}}
test('预设与自定义数量、无重复',()=>{
  const a=app();
  for(const n of [10,20,30,17,1,196]){
    a.run(`DB.settings.count=${n}`);
    assert.equal(a.run('mixedPicks().length'),n);
    assert.equal(a.run('new Set(mixedPicks().map(q=>q.id)).size'),n);
  }
});
test('排除分类、题池不足、全部不选时不创建练习',()=>{
  const a=app();
  a.run(`DB.settings.excludedCats=CATS.filter(c=>c!=='TypeScript'); DB.settings.count=30`);
  assert.equal(a.run('mixedTotal()'),2);
  assert.equal(a.run("mixedPicks().every(q=>q.c==='TypeScript')"),true);
  assert.equal(a.run('mixedPicks().length'),2);
  a.run('DB.settings.excludedCats=CATS.slice();startSession()');
  assert.equal(a.run('state.session'),null);
  assert.match(a.elements['#toast'].textContent,/至少.*类型/);
});
test('迁移旧分类设置并保留学习数据',()=>{
  const a=app({wrong:{1:{count:1}},fav:[2],settings:{count:20,catCount:{Vue:0,JavaScript:1}}});
  assert.equal(a.run("DB.settings.excludedCats.includes('Vue')"),true);
  assert.equal(a.run('mixedPicks().length'),20);
  assert.equal(a.run("mixedPicks().some(q=>q.c==='Vue')"),false);
  assert.equal(a.run('DB.fav[0]'),2);
  assert.equal(a.run('DB.wrong[1].count'),1);
});
test('自定义数量校验及持久化',()=>{
  const a=app();
  for(const v of ['',0,-1,1.5,197,'abc']){
    a.run(`setRoundCount(${JSON.stringify(v)})`);
    assert.equal(a.run('roundTotal()'),10);
  }
  a.run("setRoundCount('17'); DB.settings.excludedCats=['Vue'];save()");
  const b=app(JSON.parse(a.store.fe_quiz_mcq_v1));
  assert.equal(b.run('roundTotal()'),17);
  assert.equal(b.run("DB.settings.excludedCats.includes('Vue')"),true);
});
test('单分类练习也遵循总数，取消参与不影响单独练习',()=>{
  const a=app();
  a.run("DB.settings.count=20; DB.settings.excludedCats=['Vue'];startSession({cat:'Vue'})");
  assert.equal(a.run('state.session.ids.length'),20);
});
test('设置展示预设、自定义表单和类型勾选',()=>{
  const a=app(),view=a.run('viewSettings()');
  assert.match(view,/id="custom-count"/);
  assert.equal((view.match(/type="checkbox"/g)||[]).length,13);
  for(const n of [10,20,30]) assert.match(view,new RegExp(`data-v="${n}"`));
  assert.doesNotMatch(view,/data-action="cat-count"/);
});
test('勾选与自定义提交事件保存真实设置',()=>{
  const a=app();
  a.events.change({target:{dataset:{category:'Vue'},checked:false}});
  assert.equal(a.run("catIncluded('Vue')"),false);
  a.events.change({target:{dataset:{category:'Vue'},checked:true}});
  assert.equal(a.run("catIncluded('Vue')"),true);
  a.elements['#custom-count']={value:'23'};
  let prevented=false;
  a.events.submit({target:{id:'custom-count-form'},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  a.run('startSession()');
  assert.equal(a.run('state.session.ids.length'),23);
});
console.log(`${passed} tests passed: ${file}`);
