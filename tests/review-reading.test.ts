import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { LearningService, type AIProvider } from '../server/learning.js';

function setup(t:TestContext,ai?:AIProvider){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const service=new LearningService(db,ai);
  function point(title:string,kind:'word'|'grammar'|'expression'='word',reading=''){
    const added=service.reviews.add({text:title,level:'N5'}).item;
    return service.reviews.confirm(added.id,{title,kind,reading,meaning:'测试含义',focus:'结合语境识别词义和读音。',note:''}).item;
  }
  return {db,service,point};
}

test('reading selection filters kana-only words and grammar before its count limit, without changing the general review queue',t=>{
  const {service,point}=setup(t);
  const kana=point('ほとんど'),grammar=point('気がする','grammar'),expression=point('お世話になる','expression','おせわになる'),word=point('済む','word','すむ');
  const all=service.reviews.choose({level:'N5',count:40});assert.equal(all.length,4);
  const readings=service.reviews.choose({level:'N5',count:1,readingOnly:true});assert.equal(readings.length,1);assert.equal(readings[0].id,expression.id);
  assert.deepEqual(new Set(service.reviews.choose({level:'N5',count:40,readingOnly:true}).map(item=>item.id)),new Set([expression.id,word.id]));
  assert.throws(()=>service.reviews.choose({level:'N5',count:2,ids:[word.id,kana.id],readingOnly:true}),{code:'INVALID_READING_REVIEW_SELECTION'});
  assert.throws(()=>service.reviews.choose({level:'N5',count:1,ids:[grammar.id],readingOnly:true}),{code:'INVALID_READING_REVIEW_SELECTION'});
  assert.equal(service.reviews.choose({level:'N5',count:1,ids:[grammar.id]})[0].id,grammar.id,'general review can still select grammar');
});

test('reading auto selection remains due-only while manual mastered selections do not alter review progress',t=>{
  const {service,point}=setup(t),word=point('学校','word','がっこう');
  service.reviews.rate(word.id,{rating:'good',requestId:randomUUID()});
  assert.throws(()=>service.reviews.choose({level:'N5',count:1,readingOnly:true}),{code:'NO_DUE_REVIEW_POINTS'});
  service.reviews.rate(word.id,{rating:'mastered',requestId:randomUUID()});
  const before=service.reviews.get(word.id);assert.equal(before.dueAt,null);
  const selected=service.reviews.choose({level:'N5',count:1,ids:[word.id],readingOnly:true});assert.equal(selected[0].status,'mastered');
  assert.deepEqual(service.reviews.get(word.id),before);
});

test('a single-kana target accepts normal particles in its context but rejects an explicitly exposed parenthetical reading',async t=>{
  let expose=false,calls=0;
  const {service,point,db}=setup(t,{async generate(messages){calls++;const payload=JSON.parse(messages[1].content);return JSON.stringify({questions:[{type:'fill',prompt:expose?'彼は「葉（は）」の読みを書いてください。':'彼は葉を拾います。「葉」の読みを書いてください。',answer:'は',acceptedAnswers:['は','ハ'],explanation:'「葉」读作「は」。',knowledgePoints:['葉の読音'],points:10,rubric:'填写准确假名。',reviewPointIds:[payload.reviewPoints[0].id]}]});}});
  const word=point('葉','word','は');
  const created=await service.createReviewExam({level:'N5',count:1,pointIds:[word.id],reviewFocus:'reading',mode:'exam'});
  const exam=service.getExam(created.id);assert.equal(exam.questions.length,1);assert.equal(calls,1);
  service.saveAnswers(created.id,{[String(exam.questions[0].id)]:'ハ'});const submitted=await service.submit(created.id);assert.equal(submitted.score,10);
  expose=true;
  await assert.rejects(()=>service.createReviewExam({level:'N5',count:1,pointIds:[word.id],reviewFocus:'reading'}),{code:'INVALID_MODEL_OUTPUT'});
  assert.equal(calls,3,'an exposed reading gets the same one-repair limit as other invalid model output');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n),1,'no exposed paper is saved');
});

test('general review also hides readings embedded in focus and question labels until feedback or submission',async t=>{
  const {service,point}=setup(t,{async generate(messages){const payload=JSON.parse(messages[1].content);return JSON.stringify({questions:[{type:'fill',prompt:'「済む」の読みを書いてください。',answer:'すむ',acceptedAnswers:['すむ'],explanation:'「済む」读作「すむ」，表示完成。',knowledgePoints:['済む（すむ）の読み'],points:10,rubric:'填写准确假名。',reviewPointIds:[payload.reviewPoints[0].id]}]});}});
  const word=point('済む','word','すむ');service.reviews.update(word.id,{focus:'済む（すむ）的整体用法。'});
  const created=await service.createReviewExam({level:'N5',count:1,types:['fill'],pointIds:[word.id],mode:'practice'});
  const exam=service.getExam(created.id);assert.equal(exam.reviewFocus,'general');assert.equal(exam.reviewPoints[0].title,'済む');assert.equal(exam.reviewPoints[0].focus,'交卷后查看复习要点');assert.equal(exam.reviewPoints[0].reading,undefined);assert.deepEqual(exam.questions[0].knowledgePoints,['重点复习']);
  service.saveAnswers(created.id,{[String(exam.questions[0].id)]:'すむ'});const feedback=await service.feedback(created.id,String(exam.questions[0].id));
  assert.deepEqual(feedback.questions[0].knowledgePoints,['済む（すむ）の読み']);assert.equal(feedback.questions[0].answer,'すむ');assert.equal(feedback.reviewPoints[0].reading,undefined);
  const submitted=await service.submit(created.id);assert.equal(submitted.reviewPoints[0].reading,'すむ');assert.equal(submitted.reviewPoints[0].focus,'済む（すむ）的整体用法。');
});
