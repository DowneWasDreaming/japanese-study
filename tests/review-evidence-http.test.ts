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
import {reviewEvidenceFailurePrefix} from '../server/review-evidence-diagnostics.js';

type Input=Record<string,any>;
const fields={title:'～ておく',kind:'grammar',reading:'ておく',meaning:'为之后需要事先做好准备。',focus:'结合原句理解事前准备的实际用法。',note:'不要将原句改写后冒充引文。'};
function checked(evidence:string[]){return {...fields,usageKey:'事前準備',assessment:{outcome:'verified',reason:'依据完整原句核对用法。',evidence,originalUnderstanding:''}};}

async function setup(t:TestContext,reply:(input:Input,call:number)=>unknown|Promise<unknown>){
  const directory=mkdtempSync(join(tmpdir(),'japanese-evidence-http-')),db=openDatabase(':memory:');seedDatabase(db);
  const requests:Input[]=[];
  const provider:AIProvider={async generate(messages){const input=JSON.parse(messages.find(message=>message.role==='user')!.content);requests.push(input);return JSON.stringify(await reply(input,requests.length));}};
  const service=new LearningService(db,provider,{backupDir:join(directory,'backups')});
  let externallyBusy=false;
  const app=express(),server=app.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  app.use(localBoundary(origin));app.use(express.json({limit:'15mb'}));app.use('/api',createLearningRouter(service,db,()=>externallyBusy));app.use(errorHandler);
  t.after(async()=>{for(let n=0;n<300&&service.isBusy();n++)await delay(2);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const response=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,json:await response.json() as any};
  }
  async function manual(text:string,active=false){
    const created=await call('/review/points',{text,level:'N4',scope:'context'});assert.equal(created.status,200);
    if(!active)return created.json.item;
    const result=await call('/review/points/'+created.json.item.id+'/confirm',{...fields,title:'既存 '+created.json.item.id});assert.equal(result.status,200);return result.json.item;
  }
  async function paper(passage:string,extra:Partial<Question>={}){
    const q:Question={id:randomUUID(),type:'reading',level:'N4',category:'reading',prompt:'原文に合う内容を選んでください。',passage,options:[{id:'A',text:'出発前に切符を買う。'},{id:'B',text:'到着後に切符を買う。'},{id:'C',text:'切符を買わない。'},{id:'D',text:'切符をなくす。'}],answer:'A',acceptedAnswers:[],explanation:'按原文核对，不补全或改写引用。',knowledgePoints:['～ておく'],points:10,rubric:'Aのみ。',...extra};
    const examId=randomUUID(),stamp=new Date().toISOString();
    db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,submitted_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(examId,'引文验收','N4','reading','exam','builtin','draft',stamp,null,JSON.stringify([q]),JSON.stringify({level:'N4',count:1,types:['reading'],mode:'exam',source:'builtin',basis:'all',model:'test-evidence-model'}));
    await service.submit(examId);
    const text=Array.from(passage).slice(0,Math.min(12,Array.from(passage).length)).join('');
    const created=await call('/review/points',{examId,questionId:q.id,source:'passage',start:0,end:text.length,text,scope:'context'});assert.equal(created.status,200);return {examId,q,item:created.json.item};
  }
  return {db,directory,service,requests,origin,call,manual,paper,setBusy:(value:boolean)=>{externallyBusy=value;}};
}

