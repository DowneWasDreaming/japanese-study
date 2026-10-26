import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { LearningService, validateBackup, type AIProvider } from '../server/learning.js';
import { createLearningRouter } from '../server/learning-router.js';
import { errorHandler, localBoundary } from '../server/security.js';

type Messages = Parameters<AIProvider['generate']>[0];
type Point = {id:string;title:string;reading:string;meaning:string;focus:string};
type Payload = {count:number;types:string[];reviewFocus?:string;reviewPoints:Point[]};
type Reply = (payload:Payload, messages:Messages, call:number)=>string|Promise<string>;
const fill = (point:Point,index:number,serial:number,extra:Record<string,unknown>={})=>({
  type:'fill',prompt:`読音演習${serial}第${index+1}問：「${point.title}」の読みをひらがなで書いてください。`,
  answer:point.reading,acceptedAnswers:[point.reading],explanation:`「${point.title}」读作「${point.reading}」。`,
  knowledgePoints:[`${point.title}（${point.reading}）`],points:10,rubric:'填写准确的假名读音，保留长音和拗音区别。',reviewPointIds:[point.id],...extra,
});
const ordinary = (point:Point,index:number,serial:number)=>({
  type:'single',prompt:`通常復習${serial}第${index+1}問：仕事が（　）から、帰ります。`,
  options:[{id:'a',text:'済んで'},{id:'b',text:'読む'}],answer:'a',acceptedAnswers:[],
  explanation:'这里表示工作完成。',knowledgePoints:['済む'],points:10,rubric:'选择符合语境的选项。',reviewPointIds:[point.id],
});

async function setup(t:TestContext,reply:Reply=(payload,_messages,serial)=>JSON.stringify({questions:Array.from({length:payload.count},(_,index)=>fill(payload.reviewPoints[index%payload.reviewPoints.length],index,serial))}),withProvider=true){
  const directory=mkdtempSync(join(tmpdir(),'japanese-review-reading-http-'));
  const db=openDatabase(':memory:');seedDatabase(db);
  const requests:{payload:Payload;messages:Messages;model?:string}[]=[];
  const provider:AIProvider={async generate(messages,model){const payload=JSON.parse(messages.find(message=>message.role==='user')!.content) as Payload;requests.push({payload:structuredClone(payload),messages:structuredClone(messages),model});return reply(payload,messages,requests.length);}};
  const service=new LearningService(db,withProvider?provider:undefined,{backupDir:join(directory,'backups')});
  let extraBusy=false;
  const app=express(),server=app.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  app.use(localBoundary(origin));app.use(express.json({limit:'15mb'}));app.use('/api',createLearningRouter(service,db,()=>extraBusy));app.use(errorHandler);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const response=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,json:await response.json() as any};
  }
  async function point(title='済む',reading='すむ'){
    const added=await call('/review/points',{text:title,level:'N5',scope:'broad',intent:`${title}的整体用法与读音`});assert.equal(added.status,200,JSON.stringify(added.json));
    const result=await call('/review/points/'+added.json.item.id+'/confirm',{title,kind:'word',reading,meaning:'测试词义，读法不能在做题时提前显示。',focus:`${title}（${reading}）的整体用法与汉字读法。`,note:'来源、读音与目标范围应保持独立保存。'});
    assert.equal(result.status,200,JSON.stringify(result.json));return result.json.item as Point;
  }
  const readingExam=(pointIds:string[],extra:Record<string,unknown>={})=>call('/review/exams',{level:'N5',count:pointIds.length,pointIds,mode:'exam',gradingMode:'mixed',reviewFocus:'reading',...extra});
  return {db,service,origin,call,point,readingExam,requests,setExtraBusy:(value:boolean)=>{extraBusy=value;}};
}

