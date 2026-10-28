import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../server/db.js';
import {seedDatabase,type Question} from '../server/seed.js';
import {LearningService,validateBackup,type AIProvider} from '../server/learning.js';
import {createLearningRouter} from '../server/learning-router.js';
import {localBoundary,errorHandler} from '../server/security.js';
import {createApplication} from '../server/app.js';
import type {AuthManager} from '../server/auth.js';
import type {ModelService} from '../server/model.js';

type Input=Record<string,any>;
const fields={title:'～ておく',kind:'grammar',reading:'ておく',meaning:'事先做好准备。',focus:'结合语境理解为之后的需要预先做好某事。',note:'不要与表示遗憾的其他表达混淆。'};
function checked(input:Input,extra:Record<string,any>={}){
  return {...fields,usageKey:'事前準備',assessment:{outcome:'verified',reason:'原句明确表达为之后需要预先做好准备。',evidence:[String(input.context||input.selectedText).slice(0,80)],originalUnderstanding:''},...extra};
}
async function setup(t:TestContext,reply:(input:Input,call:number)=>unknown|Promise<unknown>=(input)=>checked(input)){
  const directory=mkdtempSync(join(tmpdir(),'japanese-review-check-http-')),db=openDatabase(':memory:');seedDatabase(db);
  const requests:Input[]=[];
  const provider:AIProvider={async generate(messages){const input=JSON.parse(messages.find(message=>message.role==='user')!.content);requests.push(input);const value=await reply(input,requests.length);return typeof value==='string'?value:JSON.stringify(value);}};
  const service=new LearningService(db,provider,{backupDir:join(directory,'backups')});
  let busy=false;
  const app=express(),server=app.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  app.use(localBoundary(origin));app.use(express.json({limit:'15mb'}));app.use('/api',createLearningRouter(service,db,()=>busy));app.use(errorHandler);
  t.after(async()=>{for(let n=0;n<500&&service.isBusy();n++)await delay(2);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const response=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,json:await response.json() as any};
  }
  async function manual(text:string,extra:Record<string,unknown>={}){
    const draft=await call('/review/points',{text,level:'N4',scope:'context'});assert.equal(draft.status,200);
    const result=await call('/review/points/'+draft.json.item.id+'/confirm',{...fields,title:'旧カード '+draft.json.item.id,...extra});assert.equal(result.status,200,JSON.stringify(result.json));return result.json.item;
  }
  async function finished(){for(let n=0;n<600;n++){const value=await call('/review/audit-batch');if(value.json.batch&&!['running','stopping'].includes(value.json.batch.status))return value.json.batch;await delay(2);}throw new Error('Verification batch did not finish.');}
  return {directory,db,service,requests,origin,call,manual,finished,setBusy:(value:boolean)=>{busy=value;}};
}

