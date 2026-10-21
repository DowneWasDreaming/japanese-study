import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openDatabase } from '../server/db.js';
import { seedDatabase, type Question } from '../server/seed.js';
import { LearningService, validateBackup, type AIProvider } from '../server/learning.js';
import { createLearningRouter } from '../server/learning-router.js';
import { localBoundary, errorHandler } from '../server/security.js';

type Messages = Parameters<AIProvider['generate']>[0];
type Reply = (messages: Messages, call: number) => string | Promise<string>;
const normalized = {title:'済む',kind:'word',reading:'すむ',meaning:'结束、办完；也有解决、足够等用法。',focus:'整体掌握原形「済む」及常见搭配，不局限于「済んで」的て形。',note:'结合「仕事が済む」「これで済む」等结构区分用法。'};
const shape = (prompt: string, reviewPointIds?: string[]) => ({type:'fill',prompt,answer:'が',acceptedAnswers:['が'],explanation:'这里使用助词「が」。',knowledgePoints:['助词与目标用法'],points:10,rubric:'填入符合语境的助词。',...(reviewPointIds?{reviewPointIds}: {})});
const stablePoint = (value:Record<string,unknown>) => {const {weight,...saved}=value;return saved;};

async function setup(t: TestContext, reply: Reply = () => JSON.stringify(normalized)) {
  const directory=mkdtempSync(join(tmpdir(),'japanese-review-http-'));
  const db=openDatabase(':memory:');seedDatabase(db);
  const requests:{messages:Messages;model?:string}[]=[];
  const provider:AIProvider={async generate(messages,model){requests.push({messages:structuredClone(messages),model});return reply(messages,requests.length);}};
  const service=new LearningService(db,provider,{backupDir:join(directory,'backups')});
  const stamp=new Date().toISOString(),id=randomUUID();
  const questions:Question[]=[{id:randomUUID(),type:'fill',level:'N5',category:'grammar',prompt:'宿題が済んでから、テレビを見ます。「済んで」の使い方を考えましょう。',answer:'済んで',acceptedAnswers:['済んで'],explanation:'「済んで」是「済む」的て形，表达完成。',knowledgePoints:['済む'],points:10,rubric:'按参考表达与允许答案判分。',source:'builtin'},
    {id:randomUUID(),type:'fill',level:'N5',category:'grammar',prompt:'私は本を読んでしまう。「しまう」の使い方を考えましょう。',answer:'しまう',acceptedAnswers:['しまう'],explanation:'「～てしまう」可以表示完成或遗憾。',knowledgePoints:['～てしまう'],points:10,rubric:'按参考表达与允许答案判分。',source:'builtin'}];
  db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'复习标记测试卷','N5','grammar','exam','builtin','draft',stamp,JSON.stringify(questions),JSON.stringify({level:'N5',count:2,types:['fill'],mode:'exam',source:'builtin',gradingMode:'mixed',basis:'all',model:'review-test-model'}));
  let extraBusy=false;
  const app=express(),server=app.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  app.use(localBoundary(origin));app.use(express.json({limit:'15mb'}));app.use('/api',createLearningRouter(service,db,()=>extraBusy));app.use(errorHandler);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const response=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,json:await response.json() as any};
  }
  const capture=(text='済んで',question=questions[0],scope='broad')=>{const start=question.prompt.indexOf(text);return call('/review/points',{examId:id,questionId:question.id,source:'prompt',start,end:start+text.length,text,scope,intent:'想掌握原形及常用搭配。'});};
  const get=(pointId:string)=>call('/review/points/'+pointId);
  const confirm=(pointId:string,fields:Record<string,unknown>=normalized)=>call('/review/points/'+pointId+'/confirm',fields);
  const rate=(pointId:string,rating:string,requestId=randomUUID(),examId?:string)=>call('/review/points/'+pointId+'/rate',{rating,requestId,...(examId?{examId}: {})});
  const submit=async()=>{service.saveAnswers(id,Object.fromEntries(questions.map(q=>[q.id,q.answer])));return service.submit(id);};
  const manual=async(title:string,kind='word',scope='broad')=>{const added=await call('/review/points',{text:title,level:'N5',scope,intent:'整体用法'});assert.equal(added.status,200,JSON.stringify(added.json));const result=await confirm(added.json.item.id,{...normalized,title,kind,scope});assert.equal(result.status,200,JSON.stringify(result.json));return result.json.item;};
  return {directory,db,service,id,questions,requests,origin,call,capture,get,confirm,rate,submit,manual,setExtraBusy:(value:boolean)=>{extraBusy=value;}};
}