test('reading review sends frozen readings and meanings to the model, forces kana fills and reveals no answers before submission',async t=>{
  const {db,call,point,readingExam,requests}=await setup(t);const first=await point(),second=await point('学校','がっこう');
  const created=await readingExam([first.id,second.id],{types:['single','sentence'],mode:'practice',model:'reading-test-model'});assert.equal(created.status,200,JSON.stringify(created.json));
  const exam=(await call('/exams/'+created.json.id)).json;assert.equal(exam.reviewFocus,'reading');assert.equal(exam.questions.length,2);assert.ok(exam.questions.every((question:any)=>question.type==='fill'));
  const payload=requests[0].payload;assert.equal(payload.reviewFocus,'reading');assert.deepEqual(payload.types,['fill']);assert.equal(payload.reviewPoints[0].reading,'すむ');assert.equal(payload.reviewPoints[1].reading,'がっこう');assert.equal(payload.reviewPoints[0].meaning,first.meaning);assert.equal(requests[0].model,'reading-test-model');
  assert.match(requests[0].messages[0].content,/读[音法]|読み/);
  const stored=JSON.parse(String(db.prepare('SELECT config_json FROM exams WHERE id=?').get(exam.id)!.config_json));assert.equal(stored.reviewSnapshot[0].reading,'すむ');assert.equal(stored.reviewSnapshot[0].meaning,first.meaning);
  for(const reviewPoint of exam.reviewPoints){assert.equal(reviewPoint.reading,undefined);assert.equal(reviewPoint.meaning,undefined);assert.equal(reviewPoint.focus,'汉字读音');assert.ok(!reviewPoint.title.includes('済む')&&!reviewPoint.title.includes('学校'));}
  for(const question of exam.questions){assert.equal(question.answer,undefined);assert.equal(question.acceptedAnswers,undefined);assert.equal(question.explanation,undefined);assert.equal(question.rubric,undefined);assert.deepEqual(question.knowledgePoints,['汉字读音']);}
  await call('/exams/'+exam.id+'/answers',{answers:{[exam.questions[0].id]:'すむ'}},'PUT');
  const feedback=await call('/exams/'+exam.id+'/feedback',{questionId:exam.questions[0].id});assert.equal(feedback.status,200,JSON.stringify(feedback.json));
  assert.equal(feedback.json.questions[0].answer,'すむ');assert.equal(feedback.json.questions[1].answer,undefined);assert.equal(feedback.json.reviewPoints[0].reading,undefined,'a completed single question must not reveal every target reading');
  await call('/exams/'+exam.id+'/answers',{answers:{[exam.questions[1].id]:'がっこう'}},'PUT');
  const submitted=await call('/exams/'+exam.id+'/submit',{});assert.equal(submitted.status,200,JSON.stringify(submitted.json));assert.equal(submitted.json.score,20);assert.equal(submitted.json.reviewPoints[0].reading,'すむ');assert.equal(submitted.json.reviewPoints[0].meaning,first.meaning);assert.equal(requests.length,1,'mixed objective grading must not make another model call');
});

test('kana reading grading preserves long vowels and small kana while accepting only canonical Unicode composition',async t=>{
  const {call,point,readingExam,requests}=await setup(t);
  const points=await Promise.all([point('今日','きょう'),point('学校','がっこう'),point('勉強','べんきょう'),point('銀行','ぎんこう')]);
  const created=await readingExam(points.map(item=>item.id));assert.equal(created.status,200,JSON.stringify(created.json));const exam=(await call('/exams/'+created.json.id)).json;
  const answers=['きよう','がっこ','へ\u3099んきょう','ぎんこう'];
  await call('/exams/'+exam.id+'/answers',{answers:Object.fromEntries(exam.questions.map((question:any,index:number)=>[question.id,answers[index]]))},'PUT');
  const submitted=await call('/exams/'+exam.id+'/submit',{});assert.equal(submitted.status,200,JSON.stringify(submitted.json));assert.equal(submitted.json.score,20);
  assert.deepEqual(exam.questions.map((question:any)=>submitted.json.grades[question.id].correct),[false,false,true,true]);assert.equal(requests.length,1);
});

test('invalid reading output gets one repair and no paper is saved when kana, question shape or target coverage remains invalid',async t=>{
  const faults=['json','answer-kanji','accepted-kanji','non-fill','options','no-kanji','visible-answer','missing-coverage'] as const;
  for(const fault of faults){
    const {db,call,point,readingExam,requests}=await setup(t,(payload,_messages,serial)=>{
      if(fault==='json')return '{broken';
      return JSON.stringify({questions:Array.from({length:payload.count},(_,index)=>{
        const selected=payload.reviewPoints[fault==='missing-coverage'?0:index%payload.reviewPoints.length];
        return fill(selected,index,serial,fault==='answer-kanji'?{answer:'済む'}:fault==='accepted-kanji'?{acceptedAnswers:['すむ','済む']}:fault==='non-fill'?{type:'sentence'}:fault==='options'?{options:[{id:'a',text:'すむ'},{id:'b',text:'よむ'}]}:fault==='no-kanji'?{prompt:`kana ${serial} ${index}：すむをよんでください。`}:fault==='visible-answer'?{prompt:`${serial} ${index}：「済む（すむ）」の読みをひらがなで書きなさい。`}:{});
      })});
    });
    const selected=[await point(),await point('学校','がっこう')];const before=Number(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n);
    const failed=await readingExam(selected.map(item=>item.id));assert.equal(failed.status,502,`${fault}: ${JSON.stringify(failed.json)}`);assert.equal(requests.length,2,`${fault} receives only one bounded repair`);assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n),before,`${fault} must not save a partial paper`);
  }
});

