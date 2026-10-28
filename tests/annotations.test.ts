import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Import annotations first deliberately: its runtime schemas must not depend on
// learning.ts initializing first through a circular import.
import { AnnotationService, annotationExplanationSchema, annotationRowSchema, validateAnnotationAnchor, validateAnnotationRecord, type AnnotationRow } from '../server/annotations.js';
import { openDatabase } from '../server/db.js';
import { LearningService, type AIProvider } from '../server/learning.js';
import type { Question } from '../server/seed.js';

type MarkInput={questionId:string;source:'prompt'|'passage'|'option';optionId?:string;start:number;end:number;text:string};
type RequestData={question:Question;marks:{id:string;source:string;optionId:string;start:number;end:number;text:string}[]};
const explanation={reading:'にほんご',meaning:'当前语境中的日语。',analysis:'「を」标记动作对象；结合前后文理解。',examples:[{ja:'日本語を読みます。',zh:'读日语。'}],tip:'保留当前语境，不孤立地记忆。'};
const config={level:'N5',count:1,types:['reading'],category:'reading',mode:'practice',source:'builtin',basis:'all',gradingMode:'mixed',model:'test-selected-model'};
function question(id='q-1',prompt='😀日本語を勉強します。日本語の文章を読んでください。e\u0301'):Question {
  return {id,type:'reading',level:'N5',category:'reading',prompt,passage:'昨日、学校で日本語を勉強しました。今日は図書館で本を読みます。',options:[{id:'option-real-b',text:'学校で日本語を勉強しました。'},{id:'option-real-a',text:'家で英語を勉強しました。'}],answer:'option-real-b',acceptedAnswers:[],explanation:'昨天在学校学习日语。',knowledgePoints:['〜を〜ます'],points:10,rubric:'选对满分，其他零分。',source:'builtin'};
}
function insertExam(db:DatabaseSync,id:string,questions:Question[]) {
  db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'原创标记测试','N5','reading','practice','builtin','draft',new Date().toISOString(),JSON.stringify(questions),JSON.stringify({...config,count:questions.length}));
}
function setup(t:TestContext,ai?:AIProvider,questions:Question[]=[question()]) {
  const directory=mkdtempSync(join(tmpdir(),'japanese-annotations-'));
  const db=openDatabase(':memory:');insertExam(db,'exam-1',questions);
  const learning=new LearningService(db,ai,{backupDir:join(directory,'backups')});
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  return {db,learning,service:learning.annotations,questions,directory};
}
function select(q:Question,source:MarkInput['source'],needle:string,optionId?:string,occurrence=0):MarkInput {
  const text=source==='prompt'?q.prompt:source==='passage'?q.passage!:q.options!.find(o=>o.id===optionId)!.text;
  let start=-1;for(let i=0;i<=occurrence;i++)start=text.indexOf(needle,start+1);
  assert.ok(start>=0,'test quote is present');return {questionId:q.id,source,...(optionId?{optionId}:{}),start,end:start+needle.length,text:needle};
}
const request=(messages:Parameters<AIProvider['generate']>[0])=>JSON.parse(messages.find(m=>m.role==='user')!.content) as RequestData;
const output=(data:RequestData)=>JSON.stringify({explanations:data.marks.map(mark=>({id:mark.id,...explanation}))});
const byId=(db:DatabaseSync,id:string)=>db.prepare('SELECT * FROM exam_annotations WHERE id=?').get(id) as AnnotationRow;

