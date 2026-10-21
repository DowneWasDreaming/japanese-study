import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join,resolve,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { LearningService,validateBackup,type AIProvider } from '../server/learning.js';
import { FailureDiagnostics, classifyFailure } from '../server/diagnostics.js';
import { DataManagementService } from '../server/learning-management.js';

function setup(t:TestContext,ai?:AIProvider){
  const directory=mkdtempSync(join(tmpdir(),'japanese-diagnostics-'));
  const db=openDatabase(':memory:');seedDatabase(db);
  const service=new LearningService(db,ai,{backupDir:join(directory,'backups')});
  t.after(()=>{db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  return {db,service,diagnostics:service.diagnostics};
}
const upstreamError=()=>Object.assign(new Error('上游服务拒绝请求。'),{code:'subscription_sharing_usage_limit_exceeded',status:429,diagnostics:{upstreamStatus:429,upstreamMessage:'Usage exhausted for this account.',requestId:'req-test-1',responseId:'resp-test-1',stage:'response-http',model:'selected-model',reason:'usage_limit'}});
async function paper(service:LearningService){
  const {id}=await service.createExam({source:'builtin',level:'N5',count:1,types:['single'],gradingMode:'ai'});
  const full=JSON.parse(String(service.db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json))[0];
  service.saveAnswers(id,{[full.id]:full.answer});return {id,q:full};
}

test('every failed grading attempt appends official details and a later successful retry preserves both failures',async t=>{
  let calls=0;const {service,diagnostics}=setup(t,{async generate(){calls++;if(calls<=2)throw upstreamError();return JSON.stringify({score:10,feedback:'回答正确。',suggestion:'',reference:'正确选项。'});}});
  const {id,q}=await paper(service);
  await service.submit(id);await service.submit(id,true);
  const history=diagnostics.list({examId:id,operation:'grade'});
  assert.equal(history.total,2);assert.notEqual(history.items[0].id,history.items[1].id);
  for(const item of history.items){assert.equal(item.questionId,q.id);assert.equal(item.category,'quota');assert.equal(item.upstreamStatus,429);assert.equal(item.httpStatus,429);assert.equal(item.requestId,'req-test-1');assert.equal(item.upstreamMessage,'Usage exhausted for this account.');assert.equal(item.model,'selected-model');assert.equal(item.responseId,'resp-test-1');assert.match(item.detail!,/usage_limit/);assert.equal(item.source,'live');assert.ok(!Number.isNaN(Date.parse(item.createdAt)));}
  await service.submit(id,true);assert.equal(service.getExam(id).grades[q.id].status,'completed');assert.equal(diagnostics.list({examId:id}).total,2);
});

test('diagnostics redact credentials and identify exact invalid model fields without saving the invalid input',t=>{
  const {diagnostics}=setup(t);
  diagnostics.record(new Error('invalid response {"refresh_token":"opaque-private-refresh","password":"private-password"} https://auth.openai.com/test?code=private-code'),{operation:'auth'});
  diagnostics.record(Object.assign(new Error('Network ETIMEDOUT access_token=token-private user@example.com Bearer confidential-secret'),{code:'MODEL_NETWORK_ERROR',status:502,diagnostics:{networkCode:'ETIMEDOUT',upstreamMessage:'api_key=sk-abcdef123456 Bearer hidden-token',detail:'refresh_token="secret"',stage:'response-stream'}}),{operation:'connection'});
  const parsed=z.object({score:z.number(),reading:z.enum(['valid']),examples:z.array(z.string()).min(1)}).safeParse({score:'USER_ANSWER_PRIVATE',reading:'RAW_PRIVATE_ENUM',examples:[]});
  assert.equal(parsed.success,false);if(!parsed.success)diagnostics.record(parsed.error,{operation:'grade'});
  const serialized=JSON.stringify(diagnostics.list());
  for(const secret of ['token-private','user@example.com','confidential-secret','abcdef123456','hidden-token','"secret"','USER_ANSWER_PRIVATE','RAW_PRIVATE_ENUM','opaque-private-refresh','private-password','private-code'])assert.ok(!serialized.includes(secret),secret);
  const validation=diagnostics.list({category:'validation'}).items[0];assert.match(validation.detail!,/score: invalid_type; expected number; received type string/);assert.match(validation.detail!,/reading: invalid_enum_value/);assert.match(validation.detail!,/examples: too_small; minimum 1/);
  const network=diagnostics.list({category:'network'}).items[0];assert.equal(network.networkCode,'ETIMEDOUT');assert.equal(network.stage,'response-stream');assert.match(network.message,/ETIMEDOUT/);
  for(const code of ['MODEL_STREAM_INVALID','MODEL_OUTPUT_INVALID','MODEL_COMPLETION_INVALID','MODEL_CATALOG_INVALID','MODEL_OUTPUT_TOO_LARGE'])assert.equal(classifyFailure(code,200,null),'validation');
});

test('annotation grouped failures have their own persistent retry history and never change scores',async t=>{
  const {service,diagnostics}=setup(t,{async generate(){throw upstreamError();}});
  const {id}=await service.createExam({source:'builtin',count:1,types:['reading'],gradingMode:'mixed'});
  const q=service.getExam(id).questions[0];
  for(const source of ['prompt','passage'] as const){const text=String(q[source]);service.annotations.add(id,{questionId:q.id,source,start:0,end:3,text:text.slice(0,3)});}
  await service.submit(id);const score=service.getExam(id).score;
  await service.annotations.explain(id);await service.annotations.explain(id,{retryFailedOnly:true});
  const history=diagnostics.list({examId:id,operation:'annotation'});assert.equal(history.total,2);for(const row of history.items)assert.equal(row.annotationIds.length,2);
  assert.equal(service.getExam(id).score,score);
});

test('inline grading and annotation validation errors identify invalid output rather than blaming network or permission',async t=>{
  const {service,diagnostics}=setup(t,{async generate(messages){
    const input=JSON.parse(messages.at(-1)!.content);
    return input.marks?JSON.stringify({explanations:input.marks.map((mark:{id:string})=>({id:mark.id,reading:'にほんご',meaning:'意思。',analysis:'分析。',examples:[],tip:'提示。'}))}):JSON.stringify({score:'PRIVATE_INVALID_SCORE',feedback:'说明。',suggestion:'建议。',reference:'参考。'});
  }});
  const {id,q}=await paper(service);await service.submit(id);
  const error=service.getExam(id).grades[q.id].error;assert.match(String(error),/评分字段/);assert.doesNotMatch(String(error),/检查连接|套餐权限/);
  service.annotations.add(id,{questionId:q.id,source:'prompt',start:0,end:2,text:q.prompt.slice(0,2)});
  const marks=await service.annotations.explain(id);assert.match(marks.items[0].error!,/词句解析字段/);assert.doesNotMatch(marks.items[0].error!,/检查连接|套餐权限/);
  assert.equal(diagnostics.list({category:'validation'}).total,2);assert.ok(!JSON.stringify(diagnostics.list()).includes('PRIVATE_INVALID_SCORE'));
});

test('legacy import is idempotent, preserves original timestamp and marks every old failed annotation as an incomplete snapshot',async t=>{
  const {db,service}=setup(t);const {id,q}=await paper(service);await service.submit(id);
  db.exec('DELETE FROM ai_failures');
  const oldTime='2026-10-13T07:03:04.000Z';db.prepare('UPDATE grades SET error=?,updated_at=? WHERE exam_id=?').run('达到本地请求次数限制，请稍后重试。',oldTime,id);
  for(const start of [0,1]){const mark=service.annotations.add(id,{questionId:q.id,source:'prompt',start,end:start+1,text:q.prompt.slice(start,start+1)});db.prepare("UPDATE exam_annotations SET status='failed',error=?,updated_at=? WHERE id=?").run('模型响应中断。（MODEL_STREAM_INTERRUPTED）',oldTime,mark.item.id);}
  const first=new FailureDiagnostics(db);const again=new FailureDiagnostics(db);
  assert.equal(first.list().total,3);assert.equal(again.list().total,3);
  for(const row of again.list().items){assert.equal(row.source,'legacy');assert.equal(row.createdAt,oldTime);assert.equal(row.upstreamMessage,null);assert.equal(row.upstreamStatus,null);assert.match(row.detail!,/不是完整重试历史/);}
  assert.equal(again.list({operation:'grade'}).items[0].code,'LOCAL_REQUEST_LIMIT');
});

test('startup recovers only pending work and records interruptions once without overwriting old failures',async t=>{
  const {db,service}=setup(t);const {id,q}=await paper(service);await service.submit(id);
  db.prepare("UPDATE grades SET status='pending',error=NULL WHERE exam_id=?").run(id);
  const mark=service.annotations.add(id,{questionId:q.id,source:'prompt',start:0,end:2,text:q.prompt.slice(0,2)});
  db.prepare("UPDATE exam_annotations SET status='pending' WHERE id=?").run(mark.item.id);
  const recovered=new LearningService(db);const rows=recovered.diagnostics.list({examId:id}).items;
  assert.equal(rows.filter(row=>row.source==='recovery').length,2);assert.equal(rows.filter(row=>row.source==='live').length,1);
  assert.ok(rows.filter(row=>row.source==='recovery').every(row=>row.category==='interrupted'));
  const restarted=new LearningService(db);assert.equal(restarted.diagnostics.list({examId:id}).total,3);
});

test('stale diagnostic links become unlinked history rather than masking the original error',t=>{
  const {service,diagnostics}=setup(t);
  const row=diagnostics.record(upstreamError(),{operation:'explain',examId:'missing-exam',questionId:'missing-question',conversationId:'missing-conversation',annotationIds:['deleted-mark']});
  assert.ok(row);assert.equal(row.examId,null);assert.equal(row.questionId,null);assert.equal(row.conversationId,null);assert.deepEqual(row.annotationIds,[]);
  assert.equal(row.requestId,'req-test-1');assert.equal(diagnostics.list().total,1);assert.doesNotThrow(()=>validateBackup(service.backup()));
});

test('a failed diagnostic insert cannot replace the original grading error or leave pending work',async t=>{
  const {db,service}=setup(t,{async generate(){throw upstreamError();}});const {id,q}=await paper(service);
  db.exec("CREATE TRIGGER reject_test_diagnostic BEFORE INSERT ON ai_failures BEGIN SELECT RAISE(ABORT,'test diagnostic write failure'); END");
  await service.submit(id);
  const exam=service.getExam(id);assert.equal(exam.status,'partial');assert.equal(exam.grades[q.id].status,'failed');assert.match(String(exam.grades[q.id].error),/套餐/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM grades WHERE status=\'pending\'').get()!.n),0);
});