test('a repaired reading paper is accepted with transformed kana answers instead of requiring the original dictionary reading',async t=>{
  const {call,point,readingExam,requests}=await setup(t,(payload,_messages,serial)=>JSON.stringify({questions:[fill(payload.reviewPoints[0],0,serial,serial===1?{answer:'済んで',acceptedAnswers:['済んで']}:{prompt:'宿題が「済んで」から遊びます。「済んで」の読みをひらがなで書いてください。',answer:'すんで',acceptedAnswers:['すんで']})]}));
  const target=await point();const created=await readingExam([target.id]);assert.equal(created.status,200,JSON.stringify(created.json));assert.equal(requests.length,2);
  const exam=(await call('/exams/'+created.json.id)).json;await call('/exams/'+exam.id+'/answers',{answers:{[exam.questions[0].id]:'すんで'}},'PUT');const submitted=await call('/exams/'+exam.id+'/submit',{});assert.equal(submitted.status,200);assert.equal(submitted.json.score,10);assert.equal(submitted.json.questions[0].answer,'すんで');assert.equal(submitted.json.reviewPoints[0].reading,'すむ');
});

test('reading snapshots survive later knowledge edits and deletion and old v5 review snapshots remain compatible',async t=>{
  const {db,service,call,point,readingExam}=await setup(t);const target=await point();
  const created=await readingExam([target.id]);assert.equal(created.status,200,JSON.stringify(created.json));const id=created.json.id,exam=(await call('/exams/'+id)).json;
  await call('/review/points/'+target.id,{reading:'ずむ',meaning:'后改的释义',focus:'后改的知识范围'},'PUT');
  assert.equal((await call('/review/points/'+target.id,{},'DELETE')).status,200);
  await call('/exams/'+id+'/answers',{answers:{[exam.questions[0].id]:'すむ'}},'PUT');const submitted=await call('/exams/'+id+'/submit',{});assert.equal(submitted.status,200);assert.equal(submitted.json.score,10);assert.equal(submitted.json.reviewPoints[0].reading,'すむ');assert.equal(submitted.json.reviewPoints[0].meaning,target.meaning);
  const backup=service.backup();assert.equal(backup.version,5);assert.doesNotThrow(()=>validateBackup(backup));service.restore(backup);assert.equal((await call('/exams/'+id)).json.reviewPoints[0].reading,'すむ');
  for(const [field,value] of [['reading','あ'.repeat(201)],['meaning','义'.repeat(2001)]] as const){const invalid=structuredClone(backup);const row=invalid.tables.exams.find(row=>row.id===id)!;const config=JSON.parse(String(row.config_json));config.reviewSnapshot[0][field]=value;row.config_json=JSON.stringify(config);const before=db.prepare('SELECT total_changes() AS n').get()!.n;assert.throws(()=>service.restore(invalid),(error:any)=>error.code==='INVALID_BACKUP');assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before);}
  const legacy=structuredClone(backup);const row=legacy.tables.exams.find(row=>row.id===id)!;const config=JSON.parse(String(row.config_json));delete config.reviewFocus;for(const point of config.reviewSnapshot){delete point.reading;delete point.meaning;}row.config_json=JSON.stringify(config);assert.doesNotThrow(()=>validateBackup(legacy));service.restore(legacy);const old=(await call('/exams/'+id)).json;assert.equal(old.reviewFocus,'general');assert.equal(old.reviewPoints[0].reading,undefined);
});