test('anchors match saved prompt, passage and explicit option IDs; repeats and overlapping ranges stay separate',t=>{
  const {db,service,questions:[q]}=setup(t);
  const first=service.add('exam-1',select(q,'prompt','日本語'));
  assert.equal(first.created,true);assert.equal(first.item.status,'marked');assert.equal(first.item.explanation,null);
  const duplicate=service.add('exam-1',select(q,'prompt','日本語'));assert.equal(duplicate.created,false);assert.equal(duplicate.item.id,first.item.id);
  const second=service.add('exam-1',select(q,'prompt','日本語',undefined,1));assert.notEqual(second.item.id,first.item.id);
  service.add('exam-1',select(q,'prompt','日本語を勉強'));
  const passage=service.add('exam-1',select(q,'passage','学校'));
  const option=service.add('exam-1',select(q,'option','日本語','option-real-b'));assert.equal(option.item.optionId,'option-real-b');
  assert.equal(service.list('exam-1').items.length,5);assert.deepEqual(service.list('exam-1').limits,{perExam:40,perQuestion:8,maxText:500});
  validateAnnotationAnchor(byId(db,passage.item.id),[q]);
  assert.throws(()=>service.add('exam-1',{...select(q,'prompt','日本語'),text:'任意文本'}));
  assert.throws(()=>service.add('exam-1',{...select(q,'prompt','日本語'),questionId:'another-question'}));
  assert.throws(()=>service.add('exam-1',{...select(q,'prompt','日本語'),source:'answer'}));
  assert.throws(()=>service.add('exam-1',{...select(q,'prompt','日本語'),optionId:'option-real-b'}));
  assert.throws(()=>service.add('exam-1',{...select(q,'option','日本語','option-real-b'),optionId:'a'}));
  assert.throws(()=>service.add('exam-1',{...select(q,'passage','学校'),source:'prompt'}));
  assert.throws(()=>service.add('exam-1',{...select(q,'prompt','日本語'),extra:true}));
});

test('UTF-16 boundaries preserve emoji and combining text without normalization or quote trimming',t=>{
  const {service,questions:[q]}=setup(t);
  const emoji=service.add('exam-1',select(q,'prompt','😀'));assert.equal(emoji.item.start,0);assert.equal(emoji.item.end,2);
  for(const [start,end] of [[0,1],[1,2]])assert.throws(()=>service.add('exam-1',{questionId:q.id,source:'prompt',start,end,text:q.prompt.slice(start,end)}),(e:any)=>e.code==='INVALID_ANNOTATION_ANCHOR');
  service.add('exam-1',select(q,'prompt','e\u0301'));
  assert.throws(()=>service.add('exam-1',{...select(q,'prompt','e\u0301'),text:'é'}));
  for(const range of [{start:-1,end:2},{start:0.5,end:2},{start:5,end:4},{start:0,end:100_000}])assert.throws(()=>service.add('exam-1',{questionId:q.id,source:'prompt',text:'😀',...range}));
  const spaced=question('q-space',' 前後 ');const {service:other}=setup(t,undefined,[spaced]);
  assert.equal(other.add('exam-1',select(spaced,'prompt',' 前')).item.text,' 前');
  assert.throws(()=>other.add('exam-1',select(spaced,'prompt',' ')));
});

test('serialized explanations exceeding backup row limits fail without persisting an unrestorable result',async t=>{
  const ai:AIProvider={generate:async messages=>JSON.stringify({explanations:request(messages).marks.map(mark=>({id:mark.id,...explanation,meaning:'\u0001'.repeat(8000),analysis:'\u0001'.repeat(12000)}))})};
  const {db,learning,service,questions:[q]}=setup(t,ai);
  service.add('exam-1',select(q,'prompt','日本語'));
  await learning.submit('exam-1');
  const result=await service.explain('exam-1');
  assert.equal(result.items[0].status,'failed');
  assert.equal(result.items[0].explanation,null);
  const row=db.prepare('SELECT * FROM exam_annotations').get() as AnnotationRow;
  assert.equal(row.explanation_json,null);
  validateAnnotationRecord(row,[q]);
  assert.doesNotThrow(()=>learning.backup());
});