test('HTTP formatting-equivalent evidence stores original width and newlines, preserves source anchors and restores in v5',async t=>{
  const original='集合時刻は１２：３０です。\r\n出発の前に、切符を買っておきます。';
  const h=await setup(t,()=>checked(['「集合時刻は12:30です。\n出発の前に、切符を買っておきます。」']));
  const {item}=await h.paper('駅の案内です。\r\n'+original);
  const source=h.db.prepare('SELECT * FROM review_sources WHERE point_id=?').get(item.id);
  const result=await h.call('/review/points/'+item.id+'/normalize',{});assert.equal(result.status,200,JSON.stringify(result.json));
  assert.equal(result.json.item.normalizationStatus,'none');assert.equal(result.json.item.status,'active');assert.deepEqual(result.json.item.verification.evidence,[original]);assert.equal(h.requests.length,1);
  assert.deepEqual(h.db.prepare('SELECT * FROM review_sources WHERE point_id=?').get(item.id),source);
  const backup=JSON.parse(readFileSync(h.service.createDeletionBackup(),'utf8'));assert.equal(backup.version,5);assert.doesNotThrow(()=>validateBackup(backup));assert.doesNotThrow(()=>h.service.restore(backup));
  const restored=(await h.call('/review/points/'+item.id)).json.item;assert.deepEqual(restored.verification.evidence,[original]);assert.equal(h.requests.length,1,'backup and GET never call the model');
});

test('HTTP NFC and layout-space equivalence retains exact decomposed source without resetting existing mastery',async t=>{
  const original='カ\u3099ラスの コップを用意しておきます。';
  const h=await setup(t,()=>checked(['“ガラスのコップを用意しておきます。”']));
  const point=await h.manual(original,true);await h.call('/review/points/'+point.id+'/rate',{rating:'mastered',requestId:randomUUID()});
  const events=h.db.prepare('SELECT * FROM review_events').all(),before=(await h.call('/review/points/'+point.id)).json.item;
  const result=await h.call('/review/points/'+point.id+'/audit',{});assert.equal(result.status,200,JSON.stringify(result.json));
  assert.equal(result.json.item.status,'mastered');assert.equal(result.json.item.stage,7);assert.equal(result.json.item.dueAt,before.dueAt);assert.equal(result.json.item.repetitions,before.repetitions);assert.deepEqual(result.json.item.verification.evidence,[original]);assert.deepEqual(h.db.prepare('SELECT * FROM review_events').all(),events);
});

test('HTTP real wording changes remain rejected and each failure preserves old content, schedule and self-rating history',async t=>{
  let currentEvidence='';const h=await setup(t,()=>checked([currentEvidence]));
  const cases=[
    ['天気がいいので、ベランダ（　）洗濯物を干しました。','天気がいいので、ベランダに洗濯物を干しました。'],
    ['洗濯物を干しました。','洗濯物を干す。'],
    ['予約をしません。','予約をします。'],
    ['集合は１２：３０です。','集合は12:35です。'],
    ['キヤノンを見ました。','キャノンを見ました。'],
  ];
  for(const [original,changed] of cases){
    currentEvidence=changed;const point=await h.manual(original,true);await h.call('/review/points/'+point.id+'/rate',{rating:'good',requestId:randomUUID()});
    const before=h.db.prepare('SELECT * FROM review_points WHERE id=?').get(point.id)!,events=h.db.prepare('SELECT * FROM review_events').all();
    const result=await h.call('/review/points/'+point.id+'/audit',{});assert.equal(result.status,200);assert.equal(result.json.item.normalizationStatus,'failed');assert.match(result.json.item.error,/INVALID_REVIEW_EVIDENCE/);
    const after=h.db.prepare('SELECT * FROM review_points WHERE id=?').get(point.id)!;
    for(const key of ['title','kind','focus','meaning','reading','note','stage','due_at','last_reviewed_at','repetitions','lapses','verification_json'])assert.equal(after[key],before[key],key);
    assert.deepEqual(h.db.prepare('SELECT * FROM review_events').all(),events);
  }
  const history=(await h.call('/diagnostics?operation=review')).json;assert.equal(history.total,cases.length);assert.equal(h.requests.length,cases.length);
  for(const failure of history.items){assert.equal(failure.category,'validation');assert.equal(failure.upstreamStatus,null);assert.equal(failure.code,'INVALID_REVIEW_EVIDENCE');assert.equal(failure.evidenceFailure.version,1);assert.equal(failure.evidenceFailure.reason,'quote_not_found');assert.equal(failure.evidenceFailure.citationIndex,1);assert.equal(failure.evidenceFailure.citationCount,1);assert.ok(failure.evidenceFailure.closestSource);assert.ok(failure.evidenceFailure.pointId);}
});

