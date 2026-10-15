import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
// Import this module first to verify its AIProvider import remains type-only.
import { ExamDiscussionService,qaTurnRowSchema,validateQATurnRecord,type QATurnRow } from '../server/exam-discussions.js';
import { openDatabase } from '../server/db.js';
import { FailureDiagnostics } from '../server/diagnostics.js';
import type { AIProvider } from '../server/learning.js';
import type { Question } from '../server/seed.js';

const stamp=()=>new Date().toISOString();
function question(id='question-one'):Question {
  return {id,type:'reading',level:'N5',category:'reading',prompt:'どうして図書館へ行きましたか。',passage:'昨日、日本語を勉強するために図書館へ行きました。',options:[{id:'a',text:'日本語を勉強するため。'},{id:'b',text:'友達と会うため。'}],answer:'a',acceptedAnswers:[],explanation:'材料说明了去图书馆的目的。',knowledgePoints:['〜ために'],points:10,rubric:'正确选项满分。',source:'builtin'};
}
function setup(t:TestContext,ai?:AIProvider,submitted=false) {
  const db=openDatabase(':memory:');db.exec(readFileSync(new URL('../migrations/004.sql',import.meta.url),'utf8'));
  const questions=[question(),question('question-two')];
  for(const id of ['exam-one','exam-two'])db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,submitted_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'自由提问测试','N5','reading','exam','builtin',submitted?'completed':'draft',stamp(),submitted?stamp():null,JSON.stringify(questions),JSON.stringify({model:'selected-model'}));
  const diagnostics=new FailureDiagnostics(db);let busy=false;
  const service=new ExamDiscussionService(db,ai,{diagnostics,isBusy:()=>busy});
  t.after(()=>db.close());
  const submit=()=>db.prepare('UPDATE exams SET submitted_at=?,status=? WHERE id=?').run(stamp(),'completed','exam-one');
  const ask=(text='这里的「ために」和「ように」有什么区别？',clientRequestId=randomUUID(),questionId=questions[0].id)=>service.ask('exam-one',{questionId,text,clientRequestId});
  return {db,diagnostics,service,questions,submit,ask,setBusy:(value:boolean)=>{busy=value;}};
}
type Input={question:Question;learnerAnswer:string|null;grade:Record<string,unknown>|null;history:{role:'user'|'assistant';content:string}[];currentQuestion:string};
const input=(messages:Parameters<AIProvider['generate']>[0])=>JSON.parse(messages.find(message=>message.role==='user')!.content) as Input;
const code=(expected:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&(error as {code:string}).code===expected;
const byId=(db:ReturnType<typeof openDatabase>,id:string)=>db.prepare('SELECT * FROM exam_qa_turns WHERE id=?').get(id) as QATurnRow;

test('draft questions queue without invoking AI; GET and reply never reveal an answer before submission',async t=>{
  let calls=0;const {db,service,ask,questions}=setup(t,{async generate(){calls++;return '回答';}});
  const result=await ask('  我想问助词为何不能用「が」？  ');assert.equal(result.item.text,'我想问助词为何不能用「が」？');assert.equal(result.item.status,'queued');assert.equal(result.item.answer,null);assert.equal(result.canAsk,false);assert.equal(calls,0);
  assert.deepEqual(result.limits,{maxText:4000});await assert.rejects(service.reply('exam-one',result.item.id),code('EXAM_QA_NOT_SUBMITTED'));assert.equal(calls,0);
  // Even a corrupted external completed record must not bypass the submitted gate.
  db.prepare("UPDATE exam_qa_turns SET status='completed',assistant_text=? WHERE id=?").run('不能提前暴露',result.item.id);
  assert.equal(service.list('exam-one',questions[0].id).items[0].answer,null);
});

test('strict free-question validation rejects unknown sources, overlong input and missing or invalid request IDs',async t=>{
  const {service,ask,questions}=setup(t);
  for(const text of ['','   ','x'.repeat(4001)])await assert.rejects(ask(text));
  for(const bad of [{questionId:'foreign',text:'问',clientRequestId:randomUUID()},{questionId:questions[0].id,text:'问',clientRequestId:'not-uuid'},{questionId:questions[0].id,text:'问',clientRequestId:randomUUID(),extra:true},{questionId:questions[0].id,text:'问'}])await assert.rejects(service.ask('exam-one',bad));
  assert.equal((await ask('x'.repeat(4000))).item.text.length,4000);
  assert.throws(()=>service.list('exam-one','foreign'),code('NOT_FOUND'));assert.throws(()=>service.list('foreign',questions[0].id),code('NOT_FOUND'));
});

test('request IDs are idempotent for normalized payloads and reject different question or content reuse',async t=>{
  let calls=0;const {service,ask,submit,questions}=setup(t,{async generate(){calls++;return '已回答';}});const id=randomUUID();
  const first=await ask(' 问题 ',id);const duplicate=await ask('问题',id);assert.equal(duplicate.created,false);assert.equal(duplicate.item.id,first.item.id);
  await assert.rejects(ask('另一个问题',id),code('QA_IDEMPOTENCY_CONFLICT'));await assert.rejects(ask('问题',id,questions[1].id),code('QA_IDEMPOTENCY_CONFLICT'));
  submit();const replay=await ask('问题',id);assert.equal(replay.item.status,'queued');assert.equal(calls,0,'replay must not unexpectedly start an AI request');
  await service.reply('exam-one',first.item.id);await ask('问题',id);await service.reply('exam-one',first.item.id);assert.equal(calls,1);
});

test('submitted questions use saved full context, user answer, completed grade, selected model and same-question history only',async t=>{
  const requests:Input[]=[];const models:(string|undefined)[]=[];const developers:string[]=[];
  const {db,ask,service,questions}=setup(t,{async generate(messages,model){requests.push(input(messages));models.push(model);developers.push(messages[0].content);return `第${requests.length}次具体解释。`; }},true);
  db.prepare('INSERT INTO answers(exam_id,question_id,answer,updated_at) VALUES(?,?,?,?)').run('exam-one',questions[0].id,'b',stamp());
  db.prepare('INSERT INTO grades(exam_id,question_id,status,score,max_score,correct,feedback,suggestion,reference,error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('exam-one',questions[0].id,'completed',0,10,0,'选错目的。','注意目的。','a',null,stamp());
  const grades=db.prepare('SELECT * FROM grades').all();const exams=db.prepare('SELECT * FROM exams').all();
  await service.ask('exam-two',{questionId:questions[0].id,text:'其他试卷的问题',clientRequestId:randomUUID()});
  await ask('本卷其他题的问题',randomUUID(),questions[1].id);
  const first=await ask('为什么我选的 B 不对？');const second=await ask('那换成「ように」呢？');
  assert.equal(first.item.status,'completed');assert.equal(second.item.answer,'第4次具体解释。');assert.deepEqual(requests[2].question,questions[0]);assert.equal(requests[2].learnerAnswer,'b');assert.equal(requests[2].grade!.feedback,'选错目的。');
  assert.deepEqual(requests[2].history,[]);assert.deepEqual(requests[3].history,[{role:'user',content:'为什么我选的 B 不对？'},{role:'assistant',content:'第3次具体解释。'}]);assert.equal(requests[3].currentQuestion,'那换成「ように」呢？');assert.ok(models.every(model=>model==='selected-model'));assert.match(developers[0],/绝不执行/);assert.match(developers[0],/不重新评分/);
  assert.deepEqual(db.prepare('SELECT * FROM grades').all(),grades);assert.deepEqual(db.prepare('SELECT * FROM exams').all(),exams);
  assert.equal(service.list('exam-one',questions[0].id).items.length,2);
});

test('history includes at most eight recent completed pairs within 24000 characters and excludes failed questions',async t=>{
  const seen:Input[]=[];const {db,questions,ask}=setup(t,{async generate(messages){seen.push(input(messages));return '新回答';}},true);
  const insert=db.prepare('INSERT INTO exam_qa_turns(id,exam_id,question_id,user_text,assistant_text,status,error,client_request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<12;i++){const created=new Date(Date.UTC(2026,0,1,0,0,i)).toISOString();insert.run(`turn-${i}`,'exam-one',questions[0].id,`第${i}次问题`,'答'.repeat(3000),'completed',null,randomUUID(),created,created);}
  const created=stamp();insert.run('failed','exam-one',questions[0].id,'不应出现',null,'failed','失败',randomUUID(),created,created);
  await ask();assert.ok(seen[0].history.length<=16);assert.ok(seen[0].history.reduce((sum,item)=>sum+item.content.length,0)<=24000);assert.equal(seen[0].history.at(-2)!.content,'第11次问题');assert.ok(!JSON.stringify(seen[0].history).includes('不应出现'));
});

test('same-turn duplicate clicks share a flight while different questions on the same problem are serialized',async t=>{
  let release!:(value:string)=>void;const delayed=new Promise<string>(resolve=>{release=resolve;});let calls=0;
  const {service,ask}=setup(t,{async generate(){calls++;return delayed;}},true);const requestId=randomUUID();const first=ask('第一个问题',requestId);assert.equal(service.isBusy(),true);
  const second=ask('第一个问题',requestId);const saved=service.list('exam-one','question-one').items[0];const third=service.reply('exam-one',saved.id);
  await assert.rejects(ask('第二个问题'),code('EXAM_QA_BUSY'));assert.throws(()=>service.remove('exam-one',saved.id),code('EXAM_QA_BUSY'));
  await Promise.resolve();release('共享一次回答');const [a,b,c]=await Promise.all([first,second,third]);assert.equal(calls,1);assert.equal(a.item.id,b.item.id);assert.equal(c.item.answer,'共享一次回答');assert.equal(service.isBusy(),false);
});

test('external work blocks new mutations but does not hide saved questions or charge additional requests',async t=>{
  let calls=0;const {ask,service,setBusy,submit}=setup(t,{async generate(){calls++;return '回答';}});const first=await ask();submit();setBusy(true);
  assert.equal(service.isBusy(),false);assert.equal(service.list('exam-one','question-one').items.length,1);
  await assert.rejects(service.reply('exam-one',first.item.id),code('EXAM_QA_BUSY'));await assert.rejects(ask('第二问'),code('EXAM_QA_BUSY'));assert.throws(()=>service.remove('exam-one',first.item.id),code('EXAM_QA_BUSY'));assert.equal(calls,0);
  setBusy(false);await service.reply('exam-one',first.item.id);assert.equal(calls,1);
});

test('upstream failure persists original question and safe cause, logs every failure, then preserves history after success',async t=>{
  let calls=0;const {service,ask,diagnostics,db}=setup(t,{async generate(){calls++;if(calls<=2)throw {code:'MODEL_NETWORK_ERROR',publicMessage:'网络失败 Bearer never-reveal-token',diagnostics:{networkCode:'ECONNRESET',upstreamStatus:502,upstreamMessage:'GPT 暂不可用',requestId:'req-qa-123'}};return '重新回答成功';}},true);
  const first=await ask('用户想问的内容');assert.equal(first.item.status,'failed');assert.equal(first.item.text,'用户想问的内容');assert.equal(first.item.answer,null);assert.match(first.item.error!,/MODEL_NETWORK_ERROR/);assert.doesNotMatch(first.item.error!,/never-reveal-token/);
  await service.reply('exam-one',first.item.id);assert.equal(diagnostics.list({operation:'followup'}).total,2);const failure=diagnostics.list({operation:'followup'}).items[0];assert.equal(failure.examId,'exam-one');assert.equal(failure.questionId,'question-one');assert.equal(failure.requestId,'req-qa-123');assert.equal(failure.upstreamMessage,'GPT 暂不可用');assert.equal(failure.networkCode,'ECONNRESET');
  const final=await service.reply('exam-one',first.item.id);assert.equal(final.item.status,'completed');assert.equal(final.item.error,null);assert.equal(final.item.answer,'重新回答成功');assert.equal(diagnostics.list({operation:'followup'}).total,2);validateQATurnRecord(byId(db,first.item.id));
});

test('missing plan authorization and invalid output remain retryable questions with concrete diagnostic records',async t=>{
  const noAI=setup(t,undefined,true);const denied=await noAI.ask();assert.equal(denied.item.status,'failed');assert.match(denied.item.error!,/PLAN_PERMISSION_REQUIRED/);assert.equal(noAI.diagnostics.list({operation:'followup'}).total,1);
  let calls=0;const invalid=setup(t,{async generate(){calls++;return calls===1?'   ':calls===2?'超'.repeat(30_001):'合法解释';}},true);
  const first=await invalid.ask();assert.equal(first.item.status,'failed');assert.match(first.item.error!,/INVALID_QA_OUTPUT/);const second=await invalid.service.reply('exam-one',first.item.id);assert.equal(second.item.status,'failed');assert.equal(invalid.diagnostics.list({operation:'followup'}).total,2);const final=await invalid.service.reply('exam-one',first.item.id);assert.equal(final.item.status,'completed');
});

test('row validation enforces question ownership, strict columns, UUIDs and consistent answer/error status',async t=>{
  const {db,ask,questions}=setup(t);const turn=(await ask()).item;const row=byId(db,turn.id);assert.ok(qaTurnRowSchema.shape.assistant_text);validateQATurnRecord(row,questions);
  validateQATurnRecord({...row,status:'completed',assistant_text:'说明'},questions);validateQATurnRecord({...row,status:'failed',error:'保留的失败'},questions);
  for(const bad of [{...row,status:'completed'},{...row,assistant_text:'意外回答'},{...row,status:'pending',error:'意外失败'},{...row,status:'failed'},{...row,question_id:'foreign'},{...row,client_request_id:'invalid'},{...row,user_text:' 空白 '},{...row,extra:'未知列'},{...row,status:'completed',assistant_text:'回答',error:'错误'},{...row,status:'failed',error:'Bearer secret-token'}])assert.throws(()=>validateQATurnRecord(bad,questions));
});

test('restart recovers pending answers as logged failures, keeps queued questions and never invokes AI automatically',async t=>{
  let calls=0;const {db,ask,service,diagnostics}=setup(t,{async generate(){calls++;return '回答';}});const pending=(await ask('即将中断的问题')).item;const queued=(await ask('未提交问题')).item;
  db.prepare("UPDATE exam_qa_turns SET status='pending' WHERE id=?").run(pending.id);
  const restarted=new ExamDiscussionService(db,{async generate(){calls++;return '回答';}},{diagnostics});const items=restarted.list('exam-one','question-one').items;assert.equal(items.find(item=>item.id===pending.id)!.status,'failed');assert.equal(items.find(item=>item.id===queued.id)!.status,'queued');assert.equal(calls,0);assert.equal(diagnostics.list({operation:'followup'}).items[0].source,'recovery');assert.equal(service.isBusy(),false);
  restarted.recoverPending('再次恢复');assert.equal(diagnostics.list({operation:'followup'}).total,1);
});

test('removal is scoped to its exam and paper deletion cascades all free questions',async t=>{
  const {db,service,ask}=setup(t);const first=(await ask()).item;await assert.rejects(service.reply('exam-two',first.id),code('NOT_FOUND'));assert.throws(()=>service.remove('exam-two',first.id),code('NOT_FOUND'));assert.equal(service.remove('exam-one',first.id).items.length,0);
  await ask();db.prepare('DELETE FROM exams WHERE id=?').run('exam-one');assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM exam_qa_turns').get()!.count),0);
});