test('500-character selections and both per-question and per-exam limits are enforced without charging duplicates',t=>{
  const qs=Array.from({length:6},(_,i)=>question(`q-${i+1}`,'abcdefghij'.repeat(70)));
  const {service}=setup(t,undefined,qs);
  const max={questionId:qs[0].id,source:'prompt' as const,start:0,end:500,text:qs[0].prompt.slice(0,500)};
  const full=service.add('exam-1',max);assert.equal(full.item.text.length,500);service.remove('exam-1',full.item.id);
  assert.throws(()=>service.add('exam-1',{...max,end:501,text:qs[0].prompt.slice(0,501)}));
  let originalId='';
  for(let i=0;i<5;i++)for(let j=0;j<8;j++){
    const result=service.add('exam-1',{questionId:qs[i].id,source:'prompt',start:j,end:j+1,text:qs[i].prompt.slice(j,j+1)});
    if(!i&&!j)originalId=result.item.id;
  }
  assert.equal(service.list('exam-1').items.length,40);
  assert.equal(service.add('exam-1',{questionId:qs[0].id,source:'prompt',start:0,end:1,text:'a'}).item.id,originalId);
  assert.throws(()=>service.add('exam-1',{questionId:qs[0].id,source:'prompt',start:8,end:9,text:'i'}),(e:any)=>e.code==='ANNOTATION_LIMIT');
  assert.throws(()=>service.add('exam-1',{questionId:qs[5].id,source:'prompt',start:0,end:1,text:'a'}),(e:any)=>e.code==='ANNOTATION_LIMIT');
  service.remove('exam-1',originalId);service.add('exam-1',{questionId:qs[5].id,source:'prompt',start:0,end:1,text:'a'});assert.equal(service.list('exam-1').items.length,40);
});

test('only submission permits explanation; per-question practice feedback and cached rows do not bypass it',async t=>{
  let calls=0;const {db,service,learning,questions:[q]}=setup(t,{async generate(messages){calls++;return output(request(messages));}});
  const mark=service.add('exam-1',select(q,'prompt','日本語')).item;
  assert.equal(service.list('exam-1').canExplain,false);
  await assert.rejects(service.explain('exam-1'),(e:any)=>e.code==='ANNOTATION_NOT_SUBMITTED');
  learning.saveAnswers('exam-1',{[q.id]:q.answer});await learning.feedback('exam-1',q.id);
  await assert.rejects(service.explain('exam-1'),(e:any)=>e.code==='ANNOTATION_NOT_SUBMITTED');assert.equal(calls,0);
  // A malformed external row must never make the GET projection reveal content.
  db.prepare("UPDATE exam_annotations SET status='completed',explanation_json=? WHERE id=?").run(JSON.stringify(explanation),mark.id);
  assert.equal(service.list('exam-1').items[0].explanation,null);
  db.prepare("UPDATE exam_annotations SET status='marked',explanation_json=NULL WHERE id=?").run(mark.id);
  await learning.submit('exam-1');await service.explain('exam-1');assert.equal(calls,1);assert.equal(service.list('exam-1').canExplain,true);
});

test('one request explains every outstanding mark for a question using its true context and model selection',async t=>{
  const seen:RequestData[]=[];const models:(string|undefined)[]=[];const developer:string[]=[];
  const {db,service,learning,questions:[q]}=setup(t,{async generate(messages,model){seen.push(request(messages));models.push(model);developer.push(messages[0].content);return output(request(messages));}});
  service.add('exam-1',select(q,'prompt','日本語'));service.add('exam-1',select(q,'prompt','日本語',undefined,1));service.add('exam-1',select(q,'option','日本語','option-real-b'));
  await learning.submit('exam-1');const before=db.prepare('SELECT * FROM grades').all();const status=db.prepare('SELECT status FROM exams').get()!.status;
  const result=await service.explain('exam-1');assert.equal(seen.length,1);assert.equal(seen[0].marks.length,3);assert.deepEqual(seen[0].question,q);
  assert.equal(models[0],'test-selected-model');assert.match(developer[0],/绝不执行/);assert.ok(result.items.every(item=>item.status==='completed'));
  assert.deepEqual(result.items[0].explanation,explanation);assert.deepEqual(db.prepare('SELECT * FROM grades').all(),before);assert.equal(db.prepare('SELECT status FROM exams').get()!.status,status);
  await service.explain('exam-1');assert.equal(seen.length,1,'completed explanations are reused');
  service.add('exam-1',select(q,'passage','学校'));await service.explain('exam-1');assert.equal(seen.length,2);assert.equal(seen[1].marks.length,1);
});