test('review HTTP keeps exact marked language and source context, queues before submission and requires confirmation after AI normalization',async t=>{
  const {id,questions,requests,origin,service,call,capture,get,confirm,submit}=await setup(t);
  const added=await capture();assert.equal(added.status,200,JSON.stringify(added.json));const point=added.json.item;
  assert.equal(point.status,'draft');assert.equal(point.scope,'broad');assert.equal(point.sources[0].text,'済んで');assert.equal(point.sources[0].context,questions[0].prompt);
  assert.equal(point.sources[0].examId,id);assert.equal(requests.length,0);assert.equal(service.getExam(id).questions[0].answer,undefined);
  assert.equal((await call('/review/points/'+point.id+'/normalize',{})).status,403);assert.equal(requests.length,0);
  const malformed=await call('/review/points',{examId:id,questionId:questions[0].id,source:'prompt',start:0,end:3,text:'済んで',scope:'broad'});assert.equal(malformed.status,400);
  assert.ok((await call('/review/points',{examId:id,questionId:'another-question',source:'prompt',start:0,end:1,text:'宿'})).status>=400);
  const forged=await fetch(origin+'/api/review/points',{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json'},body:JSON.stringify({text:'済む',level:'N5'})});assert.equal(forged.status,403);
  await submit();const grades=JSON.stringify(service.getExam(id).grades);
  const normalizedResult=await call('/review/points/'+point.id+'/normalize',{});assert.equal(normalizedResult.status,200,JSON.stringify(normalizedResult.json));
  const candidate=(await get(point.id)).json.item;assert.equal(candidate.status,'draft');assert.equal(candidate.normalizationStatus,'completed');assert.equal(candidate.candidate.title,'済む');
  assert.equal(candidate.sources[0].text,'済んで');assert.equal(requests.length,1);assert.equal(requests[0].model,'review-test-model');
  const activated=await confirm(point.id,{...normalized,focus:'済む的常见用法及搭配，包含但不限于て形。'});assert.equal(activated.status,200);assert.equal(activated.json.item.status,'active');assert.equal(activated.json.item.title,'済む');
  assert.ok(activated.json.item.dueAt);assert.equal(JSON.stringify(service.getExam(id).grades),grades);
});

test('canonical confirmation merges repeated broad marks without resetting mastery, while context-only points remain separate',async t=>{
  const {call,capture,confirm,manual,rate,get}=await setup(t);
  const existing=await manual('済む');await rate(existing.id,'mastered');
  const draft=(await capture()).json.item;const merged=await confirm(draft.id,normalized);
  assert.equal(merged.status,200,JSON.stringify(merged.json));assert.equal(merged.json.merged,true);assert.equal(merged.json.item.id,existing.id);assert.equal(merged.json.item.status,'mastered');
  assert.equal(merged.json.item.dueAt,null);assert.ok(merged.json.item.sources.some((source:any)=>source.text==='済んで'));
  const contextual=(await capture('済んで',undefined,'context')).json.item;
  const separate=await confirm(contextual.id,{...normalized,scope:'context',focus:'本句中「済んでから」先后顺序的用法。'});
  assert.equal(separate.status,200);assert.notEqual(separate.json.item.id,existing.id);assert.equal(separate.json.item.scope,'context');
  assert.equal((await get(existing.id)).json.item.status,'mastered');
  assert.equal((await call('/review/points?status=due')).json.items.some((point:any)=>point.id===existing.id),false);
});

test('manual ratings are idempotent, do not advance familiarity several times in one day and restore priority after forgetting',async t=>{
  const {db,call,manual,rate,get}=await setup(t);
  const point=await manual('～てしまう','grammar');const requestId=randomUUID();
  const first=await rate(point.id,'good',requestId);assert.equal(first.status,200);const one=(await get(point.id)).json.item;
  assert.equal(one.stage,1);assert.ok(Date.parse(one.dueAt)>Date.now());
  await rate(point.id,'good',requestId);assert.deepEqual(stablePoint((await get(point.id)).json.item),stablePoint(one),'same request must not add another scheduling event');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM review_events WHERE point_id=?').get(point.id)!.n),1);
  await rate(point.id,'good');const sameDay=(await get(point.id)).json.item;assert.equal(sameDay.stage,1);assert.equal(sameDay.dueAt,one.dueAt);
  const forgotten=await rate(point.id,'again');assert.equal(forgotten.status,200);const reset=(await get(point.id)).json.item;assert.equal(reset.stage,0);assert.equal(reset.lapses,1);assert.ok(Date.parse(reset.dueAt)<=Date.now()+11*60000);
  await rate(point.id,'mastered');const mastered=(await get(point.id)).json.item;assert.equal(mastered.status,'mastered');assert.equal(mastered.dueAt,null);
  const paused=await call('/review/points/'+point.id,{status:'paused'},'PUT');assert.equal(paused.status,200);
  const resumed=await call('/review/points/'+point.id,{status:'active'},'PUT');assert.equal(resumed.status,200);assert.equal(resumed.json.item.status,'active');assert.ok(resumed.json.item.dueAt);
});

test('AI review papers freeze selected concepts, verify per-question coverage and preserve normal answering and grading',async t=>{
  let serial=0;
  const {service,call,manual,rate,requests,db}=await setup(t,(messages)=>{
    const payload=JSON.parse(messages.at(-1)!.content);const points=payload.reviewPoints as {id:string}[];serial++;
    return JSON.stringify({questions:Array.from({length:payload.count},(_,index)=>shape(`复习卷${serial}第${index+1}题：適切な助詞（　）を入れてください。`,[points[index%points.length].id]))});
  });
  const first=await manual('済む'),second=await manual('～てしまう','grammar');await rate(second.id,'mastered');
  const created=await call('/review/exams',{level:'N5',count:2,types:['fill'],mode:'practice',gradingMode:'mixed',pointIds:[first.id,second.id]});assert.equal(created.status,200,JSON.stringify(created.json));
  const exam=(await call('/exams/'+created.json.id)).json;assert.equal(exam.reviewPoints.length,2);assert.deepEqual(new Set(exam.reviewPoints.map((point:any)=>point.id)),new Set([first.id,second.id]));
  assert.ok(exam.questions.every((question:any)=>question.reviewPointIds.length&&question.reviewPointIds.every((id:string)=>[first.id,second.id].includes(id))));
  assert.equal(requests.length,1);assert.ok(requests[0].messages[0].content.includes('复习'));
  const savedConfig=JSON.parse(String(db.prepare('SELECT config_json FROM exams WHERE id=?').get(exam.id)!.config_json));assert.deepEqual(savedConfig.reviewSnapshot,exam.reviewPoints);
  await call('/review/points/'+first.id,{title:'済む（改名后）'},'PUT');assert.equal((await call('/exams/'+exam.id)).json.reviewPoints.find((point:any)=>point.id===first.id).title,'済む','paper keeps immutable learning target');
  await call('/exams/'+exam.id+'/answers',{answers:Object.fromEntries(exam.questions.map((question:any)=>[question.id,'が']))},'PUT');
  const result=await call('/exams/'+exam.id+'/submit',{});assert.equal(result.status,200);assert.equal(result.json.score,20);assert.equal(requests.length,1,'objective review grading remains local in mixed mode');
  const grades=JSON.stringify(result.json.grades);assert.equal((await rate(first.id,'good',randomUUID(),exam.id)).status,200);assert.equal(JSON.stringify(service.getExam(exam.id).grades),grades);
  assert.ok((await rate(first.id,'good',randomUUID(),'not-this-exam')).status>=400);
});

test('AI choice order and original option identifiers keep explanations consistent while built-in choices retain remapping',async t=>{
  const options=[{id:'C',text:'済む'},{id:'A',text:'読む'},{id:'B',text:'書く'}];
  const explanation='正确答案是 C：第一项「済む」表示事情完成，符合本句语境。';
  const {call,manual,db}=await setup(t,(messages,serial)=>{const payload=JSON.parse(messages[1].content);return JSON.stringify({questions:[{type:'single',prompt:`AI选项一致性${serial}：「仕事が（　）」に合うものを選びなさい。`,options,answer:'C',acceptedAnswers:[],explanation,knowledgePoints:['済む'],points:10,rubric:'选择 C，第一项「済む」。',...(payload.reviewPoints?{reviewPointIds:[payload.reviewPoints[0].id]}:{})}]});});
  const point=await manual('済む');
  for(const path of ['/exams','/review/exams']){
    const created=await call(path,{level:'N5',count:1,types:['single'],mode:'exam',gradingMode:'mixed',...(path==='/review/exams'?{pointIds:[point.id]}:{source:'ai'})});assert.equal(created.status,200,JSON.stringify(created.json));
    const exam=(await call('/exams/'+created.json.id)).json;assert.deepEqual(exam.questions[0].options,options,'AI option order and identifiers must remain exactly as generated');
    await call('/exams/'+exam.id+'/answers',{answers:{[exam.questions[0].id]:'C'}},'PUT');
    const submitted=await call('/exams/'+exam.id+'/submit',{});assert.equal(submitted.status,200);assert.equal(submitted.json.score,10);assert.equal(submitted.json.questions[0].answer,'C');assert.equal(submitted.json.questions[0].explanation,explanation);assert.equal(submitted.json.grades[exam.questions[0].id].correct,true);
  }
  const builtinId=randomUUID();const builtin:Question={id:builtinId,type:'single',level:'N5',category:'grammar',prompt:'内置选项重排：仕事が（　）。',options:structuredClone(options),answer:'C',acceptedAnswers:[],explanation:'「済む」表示完成。',knowledgePoints:['済む'],points:10,rubric:'选择「済む」。',source:'builtin'};
  db.prepare('INSERT INTO question_bank(id,level,category,type,question_json,source) VALUES(?,?,?,?,?,?)').run(builtinId,'N5','grammar','single',JSON.stringify(builtin),'builtin');
  const created=await call('/exams',{level:'N5',count:1,types:['single'],mode:'exam',source:'builtin',questionIds:[builtinId]});assert.equal(created.status,200,JSON.stringify(created.json));
  const paper=(await call('/exams/'+created.json.id)).json;assert.deepEqual(paper.questions[0].options.map((option:any)=>option.id),['a','b','c'],'built-in shuffle still remaps display identifiers');assert.deepEqual(paper.questions[0].options.map((option:any)=>option.text).sort(),options.map(option=>option.text).sort());
  const correct=paper.questions[0].options.find((option:any)=>option.text==='済む');await call('/exams/'+paper.id+'/answers',{answers:{[paper.questions[0].id]:correct.id}},'PUT');
  const graded=await call('/exams/'+paper.id+'/submit',{});assert.equal(graded.status,200);assert.equal(graded.json.score,10);assert.equal(graded.json.questions[0].answer,correct.id);
});

test('automatic review chooses only due active concepts and explicit invalid or unfinished selections never invoke the model',async t=>{
  const {call,manual,rate,requests}=await setup(t,(messages,serial)=>{const payload=JSON.parse(messages.at(-1)!.content);return JSON.stringify({questions:[shape(`自动复习${serial}：助詞（　）を入れてください。`,[payload.reviewPoints[0].id])]});});
  const due=await manual('済む'),mastered=await manual('～てしまう','grammar');await rate(mastered.id,'mastered');
  const paused=await manual('から');await call('/review/points/'+paused.id,{status:'paused'},'PUT');
  const draft=(await call('/review/points',{text:'未整理词',level:'N5'})).json.item;
  for(const ids of [[draft.id],[paused.id],['missing-point']])assert.ok((await call('/review/exams',{level:'N5',count:1,types:['fill'],pointIds:ids})).status>=400);
  assert.equal(requests.length,0);
  const result=await call('/review/exams',{level:'N5',count:1,types:['fill'],mode:'practice',gradingMode:'mixed'});assert.equal(result.status,200,JSON.stringify(result.json));
  const exam=(await call('/exams/'+result.json.id)).json;assert.deepEqual(exam.reviewPoints.map((point:any)=>point.id),[due.id]);
});

test('unrelated, missing-coverage and duplicate AI review questions are repaired at most once and never saved as valid papers',async t=>{
  for(const fault of ['unrelated','coverage','duplicate'] as const){
    let serial=0;
    const {call,manual,requests,db}=await setup(t,(messages)=>{
      const payload=JSON.parse(messages[1].content);const points=payload.reviewPoints as {id:string}[];serial++;
      return JSON.stringify({questions:Array.from({length:2},(_,index)=>shape(fault==='duplicate'?'每题完全相同的复习句子（　）。':`错误复习${serial}第${index}题（　）。`,[fault==='unrelated'?'not-selected':points[fault==='coverage'?0:index%points.length].id]))});
    });
    const a=await manual('済む'),b=await manual('～てしまう','grammar');const before=Number(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n);
    const result=await call('/review/exams',{level:'N5',count:2,types:['fill'],pointIds:[a.id,b.id]});assert.ok(result.status>=400,`${fault} must be rejected`);assert.equal(requests.length,2,`${fault} has one bounded repair`);assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n),before);
  }
});