test('v4 backups preserve diagnostics, v1/v2 restore safely, and invalid diagnostic references never mutate data',async t=>{
  const {service,diagnostics}=setup(t,{async generate(){throw upstreamError();}});const {id}=await paper(service);await service.submit(id);
  const backup=service.backup();assert.equal(backup.version,5);assert.equal(validateBackup(backup).tables.ai_failures.length,1);
  service.restore(backup);assert.equal(diagnostics.list({examId:id}).items[0].upstreamMessage,'Usage exhausted for this account.');
  for(const version of [1,2]){const old=structuredClone(backup) as any;old.version=version;delete old.tables.ai_failures;delete old.tables.exam_qa_turns;delete old.tables.review_points;delete old.tables.review_sources;delete old.tables.review_events;if(version===1)delete old.tables.exam_annotations;assert.equal(validateBackup(old).tables.ai_failures.length,0);service.restore(old);assert.equal(diagnostics.list().items[0].source,'legacy');}
  service.restore(backup);
  for(const mutate of [(copy:any)=>copy.tables.ai_failures[0].exam_id='missing',(copy:any)=>copy.tables.ai_failures[0].question_id='missing',(copy:any)=>copy.tables.ai_failures[0].detail='access_token=secret',(copy:any)=>copy.tables.ai_failures[0].unknown='unexpected']){const broken=structuredClone(backup);mutate(broken);assert.throws(()=>service.restore(broken),(error:any)=>error.code==='INVALID_BACKUP');assert.equal(diagnostics.list().total,1);}
});