test('HTTP normalization corrects a misconception once and sends the complete submitted question and distractor context',async t=>{
  const h=await setup(t,input=>checked(input,{assessment:{outcome:'corrected',reason:'原句说明旅行前先订酒店，是事前准备；并非后悔。',evidence:['旅行の前にホテルを予約しておきます。'],originalUnderstanding:'以为这里表示后悔。'}}));
  const q:Question={id:randomUUID(),type:'reading',level:'N4',category:'reading',prompt:'筆者は旅行の前に何をしますか。',passage:'旅行の前にホテルを予約しておきます。早く予約すれば安心です。',options:[{id:'A',text:'旅行前にホテルを予約する。'},{id:'B',text:'予約したことを後悔している。'},{id:'C',text:'旅行の後に予約する。'},{id:'D',text:'予約をしない。'}],answer:'A',acceptedAnswers:[],explanation:'事前准备。',knowledgePoints:['～ておく'],points:10,rubric:'Aのみ。'};
  const examId=randomUUID(),stamp=new Date().toISOString();h.db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,submitted_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(examId,'原句核查','N4','reading','exam','builtin','completed',stamp,stamp,JSON.stringify([q]),JSON.stringify({level:'N4',count:1,types:['reading'],mode:'exam',source:'builtin',basis:'all'}));
  const text='ておきます',start=q.passage!.indexOf(text);
  const draft=await h.call('/review/points',{examId,questionId:q.id,source:'passage',start,end:start+text.length,text,scope:'context',intent:'以为这里表示后悔。'});
  const result=await h.call('/review/points/'+draft.json.item.id+'/normalize',{});assert.equal(result.status,200,JSON.stringify(result.json));
  const point=result.json.item;assert.equal(point.status,'active');assert.equal(point.verification.outcome,'corrected');assert.equal(point.usageKey,'事前準備');assert.equal(point.stage,0);assert.ok(point.dueAt);assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].question.passage,q.passage);assert.deepEqual(h.requests[0].question.options,q.options);assert.equal(h.requests[0].question.answer,'A');assert.ok(JSON.stringify(h.requests[0]).includes('后悔'));
  assert.equal((await h.call('/review/points?status=uncertain')).json.total,0);assert.equal((await h.call('/review/points?status=due')).json.total,1);
  const wrongText='後悔',wrongOption=q.options![1],wrongStart=wrongOption.text.indexOf(wrongText);
  const optionMark=(await h.call('/review/points',{examId,questionId:q.id,source:'option',optionId:'B',start:wrongStart,end:wrongStart+wrongText.length,text:wrongText,scope:'context',intent:'这个选项的意思是否就是原句含义？'})).json.item;
  await h.call('/review/points/'+optionMark.id+'/normalize',{});assert.equal(h.requests.length,2);assert.equal(h.requests[1].question.selectedOptionId,'B');assert.equal(h.requests[1].question.isCorrectOption,false,'a distractor is explicitly labelled instead of being passed as true reading content');
});

test('uncertain knowledge is retained outside due/manual exams and ratings, then clarification can be checked without confirmation',async t=>{
  let resolved=false;
  const h=await setup(t,input=>resolved?checked(input,{title:'～てしまう',usageKey:'完了',meaning:'动作全部完成。',focus:'复习明确语境中的动作完成。',assessment:{outcome:'verified',reason:'补充原句表明作业全部完成。',evidence:['宿題を全部やってしまいました。'],originalUnderstanding:''}}):checked(input,{title:'～てしまう',usageKey:'未確定',assessment:{outcome:'uncertain',reason:'只有孤立词形，无法判断是完成还是遗憾，请补充原句。',evidence:[],originalUnderstanding:'想按完成用法复习。'}}));
  const draft=(await h.call('/review/points',{text:'しまう',level:'N4',scope:'context',intent:'想按完成用法复习。'})).json.item;
  const normalized=await h.call('/review/points/'+draft.id+'/normalize',{});assert.equal(normalized.status,200);assert.equal(normalized.json.item.verification.outcome,'uncertain');
  assert.equal((await h.call('/review/points?status=uncertain')).json.total,1);assert.equal((await h.call('/review/points?status=due')).json.total,0);
  const exam=await h.call('/review/exams',{level:'N4',count:1,types:['fill'],pointIds:[draft.id]});assert.ok(exam.status>=400);assert.equal(h.requests.length,1,'uncertain manual selection does not spend another model call');
  assert.ok((await h.call('/review/points/'+draft.id+'/rate',{rating:'mastered',requestId:randomUUID()})).status>=400);
  const clarification=await h.call('/review/points/'+draft.id+'/clarification',{text:'原句是：宿題を全部やってしまいました。这里是否表示全部完成？'},'PUT');assert.equal(clarification.status,200);assert.equal(h.requests.length,1);assert.equal(clarification.json.item.verification.outcome,'uncertain');
  resolved=true;const audited=await h.call('/review/points/'+draft.id+'/audit',{});assert.equal(audited.status,200,JSON.stringify(audited.json));assert.equal(audited.json.item.status,'active');assert.equal(audited.json.item.verification.outcome,'verified');assert.equal(h.requests.length,2);assert.equal((await h.call('/review/points?status=uncertain')).json.total,0);
});