test('new generation accepts forty questions and rejects forty-one while a valid historical fifty-question backup remains restorable',async t=>{
  const {call,service}=await setup(t,(messages,serial)=>{const payload=JSON.parse(messages[1].content);return JSON.stringify({questions:Array.from({length:payload.count},(_,index)=>shape(`普通卷${serial}第${index}题（　）。`))});});
  const result=await call('/exams',{level:'N5',count:40,types:['fill'],source:'ai',mode:'practice',gradingMode:'mixed'});assert.equal(result.status,200,JSON.stringify(result.json));
  const exam=(await call('/exams/'+result.json.id)).json;assert.equal(exam.questions.length,40);
  assert.equal((await call('/exams',{level:'N5',count:41,types:['fill'],source:'ai',mode:'practice'})).status,400);
  const snapshot=service.createDeletionBackup();const backup=JSON.parse(readFileSync(snapshot,'utf8'));
  const row=backup.tables.exams.find((row:any)=>row.id===exam.id);const questions=JSON.parse(row.questions_json);
  for(let index=40;index<50;index++)questions.push({...questions[0],id:randomUUID(),prompt:`历史50题卷第${index}题（　）。`});
  row.questions_json=JSON.stringify(questions);const config=JSON.parse(row.config_json);config.count=50;row.config_json=JSON.stringify(config);
  const legacyCompatible=validateBackup(backup);service.restore(legacyCompatible);assert.equal(service.getExam(exam.id).questions.length,50);
});