test('pagination and filters are bounded, exam deletion cascades linked failures and all deletion clears unlinked history',async t=>{
  const {db,service,diagnostics}=setup(t,{async generate(){throw upstreamError();}});const {id}=await paper(service);await service.submit(id);
  diagnostics.record(Object.assign(new Error('catalog unavailable'),{code:'MODEL_LIST_ERROR'}),{operation:'models'});
  const page=diagnostics.list({page:2,pageSize:1});assert.equal(page.items.length,1);assert.equal(page.total,2);assert.equal(page.pages,2);
  assert.equal(diagnostics.list({operation:'grade',category:'quota'}).total,1);
  for(const query of [{page:0},{pageSize:101},{operation:'drop'},{category:'random'},{extra:'x'}])assert.throws(()=>diagnostics.list(query));
  const manager=new DataManagementService(db,{isBusy:()=>service.isBusy(),backup:()=>service.createDeletionBackup()});
  const single=manager.preview({scope:'exam',id});assert.equal(single.counts.diagnostics,1);manager.remove({token:single.token,confirmation:'删除'});
  assert.equal(diagnostics.list().total,1);assert.equal(diagnostics.list().items[0].operation,'models');
  const all=manager.preview({scope:'all'});assert.equal(all.counts.diagnostics,1);manager.remove({token:all.token,confirmation:'删除'});assert.equal(diagnostics.list().total,0);
});

test('failed initial generation, attempted repair validation, explanation and followup are all recorded separately',async t=>{
  let mode='generate';let calls=0;
  const {db,service,diagnostics}=setup(t,{async generate(){calls++;if(mode==='generate')return JSON.stringify({questions:[{type:'INVALID_PRIVATE_ENUM'}]});throw upstreamError();}});
  await assert.rejects(service.createExam({source:'ai',count:1,types:['single']}));assert.equal(calls,2);assert.equal(diagnostics.list({operation:'generate'}).total,2);assert.ok(!JSON.stringify(diagnostics.list()).includes('INVALID_PRIVATE_ENUM'));
  mode='explain';await assert.rejects(service.explain({kind:'sentence',text:'PRIVATE_USER_SENTENCE',level:'N5'}));assert.equal(diagnostics.list({operation:'explain'}).total,1);
  const stamp=new Date().toISOString();db.prepare('INSERT INTO conversations(id,title,kind,level,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('conversation-test','原始主题','sentence','N5',stamp,stamp);
  await assert.rejects(service.followup('conversation-test','PRIVATE_FOLLOWUP'));assert.equal(diagnostics.list({operation:'followup'}).total,1);assert.equal(diagnostics.list({operation:'followup'}).items[0].conversationId,'conversation-test');
  const text=JSON.stringify(diagnostics.list());assert.ok(!text.includes('PRIVATE_USER_SENTENCE'));assert.ok(!text.includes('PRIVATE_FOLLOWUP'));
});