test('HTTP diagnostic identifies explanation-only citations and never treats cross-field concatenation as original evidence',async t=>{
  let mode='explanation';const explanation='例：出発の前に切符を買っておきます。';
  const h=await setup(t,()=>checked([mode==='explanation'?explanation:'最初の資料です。次の資料です。']));
  const {item}=await h.paper('次の資料です。',{prompt:'最初の資料です。',explanation});
  const first=await h.call('/review/points/'+item.id+'/normalize',{});assert.equal(first.json.item.normalizationStatus,'failed');
  const firstFailure=(await h.call('/diagnostics?operation=review')).json.items[0];assert.equal(firstFailure.evidenceFailure.contextOnlyMatch,'explanation');assert.equal(firstFailure.evidenceFailure.quoteExcerpt,explanation);assert.equal(firstFailure.model,'test-evidence-model');
  mode='joined';const second=await h.call('/review/points/'+item.id+'/normalize',{});assert.equal(second.json.item.normalizationStatus,'failed');
  const history=(await h.call('/diagnostics?operation=review')).json;assert.equal(history.total,2);assert.notEqual(history.items[0].id,history.items[1].id);assert.equal(h.requests.length,2);
  const backup=JSON.parse(readFileSync(h.service.createDeletionBackup(),'utf8'));assert.doesNotThrow(()=>validateBackup(backup));h.service.restore(backup);assert.equal((await h.call('/diagnostics?operation=review')).json.total,2);
});

test('HTTP missing evidence has a distinct persisted reason and old errors do not invent historical quotations',async t=>{
  const h=await setup(t,()=>checked([]));const point=await h.manual('ホテルを予約しておきます。');
  const result=await h.call('/review/points/'+point.id+'/normalize',{});assert.equal(result.json.item.normalizationStatus,'failed');
  const failure=(await h.call('/diagnostics?operation=review')).json.items[0];assert.equal(failure.category,'validation');assert.equal(failure.evidenceFailure.reason,'missing_evidence');assert.equal(failure.evidenceFailure.citationIndex,null);assert.equal(failure.evidenceFailure.citationCount,0);assert.equal(failure.evidenceFailure.quoteExcerpt,'');
  h.service.diagnostics.record(Object.assign(new Error('旧版仅保留未匹配错误。'),{code:'INVALID_REVIEW_EVIDENCE',status:502}),{operation:'review'});
  const history=(await h.call('/diagnostics?operation=review')).json;const old=history.items.find((item:any)=>item.message==='旧版仅保留未匹配错误。');assert.equal(old.evidenceFailure,null);assert.equal(h.requests.length,1);
});

test('HTTP ambiguous formatting matches are explained without guessing which original span to save',async t=>{
  const original='資料を 読んでおきます。\n資料を\t読んでおきます。';
  const h=await setup(t,()=>checked(['資料を\n読んでおきます。']));const {item}=await h.paper(original);
  const before=h.db.prepare('SELECT * FROM review_sources').all();
  const result=await h.call('/review/points/'+item.id+'/normalize',{});assert.equal(result.status,200);assert.equal(result.json.item.status,'draft');assert.equal(result.json.item.normalizationStatus,'failed');assert.equal(result.json.item.verification,null);assert.deepEqual(h.db.prepare('SELECT * FROM review_sources').all(),before);
  const failure=(await h.call('/diagnostics?operation=review')).json.items[0];assert.equal(failure.category,'validation');assert.equal(failure.evidenceFailure.reason,'ambiguous_match');assert.equal(failure.evidenceFailure.quoteExcerpt,'資料を\n読んでおきます。');assert.equal(h.requests.length,1);
});