test('review v5 backups restore complete learning points, old versions initialize no points and malformed review records fail before writes',async t=>{
  const {service,db,call,capture,confirm,submit,rate,get}=await setup(t);
  const point=(await capture()).json.item;await submit();await confirm(point.id,normalized);await rate(point.id,'good');
  const backup=service.backup();assert.equal(backup.version,5);assert.equal(validateBackup(backup).tables.review_points.length,1);assert.equal(backup.tables.review_sources.length,1);assert.ok(backup.tables.review_events.length>=1);
  const saved=(await get(point.id)).json.item;service.restore(backup);assert.deepEqual(stablePoint((await get(point.id)).json.item),stablePoint(saved));
  for(const version of [1,2,3,4]){
    const legacy=structuredClone(backup) as any;legacy.version=version;delete legacy.tables.review_points;delete legacy.tables.review_sources;delete legacy.tables.review_events;
    if(version<4)delete legacy.tables.exam_qa_turns;if(version<3)delete legacy.tables.ai_failures;if(version<2)delete legacy.tables.exam_annotations;
    const normalizedBackup=validateBackup(legacy);assert.deepEqual(normalizedBackup.tables.review_points,[]);service.restore(normalizedBackup);assert.equal((await call('/review/points?status=all')).json.total,0);service.restore(backup);
  }
  const mutate:((copy:any)=>void)[]=[copy=>copy.tables.review_sources[0].point_id='missing-point',copy=>copy.tables.review_sources[0].exam_id='missing-exam',copy=>copy.tables.review_sources[0].text='不是原文',copy=>copy.tables.review_points[0].stage=99,copy=>copy.tables.review_points[0].status='mastered',copy=>copy.tables.review_events[0].point_id='missing-point',copy=>copy.tables.review_points[0].unknown='extra-field'];
  for(const change of mutate){const invalid=structuredClone(backup);change(invalid);const before=db.prepare('SELECT total_changes() AS n').get()!.n;assert.throws(()=>service.restore(invalid),(error:any)=>error.code==='INVALID_BACKUP');assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before);assert.equal((await get(point.id)).json.item.title,'済む');}
});