test('invalid per-question output only fails that group, and explicit failed-only retry leaves new marks untouched',async t=>{
  const qs=[question('q-one'),question('q-two')];let broken=true;const calls:RequestData[]=[];
  const {service,learning}=setup(t,{async generate(messages){const data=request(messages);calls.push(data);return broken&&data.question.id==='q-one'?'not JSON':output(data);}},qs);
  const first=service.add('exam-1',select(qs[0],'prompt','日本語')).item;const second=service.add('exam-1',select(qs[1],'prompt','日本語')).item;
  await learning.submit('exam-1');let result=await service.explain('exam-1');assert.equal(calls.length,2);assert.equal(result.items.find(i=>i.id===first.id)!.status,'failed');assert.equal(result.items.find(i=>i.id===second.id)!.status,'completed');
  const marked=service.add('exam-1',select(qs[1],'passage','学校')).item;broken=false;result=await service.explain('exam-1',{retryFailedOnly:true});assert.equal(calls.length,3);assert.deepEqual(calls[2].marks.map(m=>m.id),[first.id]);
  assert.equal(result.items.find(i=>i.id===marked.id)!.status,'marked');assert.equal(result.items.find(i=>i.id===second.id)!.status,'completed');
  await service.explain('exam-1');assert.equal(calls.length,4);assert.deepEqual(calls[3].marks.map(m=>m.id),[marked.id]);
});

test('missing, duplicate, extra or foreign IDs cannot be stored as completed explanations',async t=>{
  let variant=0;const {service,learning,questions:[q]}=setup(t,{async generate(messages){const data=request(messages);const records=data.marks.map(mark=>({id:mark.id,...explanation}));
    switch(variant++){
      case 0:return JSON.stringify({explanations:records.slice(1)});
      case 1:return JSON.stringify({explanations:[records[0],records[0]]});
      case 2:return JSON.stringify({explanations:[...records,{id:'extra',...explanation}]});
      case 3:return JSON.stringify({explanations:records.map((record,i)=>i?record:{...record,id:'foreign-question-mark'})});
      default:return output(data);
    }
  }});
  service.add('exam-1',select(q,'prompt','日本語'));service.add('exam-1',select(q,'passage','学校'));await learning.submit('exam-1');
  for(let i=0;i<4;i++){const result=await service.explain('exam-1');assert.ok(result.items.every(item=>item.status==='failed'&&item.explanation===null));}
  const result=await service.explain('exam-1');assert.ok(result.items.every(item=>item.status==='completed'));
});

test('same-paper concurrent explanation shares work and registers its lock before the first await',async t=>{
  let release!:(text:string)=>void;let calls=0;let captured!:RequestData;
  const delayed=new Promise<string>(resolve=>{release=resolve;});
  const {service,learning,questions:[q]}=setup(t,{async generate(messages){calls++;captured=request(messages);return delayed;}});
  const item=service.add('exam-1',select(q,'prompt','日本語')).item;await learning.submit('exam-1');
  const one=service.explain('exam-1');assert.equal(service.isBusy(),true);assert.equal(learning.isBusy(),true);
  const two=service.explain('exam-1');assert.throws(()=>service.add('exam-1',select(q,'passage','学校')),(e:any)=>e.code==='ANNOTATION_BUSY'&&e.status===409);
  assert.throws(()=>service.remove('exam-1',item.id),(e:any)=>e.code==='ANNOTATION_BUSY');
  await Promise.resolve();release(output(captured));const [first,second]=await Promise.all([one,two]);assert.equal(calls,1);assert.deepEqual(first,second);assert.equal(service.isBusy(),false);
});

test('external learning work blocks annotation mutations and explanations with no request or write',async t=>{
  let externalBusy=false;let calls=0;const {db,learning,questions:[q]}=setup(t);
  const service=new AnnotationService(db,{async generate(messages){calls++;return output(request(messages));}},{isBusy:()=>externalBusy});
  const item=service.add('exam-1',select(q,'prompt','日本語')).item;await learning.submit('exam-1');externalBusy=true;
  assert.equal(service.isBusy(),false,'isBusy reports only this service flights, avoiding recursive guards');
  assert.throws(()=>service.add('exam-1',select(q,'passage','学校')),(e:any)=>e.status===409);
  assert.throws(()=>service.remove('exam-1',item.id),(e:any)=>e.status===409);
  await assert.rejects(service.explain('exam-1'),(e:any)=>e.status===409);assert.equal(calls,0);assert.equal(service.list('exam-1').items.length,1);
  externalBusy=false;await service.explain('exam-1');assert.equal(calls,1);
});

