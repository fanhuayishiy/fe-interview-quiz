const {test}=require('node:test');
const assert=require('node:assert/strict');
const app=require('./helpers/quiz-app.cjs');
test('new rounds shuffle each question, keep permutations stable through renders and reload',()=>{
  const a=app();a.run('startSession()');
  const s=JSON.parse(a.run('JSON.stringify(DB.session)'));
  assert.equal(Object.keys(s.optionOrders||{}).length,10);
  for(const order of Object.values(s.optionOrders))assert.deepEqual([...order].sort(),[0,1,2,3]);
  const before=a.run('JSON.stringify(DB.session.optionOrders)');
  a.run('render();viewPractice()');assert.equal(a.run('JSON.stringify(DB.session.optionOrders)'),before);
  const b=app(JSON.parse(a.memory.fe_quiz_mcq_v1));b.run("go('practice')");
  assert.equal(b.run('JSON.stringify(state.session.optionOrders)'),before);
  const orders=new Set();for(let i=0;i<16;i++){a.run('startSession({ids:[1]})');orders.add(a.run('JSON.stringify(state.session.optionOrders[1])'));}
  assert.ok(orders.size>1);
});
test('display choices map to canonical answers, explanations and keyboard shortcuts',()=>{
  const a=app();a.run('startSession({ids:[1]});state.session.optionOrders={1:[2,0,3,1]}');
  let view=a.run('viewPractice()');
  assert.match(view,/<span class="ltr">A<\/span><span class="txt">JWT 无状态/);
  a.events.keydown({key:'a',target:{tagName:'BODY'},preventDefault(){}});
  assert.equal(a.run('DB.session.picks[1]'),2);
  assert.equal(a.run('DB.seen[1].r'),1);
  view=a.run('viewPractice()');assert.match(view,/回答正确.*正确答案是 A/s);
  a.run('startSession({ids:[1]});state.session.optionOrders={1:[2,0,3,1]};pickOption(1)');
  assert.equal(a.run('DB.wrong[1].lastPick'),0);
  view=a.run('viewPractice()');assert.match(view,/class="ltr">B<\/span>.*Session 天然.*Session 是服务端存状态/s);
  a.run('nextQuestion()');view=a.run('viewResult()');
  assert.match(view,/你的选择：B\. Session 天然/);assert.match(view,/正确答案：A\. JWT 无状态/);
});
test('random single questions map choices and keep order stable on rerender',()=>{
  const a=app();a.run("state.view='random';state.randomId=1;state.randomOrder=[2,0,3,1];viewRandom()");
  a.run('pickRandom(0)');assert.equal(a.run('state.randomPick'),2);assert.equal(a.run('DB.seen[1].r'),1);
  assert.match(a.run('viewRandom()'),/回答正确.*正确答案是 A/s);
  assert.equal(a.run('JSON.stringify(state.randomOrder)'),'[2,0,3,1]');
});
test('legacy sessions keep original choice meaning',()=>{
  const a=app();a.run('startSession({ids:[1]});delete DB.session.optionOrders;save()');
  const b=app(JSON.parse(a.memory.fe_quiz_mcq_v1));b.run("go('practice');pickOption(2)");
  assert.equal(b.run('DB.session.picks[1]'),2);assert.equal(b.run('DB.seen[1].r'),1);
  assert.match(b.run('viewPractice()'),/正确答案是 C/);
});
test('seen non-wrong has one quarter weight, wrong and unseen stay equal',()=>{
  const a=app();
  const counts=JSON.parse(a.run(`JSON.stringify((()=>{
    DB.seen={2:{r:1,w:0},3:{r:0,w:1}};DB.wrong={3:{count:1,streak:0,ts:1}};
    const counts=[0,0,0];for(let i=0;i<18000;i++)counts[pickWeighted(QUESTIONS.slice(0,3),1)[0].id-1]++;
    return counts;
  })())`));
  assert.ok(counts[0]/counts[1]>3.5 && counts[0]/counts[1]<4.5,JSON.stringify(counts));
  assert.ok(counts[2]/counts[1]>3.5 && counts[2]/counts[1]<4.5,JSON.stringify(counts));
  a.run('delete DB.wrong[3]');assert.equal(a.run('questionWeight(QMAP[3])'),1);
});
test('wrong questions keep full weight until two correct answers remove them',()=>{
  const a=app();a.run('DB.seen[1]={r:0,w:1};DB.wrong[1]={count:1,streak:0,ts:1}');
  for(let i=0;i<2;i++){
    a.run('startSession({ids:[1]});pickOption(state.session.optionOrders[1].indexOf(QMAP[1].a))');
    assert.equal(a.run('questionWeight(QMAP[1])'),i===0?4:1);
  }
});
test('random single uses the same 4:1 weighting rather than excluding seen questions',()=>{
  const a=app();
  const counts=JSON.parse(a.run(`JSON.stringify((()=>{
    QUESTIONS.splice(2);DB.seen[2]={r:1,w:0};const counts=[0,0];
    for(let i=0;i<6000;i++){state.randomId=null;chooseRandomQuestion();counts[state.randomId-1]++;}
    return counts;
  })())`));
  assert.ok(counts[0]/counts[1]>3.5 && counts[0]/counts[1]<4.5,JSON.stringify(counts));
});
test('mixed practice and single random both use weighting without duplicate picks',()=>{
  const a=app();
  const counts=JSON.parse(a.run(`JSON.stringify((()=>{
    const qs=QUESTIONS.filter(q=>q.c==='TypeScript');DB.settings.excludedCats=CATS.filter(c=>c!=='TypeScript');DB.settings.count=1;
    DB.seen[qs[1].id]={r:1,w:0};let unseen=0,seen=0;
    for(let i=0;i<6000;i++){if(mixedPicks()[0].id===qs[0].id)unseen++;else seen++;}
    return {unseen,seen};
  })())`));
  assert.ok(counts.unseen/counts.seen>3.5 && counts.unseen/counts.seen<4.5,JSON.stringify(counts));
  a.run('DB.settings.excludedCats=[];DB.settings.count=196');
  assert.equal(a.run('new Set(mixedPicks().map(q=>q.id)).size'),196);
  a.run("state.randomId=null;chooseRandomQuestion();globalThis.oldRandom=state.randomId;chooseRandomQuestion()");
  assert.notEqual(a.run('state.randomId'),a.run('oldRandom'));
});