test('ordinary re-practice of review mistakes drops review references and remains restorable through both selection paths',async t=>{
  const {call,manual,service,db}=await setup(t,(messages)=>{const payload=JSON.parse(messages[1].content);return JSON.stringify({questions:[shape('復習の仕事（　）済みました。',[payload.reviewPoints[0].id])]});});
  const point=await manual('済む');
  const created=await call('/review/exams',{level:'N5',count:1,types:['fill'],pointIds:[point.id],mode:'exam',gradingMode:'mixed'});assert.equal(created.status,200,JSON.stringify(created.json));
  const review=(await call('/exams/'+created.json.id)).json;const question=review.questions[0];
  assert.deepEqual(question.reviewPointIds,[point.id]);
  await call('/exams/'+review.id+'/answers',{answers:{[question.id]:'incorrect'}},'PUT');
  const submitted=await call('/exams/'+review.id+'/submit',{});assert.equal(submitted.status,200);assert.equal(submitted.json.grades[question.id].correct,false);
  const ordinaryIds:string[]=[];
  for(const selection of [{basis:'all',questionIds:[question.id]},{basis:'mistakes'}]){
    const repeated=await call('/exams',{level:'N5',count:1,types:['fill'],source:'builtin',mode:'practice',gradingMode:'mixed',...selection});assert.equal(repeated.status,200,JSON.stringify(repeated.json));ordinaryIds.push(repeated.json.id);
    const paper=(await call('/exams/'+repeated.json.id)).json;assert.equal(paper.questions.length,1);assert.equal(paper.questions[0].prompt,question.prompt);assert.equal(paper.questions[0].reviewPointIds,undefined);assert.deepEqual(paper.reviewPoints,[]);
    const config=JSON.parse(String(db.prepare('SELECT config_json FROM exams WHERE id=?').get(paper.id)!.config_json));assert.notEqual(config.basis,'review');assert.equal(config.reviewSnapshot,undefined);
  }
  const backup=JSON.parse(readFileSync(service.createDeletionBackup(),'utf8'));assert.equal(backup.version,5);assert.doesNotThrow(()=>validateBackup(backup));
  const restored=await call('/restore',backup);assert.equal(restored.status,200,JSON.stringify(restored.json));
  for(const id of ordinaryIds){const paper=(await call('/exams/'+id)).json;assert.equal(paper.questions[0].reviewPointIds,undefined);assert.deepEqual(paper.reviewPoints,[]);}
  assert.deepEqual((await call('/exams/'+review.id)).json.reviewPoints,review.reviewPoints,'source review paper retains its frozen snapshot');
});

