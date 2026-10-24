const {test}=require('node:test');
const assert=require('node:assert/strict');
const app=require('./helpers/quiz-app.cjs');
const legacy=require('./helpers/legacy-data.cjs');
const {validateData}=require('../lib/store.cjs');
test('old local records are backed up and migrated without changing learning history',()=>{
  const old=legacy(),a=app(old),current=JSON.parse(a.run('JSON.stringify(DB)'));
  for(const key of ['wrong','fav','seen','rounds','session'])assert.deepEqual(current[key],old[key]);
  assert.deepEqual(current.settings,{count:5,excludedCats:['Vue']});
  assert.deepEqual(JSON.parse(a.memory.fe_quiz_mcq_v1_before_upgrade),old);
  a.run('save()');const b=app(JSON.parse(a.memory.fe_quiz_mcq_v1));
  assert.deepEqual(JSON.parse(b.run('JSON.stringify(DB)')),current);
});
test('cloud replacement normalizes old data through the same path as local startup',()=>{
  const a=app(),old=legacy();
  a.run(`window.QuizApp.replaceData(${JSON.stringify(old)})`);
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(DB.settings)')),{count:5,excludedCats:['Vue']});
  assert.equal(a.run('questionWeight(QMAP[1])'),1);assert.equal(a.run('questionWeight(QMAP[3])'),4);
  a.run("go('practice');pickOption(QMAP[2].a);nextQuestion()");
  assert.equal(a.run('DB.session.picks[1]'),2);
  assert.equal(a.run('DB.session.picks[2]'),a.run('QMAP[2].a'));
  assert.equal(a.run('DB.rounds.at(-1).correct'),2);
});
test('legacy files and optional missing fields normalize before strict validation',()=>{
  const a=app(),questions=JSON.parse(a.run('JSON.stringify(QUESTIONS)')),old=legacy();
  const wrapped={format:'fe-quiz-backup-v1',exportedAt:'2026-10-20T00:00:00.000Z',data:old};
  assert.deepEqual(validateData(wrapped,questions),validateData(old,questions));
  const sparse=validateData({fav:[1],seen:{1:{r:2}},wrong:{2:{count:1}},settings:{catCount:{Vue:0}}},questions);
  assert.deepEqual(sparse.seen,{1:{r:2,w:0}});assert.deepEqual(sparse.wrong,{2:{count:1,streak:0,ts:0}});
  assert.deepEqual(sparse.settings,{count:10,excludedCats:['Vue']});assert.equal(sparse.session,null);
  assert.throws(()=>validateData({unrelated:'file'},questions));
  assert.throws(()=>validateData({seen:{1:{r:-1,w:0}}},questions));
});
test('a full local cache cannot turn a failed upgrade backup into empty learning history',()=>{
  const old=legacy(),a=app(old,{failBackup:true}),current=JSON.parse(a.run('JSON.stringify(DB)'));
  for(const key of ['wrong','fav','seen','rounds','session'])assert.deepEqual(current[key],old[key]);
  assert.deepEqual(JSON.parse(a.memory.fe_quiz_mcq_v1),old);
});
test('legacy all-zero category quotas stay excluded with a valid round count',()=>{
  const old=legacy();old.settings={count:0,catCount:{Vue:0,JavaScript:0}};
  const a=app(old),questions=JSON.parse(a.run('JSON.stringify(QUESTIONS)'));
  const converted=validateData(old,questions);
  assert.deepEqual(converted.settings,{count:10,excludedCats:['Vue','JavaScript']});
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(DB.settings)')),converted.settings);
});