test('model errors are safe, do not become completed results, and can be retried without changing marks',async t=>{
  let calls=0;const {service,learning,questions:[q]}=setup(t,{async generate(messages){calls++;if(calls===1)throw {code:'subscription_sharing_usage_limit_exceeded',publicMessage:'套餐额度不足。'};if(calls===2)throw {publicMessage:'Bearer super-secret-token',message:'refresh_token private'};return output(request(messages));}});
  const marker=service.add('exam-1',select(q,'prompt','日本語')).item;await learning.submit('exam-1');
  let result=await service.explain('exam-1');assert.equal(result.items[0].status,'failed');assert.match(result.items[0].error!,/subscription_sharing_usage_limit_exceeded/);
  result=await service.explain('exam-1');assert.doesNotMatch(JSON.stringify(result),/super-secret|private|Bearer|refresh_token/);
  result=await service.explain('exam-1');assert.equal(result.items[0].status,'completed');assert.equal(result.items[0].id,marker.id);assert.equal(result.items[0].error,null);
});

test('removal stays scoped to the given exam and deletion of a paper cascades its annotations',t=>{
  const {db,service,questions:[q]}=setup(t);insertExam(db,'exam-2',[q]);const mark=service.add('exam-1',select(q,'prompt','日本語')).item;
  assert.throws(()=>service.remove('exam-2',mark.id),(e:any)=>e.code==='NOT_FOUND');assert.equal(service.list('exam-1').items.length,1);
  assert.equal(service.remove('exam-1',mark.id).items.length,0);service.add('exam-1',select(q,'prompt','日本語'));db.prepare('DELETE FROM exams WHERE id=?').run('exam-1');assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM exam_annotations').get()!.n),0);
});

test('annotation backup validators enforce strict schemas, real anchors and status-result consistency',t=>{
  const {db,service,questions:[q]}=setup(t);const marker=service.add('exam-1',select(q,'prompt','日本語')).item;const row=byId(db,marker.id);
  assert.ok(annotationRowSchema.shape.explanation_json);validateAnnotationRecord(row,[q]);
  const completed={...row,status:'completed' as const,explanation_json:JSON.stringify(explanation)};validateAnnotationRecord(completed,[q]);annotationExplanationSchema.parse(explanation);
  for(const bad of [{...row,status:'failed'},{...row,error:'unexpected'},{...row,explanation_json:JSON.stringify(explanation)},{...row,status:'pending',error:'unexpected'},{...completed,error:'unexpected'},{...completed,explanation_json:null},{...completed,explanation_json:'{}'},{...completed,explanation_json:'not JSON'},{...completed,explanation_json:JSON.stringify({...explanation,extra:true})},{...row,end_offset:row.end_offset+1},{...row,text:'任意文本'},{...row,extra:true}])assert.throws(()=>validateAnnotationRecord(bad,[q]));
  validateAnnotationRecord({...row,status:'failed',error:'响应中断。'},[q]);
});

test('migration 002 preserves version-1 data and restart converts pending marks into retryable failures',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'japanese-annotations-migration-'));const path=join(directory,'study.sqlite');let db=new DatabaseSync(path);
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  db.exec(readFileSync(new URL('../migrations/001.sql',import.meta.url),'utf8'));db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(1,new Date().toISOString());
  const q=question();insertExam(db,'old-exam',[q]);db.prepare('INSERT INTO answers(exam_id,question_id,answer,updated_at) VALUES(?,?,?,?)').run('old-exam',q.id,q.answer,new Date().toISOString());db.close();
  db=openDatabase(path);let learning=new LearningService(db);let service=learning.annotations;
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n),7);assert.equal(db.prepare('SELECT answer FROM answers').get()!.answer,q.answer);
  const mark=service.add('old-exam',select(q,'prompt','日本語')).item;await learning.submit('old-exam');db.prepare("UPDATE exam_annotations SET status='pending' WHERE id=?").run(mark.id);db.close();
  db=openDatabase(path);learning=new LearningService(db,{async generate(messages){return output(request(messages));}});service=learning.annotations;
  assert.equal(service.list('old-exam').items[0].status,'failed');assert.equal(service.list('old-exam').items[0].explanation,null);assert.match(service.list('old-exam').items[0].error!,/退出中断/);
  await service.explain('old-exam',{retryFailedOnly:true});assert.equal(service.list('old-exam').items[0].status,'completed');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n),7);
});