test('auditing a different actual concept keeps historical events but does not transfer unrelated mastery',async t=>{
  const h=await setup(t,input=>checked(input,{assessment:{outcome:'corrected',reason:'原句是预先准备，不是遗憾。',evidence:[String(input.selectedText)],originalUnderstanding:'把事前准备误记为遗憾。'}}));
  const old=await h.manual('旅行前に予約しておきます。',{title:'～てしまう',focus:'表示遗憾的用法。'});
  await h.call('/review/points/'+old.id+'/rate',{rating:'mastered',requestId:randomUUID()});const before=h.db.prepare('SELECT * FROM review_events').all();
  const audited=await h.call('/review/points/'+old.id+'/audit',{});assert.equal(audited.status,200,JSON.stringify(audited.json));assert.equal(audited.json.item.title,'～ておく');assert.equal(audited.json.item.stage,0);assert.equal(audited.json.item.status,'active');assert.equal(audited.json.item.verification.progressReset,true);assert.deepEqual(h.db.prepare('SELECT * FROM review_events').all(),before);
});

test('existing duplicates merge sources and progress through aliases while old exam snapshots and self-rating references stay valid',async t=>{
  const h=await setup(t,input=>input.reviewPoints?{questions:[{type:'fill',prompt:'旅行の前に予約し（　）。',answer:'ておきます',acceptedAnswers:['ておきます'],explanation:'提前准备。',knowledgePoints:['～ておく'],points:10,rubric:'填入对应形式。',reviewPointIds:[input.reviewPoints[0].id]}]}:checked(input));
  const first=await h.manual('旅行の前にホテルを予約しておきます。'),second=await h.manual('会議の前に資料を読んでおきます。');
  await h.call('/review/points/'+first.id+'/rate',{rating:'good',requestId:randomUUID()});
  const paper=await h.call('/review/exams',{level:'N4',count:1,types:['fill'],pointIds:[second.id]});assert.equal(paper.status,200,JSON.stringify(paper.json));
  const examId=paper.json.id,publicPaper=h.service.getExam(examId);h.service.saveAnswers(examId,{[String(publicPaper.questions[0].id)]:'ておきます'});await h.service.submit(examId);
  await h.call('/review/points/'+second.id+'/rate',{rating:'mastered',requestId:randomUUID(),examId});
  const frozen=h.db.prepare('SELECT questions_json,config_json FROM exams WHERE id=?').get(examId);
  assert.equal((await h.call('/review/points/'+first.id+'/audit',{})).status,200);
  const merged=await h.call('/review/points/'+second.id+'/audit',{});assert.equal(merged.status,200,JSON.stringify(merged.json));assert.equal(merged.json.merged,true);assert.equal(merged.json.item.status,'mastered');assert.equal(merged.json.item.stage,7);assert.equal(merged.json.item.sources.length,2);assert.equal(merged.json.item.repetitions,2);
  assert.equal((await h.call('/review/points/'+second.id)).json.item.id,merged.json.item.id);assert.equal((await h.call('/review/points?status=all')).json.total,1);
  assert.deepEqual(h.db.prepare('SELECT questions_json,config_json FROM exams WHERE id=?').get(examId),frozen);
  assert.equal((await h.call('/review/points/'+second.id+'/rate',{rating:'good',requestId:randomUUID(),examId})).status,200,'the historical exam may still name a merged alias');
  const backup=JSON.parse(readFileSync(h.service.createDeletionBackup(),'utf8'));assert.doesNotThrow(()=>validateBackup(backup));assert.doesNotThrow(()=>h.service.restore(backup));assert.equal((await h.call('/review/points?status=all')).json.total,1);
});

test('same grammar name with different contextual meanings remains separate after AI checking',async t=>{
  const h=await setup(t,input=>checked(input,{title:'～てしまう',usageKey:String(input.selectedText).includes('宿題')?'完了':'後悔',meaning:String(input.selectedText).includes('宿題')?'全部完成。':'遗憾。',focus:String(input.selectedText).includes('宿題')?'动作完成。':'不如意结果带来的遗憾。'}));
  const first=await h.manual('宿題を全部やってしまいました。'),second=await h.manual('大切な財布をなくしてしまいました。');
  const a=await h.call('/review/points/'+first.id+'/audit',{}),b=await h.call('/review/points/'+second.id+'/audit',{});
  assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.json.item.id,b.json.item.id);assert.notEqual(a.json.item.usageKey,b.json.item.usageKey);assert.equal((await h.call('/review/points?status=all')).json.total,2);
});