test('restoring a rating linked to an unsubmitted review paper is rejected before database writes',async t=>{
  const {call,manual,rate,service,db}=await setup(t,(messages)=>{const payload=JSON.parse(messages[1].content);return JSON.stringify({questions:[shape('未交卷復習の仕事（　）済みました。',[payload.reviewPoints[0].id])]});});
  const point=await manual('済む');
  const created=await call('/review/exams',{level:'N5',count:1,types:['fill'],pointIds:[point.id],mode:'exam'});assert.equal(created.status,200,JSON.stringify(created.json));
  const paper=(await call('/exams/'+created.json.id)).json;assert.equal(paper.submittedAt,null);
  const rated=await rate(point.id,'good');assert.equal(rated.status,200);
  const backup=JSON.parse(readFileSync(service.createDeletionBackup(),'utf8'));assert.doesNotThrow(()=>validateBackup(backup));
  const invalid=structuredClone(backup);invalid.tables.review_events[0].exam_id=paper.id;
  const before=db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.throws(()=>service.restore(invalid),(error:any)=>error.code==='INVALID_BACKUP');
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before);
  assert.equal((await call('/exams/'+paper.id)).json.submittedAt,null);
  assert.equal(service.reviews.get(point.id).repetitions,1);
});

test('deleting a source paper preserves its reusable knowledge and source snapshot, while clearing all personal learning deletes review records',async t=>{
  const {id,db,service,call,capture,confirm,submit,get}=await setup(t);const point=(await capture()).json.item;await submit();await confirm(point.id,normalized);
  const preview=await call('/data/delete-preview',{scope:'exam',id});assert.equal(preview.status,200);const deleted=await call('/data',{token:preview.json.token,confirmation:'删除'},'DELETE');assert.equal(deleted.status,200);
  const retained=(await get(point.id)).json.item;assert.equal(retained.title,'済む');assert.equal(retained.sources[0].examId,null);assert.equal(retained.sources[0].text,'済んで');assert.ok(retained.sources[0].context.includes('宿題が済んでから'));
  const safety=validateBackup(JSON.parse(readFileSync(deleted.json.beforeDeleteBackup,'utf8')));assert.equal(safety.tables.review_points.length,1);service.restore(safety);
  const tokenId=randomUUID();db.prepare("INSERT INTO ai_token_usage(id,created_at,model,status,usage_state) VALUES(?,?,?,'failed','unavailable')").run(tokenId,new Date().toISOString(),'test-model');
  const all=await call('/data/delete-preview',{scope:'all'});assert.equal(all.status,200);assert.equal((await call('/data',{token:all.json.token,confirmation:'删除'},'DELETE')).status,200);
  for(const table of ['review_points','review_sources','review_events'])assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM '+table).get()!.n),0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM ai_token_usage').get()!.n),1);
});