test('HTTP evidence diagnostics expose bounded redacted fields and reject unknown structured metadata',async t=>{
  const h=await setup(t,()=>checked(['不存在的原文。']));
  const syntheticSecret=['sk','synthetic','secret','for','test','123456789'].join('-');
  const value={version:1,reason:'quote_not_found',pointId:randomUUID(),citationIndex:1,citationCount:1,quoteExcerpt:'Bearer '+syntheticSecret,quoteLength:3000,quoteTruncated:true,closestSource:{label:'标记原文',excerpt:'联系 user@example.com，api_key='+syntheticSecret,length:3000,truncated:true},sourceCount:1,contextOnlyMatch:null};
  h.service.diagnostics.record(Object.assign(new Error('引用不在原文中。'),{code:'INVALID_REVIEW_EVIDENCE',status:502,detail:reviewEvidenceFailurePrefix+JSON.stringify(value)}),{operation:'review'});
  const response=(await h.call('/diagnostics?operation=review')).json,serialized=JSON.stringify(response);assert.ok(!serialized.includes(syntheticSecret));assert.ok(!serialized.includes('user@example.com'));
  const detail=response.items[0].evidenceFailure;assert.ok(detail);assert.ok(detail.quoteExcerpt.length<=1000);assert.ok(detail.closestSource.excerpt.length<=1000);assert.equal(detail.quoteTruncated,true);
  h.service.diagnostics.record(Object.assign(new Error('非法的诊断扩展。'),{code:'INVALID_REVIEW_EVIDENCE',status:502,detail:reviewEvidenceFailurePrefix+JSON.stringify({...value,rawResponse:{access_token:syntheticSecret,userAnswer:'SHOULD_NOT_ENTER_DIAGNOSTICS'}})}),{operation:'review'});
  const malformed=(await h.call('/diagnostics?operation=review')).json.items.find((item:any)=>item.message==='非法的诊断扩展。');assert.equal(malformed.evidenceFailure,null);assert.ok(!JSON.stringify(malformed).includes(syntheticSecret));assert.ok(!JSON.stringify(malformed).includes('SHOULD_NOT_ENTER_DIAGNOSTICS'));assert.equal(h.requests.length,0);
  const backup=JSON.parse(readFileSync(h.service.createDeletionBackup(),'utf8'));backup.tables.ai_failures[0].detail=reviewEvidenceFailurePrefix+JSON.stringify({...value,rawResponse:'SHOULD_NOT_ENTER_DIAGNOSTICS'});assert.throws(()=>validateBackup(backup),'unknown diagnostic fields cannot enter restored failure records');
});

test('HTTP evidence retry origin and busy locks reject invalid work while polling never starts another request',async t=>{
  let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});t.after(()=>release());
  const h=await setup(t,async()=>{await gate;return checked(['从未出现的句子。']);});const point=await h.manual('資料を読んでおきます。');
  const forged=await fetch(h.origin+'/api/review/points/'+point.id+'/normalize',{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(forged.status,403);
  h.setBusy(true);assert.equal((await h.call('/review/points/'+point.id+'/normalize',{})).status,409);h.setBusy(false);assert.equal(h.requests.length,0);
  const flight=h.call('/review/points/'+point.id+'/normalize',{});for(let n=0;n<100&&!h.requests.length;n++)await delay(2);assert.equal(h.requests.length,1);
  await h.call('/review/points/'+point.id);await h.call('/diagnostics?operation=review');assert.equal(h.requests.length,1);
  assert.equal((await h.call('/exams',{source:'builtin',level:'N5',count:1,types:['single']})).status,409);
  release();await flight;const first=(await h.call('/diagnostics?operation=review')).json.items[0];
  const second=await h.call('/review/points/'+point.id+'/normalize',{});assert.equal(second.json.item.normalizationStatus,'failed');const rows=(await h.call('/diagnostics?operation=review')).json;assert.equal(rows.total,2);assert.ok(rows.items.some((item:any)=>item.id===first.id));assert.equal(h.requests.length,2);
});