test('one audit batch checks all existing cards once, distinguishes uncertainty, and status polling or repeating skips unchanged checks',async t=>{
  const h=await setup(t,input=>checked(input,String(input.selectedText).includes('曖昧')?{assessment:{outcome:'uncertain',reason:'原句不足。',evidence:[],originalUnderstanding:''}}:{}));
  await h.manual('旅行前に予約しておきます。');await h.manual('会議前に資料を読んでおきます。',{title:'別の語法'});await h.manual('曖昧な語形');
  const start=await h.call('/review/audit-batch',{});assert.equal(start.status,202);assert.equal(start.json.batch.kind,'audit');assert.equal(start.json.batch.total,3);
  const job=await h.finished();assert.equal(job.status,'completed');assert.equal(job.processed,3);assert.equal(job.uncertain,1);assert.equal(job.failed,0);assert.equal(h.requests.length,3);
  await h.call('/review/audit-batch');await h.call('/review/normalize-batch');assert.equal(h.requests.length,3);
  assert.equal((await h.call('/review/audit-batch')).json.eligibleCount,0);const again=await h.call('/review/audit-batch',{});assert.ok(again.status>=400);assert.equal(h.requests.length,3);
});

test('failed audit retains the prior content and schedule with a detailed diagnostic rather than erasing a card',async t=>{
  const h=await setup(t,()=>{throw Object.assign(new Error('Synthetic review socket reset'),{code:'ECONNRESET',diagnostics:{networkCode:'ECONNRESET',upstreamStatus:200,upstreamMessage:'Synthetic audit interruption.'}});});
  const point=await h.manual('会議前に資料を読んでおきます。');await h.call('/review/points/'+point.id+'/rate',{rating:'good',requestId:randomUUID()});
  const before=(await h.call('/review/points/'+point.id)).json.item;
  const audit=await h.call('/review/points/'+point.id+'/audit',{});assert.equal(audit.status,200);const after=audit.json.item;
  for(const key of ['title','kind','meaning','focus','reading','note','stage','dueAt','repetitions','lastReviewedAt'])assert.deepEqual(after[key],before[key],key);
  assert.equal(after.normalizationStatus,'failed');const failures=(await h.call('/diagnostics?operation=review')).json;assert.equal(failures.total,1);assert.equal(failures.items[0].networkCode,'ECONNRESET');
});

test('audit routes enforce local origin, strict request shapes and connection locks without implicit AI calls',async t=>{
  const h=await setup(t);const point=await h.manual('旅行前に予約しておきます。');
  const forged=await fetch(h.origin+'/api/review/audit-batch',{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(forged.status,403);
  assert.equal((await h.call('/review/audit-batch',{extra:true})).status,400);assert.equal((await h.call('/review/points/'+point.id+'/audit',{extra:true})).status,400);
  h.setBusy(true);assert.equal((await h.call('/review/audit-batch',{})).status,409);assert.equal((await h.call('/review/points/'+point.id+'/audit',{})).status,409);assert.equal((await h.call('/review/points/'+point.id+'/clarification',{text:'补充说明'},'PUT')).status,409);h.setBusy(false);
  await h.call('/review/audit-batch');await h.call('/review/points/'+point.id);assert.equal(h.requests.length,0);
});

test('audit batches share one global lock and stop only after the current check without dispatching queued requests',async t=>{
  let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});
  t.after(()=>release());
  const h=await setup(t,async input=>{await gate;return checked(input);});
  const first=await h.manual('旅行前に予約しておきます。'),second=await h.manual('会議前に資料を読んでおきます。');
  const started=await h.call('/review/audit-batch',{});assert.equal(started.status,202);const jobId=started.json.batch.id;
  for(let n=0;n<100&&!h.requests.length;n++)await delay(2);assert.equal(h.requests.length,1);
  const again=await h.call('/review/audit-batch',{});assert.equal(again.json.batch.id,jobId);assert.equal(h.requests.length,1);
  assert.equal((await h.call('/review/points/'+second.id+'/audit',{})).status,409);assert.equal((await h.call('/review/points/'+second.id+'/clarification',{text:'等待当前任务结束。'},'PUT')).status,409);
  assert.equal((await h.call('/exams',{level:'N4',count:1,types:['fill'],source:'builtin'})).status,409);
  const stopping=await h.call('/review/audit-batch/'+jobId+'/stop',{});assert.equal(stopping.status,200);assert.equal(stopping.json.batch.status,'stopping');
  release();const done=await h.finished();assert.equal(done.status,'stopped');assert.equal(done.processed,1);assert.equal(done.succeeded,1);assert.equal(done.items[1].status,'skipped');assert.equal(h.requests.length,1);assert.equal((await h.call('/review/points/'+first.id)).json.item.verification.outcome,'verified');assert.equal((await h.call('/review/points/'+second.id)).json.item.verification,null);
});