test('normalization holds the global learning lock and logs each failure without changing saved marks or grades', {timeout:20_000},async t=>{
  let started!:()=>void,release!:()=>void;
  const began=new Promise<void>(done=>{started=done;}),held=new Promise<void>(done=>{release=done;});
  let fail=true;
  const {id,service,call,capture,submit,get,setExtraBusy}=await setup(t,async()=>{started();await held;if(fail)throw Object.assign(new Error('模拟上游失败。'),{code:'MODEL_REVIEW_ERROR',status:502,diagnostics:{upstreamStatus:503,upstreamMessage:'Synthetic review failure.',requestId:'req-review-normalize'}});return JSON.stringify(normalized);});
  t.after(()=>release());const point=(await capture()).json.item;await submit();const grades=JSON.stringify(service.getExam(id).grades);const backup=service.backup();
  setExtraBusy(true);assert.equal((await call('/review/points/'+point.id+'/normalize',{})).status,409);setExtraBusy(false);
  const flight=call('/review/points/'+point.id+'/normalize',{});await began;assert.equal(service.isBusy(),true);
  assert.equal((await call('/data/delete-preview',{scope:'all'})).status,409);assert.equal((await call('/restore',backup)).status,409);assert.equal((await call('/exams/'+id+'/retry',{})).status,409);
  release();await flight;const failed=(await get(point.id)).json.item;assert.equal(failed.status,'draft');assert.equal(failed.normalizationStatus,'failed');assert.ok(failed.error);
  const history=service.diagnostics.list({operation:'review'});assert.equal(history.total,1);assert.equal(history.items[0].upstreamMessage,'Synthetic review failure.');assert.equal(history.items[0].requestId,'req-review-normalize');
  fail=false;await call('/review/points/'+point.id+'/normalize',{});assert.equal((await get(point.id)).json.item.normalizationStatus,'completed');assert.equal(service.diagnostics.list({operation:'review'}).total,1);assert.equal(JSON.stringify(service.getExam(id).grades),grades);
});