test('reading count remains bounded at forty and general review keeps its existing selected question types',async t=>{
  const {call,point,readingExam,requests}=await setup(t,(payload,_messages,serial)=>JSON.stringify({questions:Array.from({length:payload.count},(_,index)=>payload.reviewFocus==='reading'?fill(payload.reviewPoints[0],index,serial):ordinary(payload.reviewPoints[0],index,serial))}));
  const target=await point();const created=await readingExam([target.id],{count:40});assert.equal(created.status,200,JSON.stringify(created.json));assert.equal((await call('/exams/'+created.json.id)).json.questions.length,40);
  assert.equal((await readingExam([target.id],{count:41})).status,400);assert.equal((await readingExam([target.id],{reviewFocus:'invalid'})).status,400);assert.equal(requests.length,1);
  const general=await call('/review/exams',{level:'N5',count:1,pointIds:[target.id],types:['single'],mode:'exam'});assert.equal(general.status,200,JSON.stringify(general.json));const exam=(await call('/exams/'+general.json.id)).json;assert.equal(exam.reviewFocus,'general');assert.equal(exam.questions[0].type,'single');assert.equal(exam.reviewPoints[0].title,'済む');assert.equal(exam.reviewPoints[0].reading,undefined);
  await call('/exams/'+exam.id+'/answers',{answers:{[exam.questions[0].id]:'a'}},'PUT');const submitted=await call('/exams/'+exam.id+'/submit',{});assert.equal(submitted.status,200);assert.equal(submitted.json.score,10);assert.equal(submitted.json.reviewPoints[0].reading,'すむ');assert.equal(requests.length,2);
});

test('reading review preserves local Origin checks, connection locks and the existing model authorization requirement',async t=>{
  const {call,point,readingExam,requests,origin,setExtraBusy}=await setup(t);const target=await point();
  const forged=await fetch(origin+'/api/review/exams',{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json','X-Study-Client':'local-web'},body:JSON.stringify({level:'N5',count:1,pointIds:[target.id],reviewFocus:'reading'})});assert.equal(forged.status,403);
  setExtraBusy(true);assert.equal((await readingExam([target.id])).status,409);setExtraBusy(false);assert.equal(requests.length,0);
  const unauthorized=await setup(t,undefined,false);const other=await unauthorized.point();const denied=await unauthorized.readingExam([other.id]);assert.equal(denied.status,403);assert.equal(denied.json.error.code,'PLAN_PERMISSION_REQUIRED');assert.equal(unauthorized.requests.length,0);
  assert.equal((await call('/review/points/'+target.id)).json.item.reading,'すむ');
});

test('reading auto selection filters grammar and kana-only concepts before counting while a kanji word with no saved reading is still eligible',async t=>{
  const {call,point,readingExam,requests}=await setup(t,(payload,_messages,serial)=>JSON.stringify({questions:Array.from({length:payload.count},(_,index)=>{const point=payload.reviewPoints[index%payload.reviewPoints.length],reading=point.reading||'すむ';return fill(point,index,serial,{answer:reading,acceptedAnswers:[reading]});})}));
  const grammar=await point('～次第','しだい');await call('/review/points/'+grammar.id,{kind:'grammar'},'PUT');const kana=await point('しまう','しまう'),word=await point('済む','');const expression=await point('一度に','いちどに');await call('/review/points/'+expression.id,{kind:'expression'},'PUT');
  for(const pointIds of [[grammar.id],[kana.id],[grammar.id,word.id]]){const failed=await readingExam(pointIds);assert.equal(failed.status,400,JSON.stringify(failed.json));assert.equal(failed.json.error.code,'INVALID_READING_REVIEW_SELECTION');}
  assert.equal(requests.length,0);
  const auto=await call('/review/exams',{level:'N5',count:2,reviewFocus:'reading',gradingMode:'mixed'});assert.equal(auto.status,200,JSON.stringify(auto.json));assert.deepEqual(requests[0].payload.reviewPoints.map(point=>point.id),[word.id,expression.id]);assert.equal(requests[0].payload.reviewPoints[0].reading,'');assert.equal((await call('/exams/'+auto.json.id)).json.questions.length,2);
});

test('an in-flight reading generation retains the learning lock against knowledge edits and data deletion',async t=>{
  let began!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{began=done;}),held=new Promise<void>(done=>{release=done;});
  const {call,point,readingExam,service}=await setup(t,async(payload,_messages,serial)=>{began();await held;return JSON.stringify({questions:[fill(payload.reviewPoints[0],0,serial)]});});
  const target=await point();const pending=readingExam([target.id]);await started;
  try{assert.equal(service.isBusy(),true);assert.equal((await call('/review/points/'+target.id,{reading:'ずむ'},'PUT')).status,409);assert.equal((await call('/data/delete-preview',{scope:'all'})).status,409);assert.equal((await call('/review/points/'+target.id)).json.item.reading,'すむ');}
  finally{release();}
  assert.equal((await pending).status,200);assert.equal(service.isBusy(),false);
});