test('legacy v5 review rows without verification columns restore as unverified with exactly the original progress',async t=>{
  const h=await setup(t);const point=await h.manual('会議前に資料を読んでおきます。',{title:'～ておく'});await h.call('/review/points/'+point.id+'/rate',{rating:'good',requestId:randomUUID()});
  const before=(await h.call('/review/points/'+point.id)).json.item,backup=JSON.parse(readFileSync(h.service.createDeletionBackup(),'utf8'));
  for(const row of backup.tables.review_points){delete row.usage_key;delete row.verification_json;delete row.merged_into;}
  assert.doesNotThrow(()=>validateBackup(backup));h.service.restore(backup);
  const after=(await h.call('/review/points/'+point.id)).json.item;for(const key of ['title','scope','focus','reading','meaning','note','stage','dueAt','repetitions','lapses','lastReviewedAt'])assert.deepEqual(after[key],before[key],key);assert.equal(after.verification,null);assert.equal(after.usageKey,'');assert.equal(h.requests.length,0);
});

test('legacy cached suggestions need a teacher check before joining a schedule, not merely valid old JSON',async t=>{
  const h=await setup(t);const draft=(await h.call('/review/points',{text:'旅行前に予約しておきます。',level:'N4'})).json.item;
  h.db.prepare("UPDATE review_points SET normalization_status='completed',candidate_json=? WHERE id=?").run(JSON.stringify({...fields,meaning:'错误的旧候选'}),draft.id);
  const result=await h.call('/review/points/'+draft.id+'/normalize',{});assert.equal(result.status,200);assert.equal(h.requests.length,1);assert.equal(result.json.item.meaning,fields.meaning);assert.equal(result.json.item.verification.outcome,'verified');
});

test('explicit audit actions clear a prior model pause but audit GET polling never does',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'japanese-review-check-app-')),db=openDatabase(':memory:');seedDatabase(db);
  let resets=0,calls=0;
  const auth={status:()=>({connected:true,planAuthorized:true})} as unknown as AuthManager;
  const model={selectedModel:'checked-test',resetFailurePause(){resets++;},async generate(messages:Parameters<AIProvider['generate']>[0]){calls++;return JSON.stringify(checked(JSON.parse(messages.find(message=>message.role==='user')!.content)));}} as unknown as ModelService;
  const holder=express(),server=holder.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
  const application=createApplication({port,origin,host:'127.0.0.1',dataDir:directory,dbPath:join(directory,'study.sqlite'),credentialDir:join(directory,'credentials')},db,auth,model);holder.use(application.app);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  const draft=application.learning.reviews.add({text:'旅行前に予約しておきます。',level:'N4'}).item;application.learning.reviews.confirm(draft.id,fields);
  const call=async(path:string,body?:unknown)=>{const r=await fetch(origin+'/api'+path,body===undefined?undefined:{method:'POST',headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,json:await r.json() as any};};
  await call('/review/audit-batch');assert.equal(resets,0);assert.equal(calls,0);
  assert.equal((await call('/review/points/'+draft.id+'/audit',{})).status,200);assert.equal(resets,1);assert.equal(calls,1);
  await call('/review/audit-batch');assert.equal(resets,1);assert.equal(calls,1);
  assert.equal((await call('/review/audit-batch',{force:true})).status,202);
  for(let n=0;n<500&&application.learning.isBusy();n++)await delay(2);assert.equal(resets,2);assert.equal(calls,2);
});
