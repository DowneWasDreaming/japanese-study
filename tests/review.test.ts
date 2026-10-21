import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ReviewService,validateReviewBackup,reviewPointRowSchema,reviewSourceRowSchema,reviewEventRowSchema } from '../server/review.js';
import { openDatabase } from '../server/db.js';
import { FailureDiagnostics } from '../server/diagnostics.js';
import type { AIProvider } from '../server/learning.js';
import type { Question } from '../server/seed.js';

const base='2026-10-21T02:00:00.000Z';
const candidate={title:'済む',kind:'word' as const,reading:'すむ',meaning:'结束、完成；事情办妥。',focus:'复习済む的原形、て形、事情完成与常见搭配，而不只背済んで这个词形。',note:'例：宿題が済む。'};
const question:Question={id:'q-one',type:'single',level:'N4',category:'grammar',prompt:'仕事が済んでから、帰ってしまいました。',options:[{id:'a',text:'工作结束以后回家了。'},{id:'b',text:'工作还没有结束。'}],answer:'a',acceptedAnswers:[],explanation:'済む表示事情完成。',knowledgePoints:['済む'],points:10,rubric:'选择a满分。'};
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&(error as {code?:string}).code===expected;
function setup(t:TestContext,ai?:AIProvider,submitted=false){
  const db=openDatabase(':memory:');if(!db.prepare("SELECT name FROM sqlite_master WHERE name='review_points'").get())db.exec(readFileSync(new URL('../migrations/006.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,submitted_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('exam-one','测试卷','N4','grammar','exam','builtin',submitted?'completed':'draft',base,submitted?base:null,JSON.stringify([question]),JSON.stringify({model:'selected-model'}));
  let clock=new Date(base),busy=false;const diagnostics=new FailureDiagnostics(db);
  const service=new ReviewService(db,ai,{diagnostics,isBusy:()=>busy,now:()=>clock});
  const add=()=>{const start=question.prompt.indexOf('済んで');return service.add({examId:'exam-one',questionId:question.id,source:'prompt',start,end:start+3,text:'済んで',scope:'broad',intent:'想复习原形和总体用法。'});};
  const manual=(title='済んで')=>service.add({text:title,level:'N4'}).item;
  const activate=(title='済む')=>{const draft=manual(title+'的标记');return service.confirm(draft.id,{...candidate,title}).item;};
  const submit=()=>db.prepare("UPDATE exams SET submitted_at=?,status='completed' WHERE id='exam-one'").run(clock.toISOString());
  const advance=(milliseconds:number)=>{clock=new Date(clock.getTime()+milliseconds);};
  const snapshot=()=>({review_points:db.prepare('SELECT * FROM review_points').all(),review_sources:db.prepare('SELECT * FROM review_sources').all(),review_events:db.prepare('SELECT * FROM review_events').all()});
  t.after(()=>db.close());return{db,service,diagnostics,add,manual,activate,submit,advance,snapshot,setBusy:(value:boolean)=>{busy=value;},clock:()=>clock};
}

test('exact marks become durable draft knowledge with original context and no automatic inference',t=>{
  let calls=0;const{service,add,db}=setup(t,{async generate(){calls++;return JSON.stringify(candidate);}});
  const first=add(),again=add();assert.equal(first.created,true);assert.equal(again.created,false);assert.equal(first.item.id,again.item.id);
  assert.equal(first.item.status,'draft');assert.equal(first.item.normalizationStatus,'none');assert.equal(first.item.canNormalize,false);assert.equal(first.item.dueAt,null);assert.equal(calls,0);
  assert.equal(first.item.sources[0].text,'済んで');assert.equal(first.item.sources[0].context,question.prompt);assert.equal(first.item.sources[0].questionPrompt,question.prompt);
  assert.ok(!JSON.stringify(first.item).includes(question.explanation));assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM review_points').get()!.n),1);
});

test('source validation rejects forged text, foreign question, unknown fields and malformed language',t=>{
  const{service,add}=setup(t);const start=question.prompt.indexOf('済んで');
  for(const input of [{examId:'exam-one',questionId:question.id,source:'prompt',start,end:start+3,text:'済んだ'},{examId:'exam-one',questionId:'wrong',source:'prompt',start,end:start+3,text:'済んで'},{text:'済む',unknown:true},{text:'\ud800'},{text:'済む',source:'option'},{text:'x'.repeat(501)}])assert.throws(()=>service.add(input));
  assert.equal(add().item.title,'済んで');
});

test('AI normalization waits for submission and returns a context-aware candidate requiring confirmation',async t=>{
  let calls=0;let payload:any;let model:string|undefined;const{service,add,submit}=setup(t,{async generate(messages,selected){calls++;payload=JSON.parse(messages[1].content);model=selected;return JSON.stringify(candidate);}});
  const point=add().item;await assert.rejects(service.normalize(point.id),code('REVIEW_NOT_SUBMITTED'));assert.equal(calls,0);
  submit();const normalized=await service.normalize(point.id);assert.equal(calls,1);assert.equal(model,'selected-model');assert.equal(normalized.item.status,'draft');assert.equal(normalized.item.dueAt,null);assert.deepEqual(normalized.item.candidate,candidate);
  await service.normalize(point.id);assert.equal(calls,1,'completed candidates are reused after uncertain retries');
  assert.equal(payload.selectedText,'済んで');assert.equal(payload.context,question.prompt);assert.equal(payload.intent,'想复习原形和总体用法。');assert.equal(payload.scope,'broad');
  const active=service.confirm(point.id,{...candidate,scope:'broad'}).item;assert.equal(active.status,'active');assert.equal(active.title,'済む');assert.equal(active.dueAt,base);assert.equal(active.candidate,null);assert.equal(active.normalizationStatus,'none');
});

test('manual confirmation can organize a saved mark without model permission or a submitted paper',t=>{
  const{service,add}=setup(t);const draft=add().item;const active=service.confirm(draft.id,candidate).item;
  assert.equal(active.status,'active');assert.equal(active.canNormalize,false);assert.equal(active.repetitions,0);assert.equal(active.sources[0].text,'済んで');
});

test('manual entries normalize without a paper while malformed output preserves each failure diagnosis',async t=>{
  let calls=0;const{service,manual,diagnostics}=setup(t,{async generate(){calls++;if(calls===1)return '{bad json';if(calls===2)throw Object.assign(new Error('connection reset'),{code:'ECONNRESET',diagnostics:{networkCode:'ECONNRESET',upstreamMessage:'Synthetic reset'}});return JSON.stringify(candidate);}});
  const draft=manual();assert.equal(draft.canNormalize,true);
  assert.equal((await service.normalize(draft.id)).item.normalizationStatus,'failed');assert.equal((await service.normalize(draft.id)).item.normalizationStatus,'failed');
  const result=await service.normalize(draft.id);assert.equal(result.item.normalizationStatus,'completed');assert.equal(result.item.status,'draft');
  const failures=diagnostics.list({operation:'review'});assert.equal(failures.total,2);assert.ok(failures.items.some(item=>item.networkCode==='ECONNRESET'));assert.ok(failures.items.every(item=>item.operation==='review'));
});

test('normalization requires all candidate fields and rejects invented fields before activation',async t=>{
  let output:unknown={title:'済む',kind:'word',focus:'整体用法'};const{service,manual,diagnostics}=setup(t,{async generate(){return JSON.stringify(output);}});
  const point=manual();assert.equal((await service.normalize(point.id)).item.normalizationStatus,'failed');
  output={...candidate,confidence:1};assert.equal((await service.normalize(point.id)).item.normalizationStatus,'failed');
  output={...candidate,meaning:''};assert.equal((await service.normalize(point.id)).item.normalizationStatus,'failed');
  assert.equal(service.get(point.id).status,'draft');assert.equal(diagnostics.list({operation:'review'}).total,3);
});

test('same-point normalization shares one flight and blocks mutations while retaining readable drafts',async t=>{
  let resolve!:()=>void;const wait=new Promise<void>(done=>resolve=done);let calls=0;const{service,manual}=setup(t,{async generate(){calls++;await wait;return JSON.stringify(candidate);}});
  const draft=manual();const first=service.normalize(draft.id),second=service.normalize(draft.id);await Promise.resolve();assert.equal(service.isBusy(),true);
  assert.equal(service.get(draft.id).normalizationStatus,'pending');assert.throws(()=>service.remove(draft.id),code('REVIEW_BUSY'));assert.throws(()=>service.add({text:'しまう'}),code('REVIEW_BUSY'));
  resolve();await Promise.all([first,second]);assert.equal(calls,1);assert.equal(service.isBusy(),false);
});

test('external work blocks review mutation but not pure selection or saved reads',async t=>{
  const{service,activate,setBusy}=setup(t);const point=activate();setBusy(true);
  for(const action of [()=>service.add({text:'しまう'}),()=>service.update(point.id,{note:'追加'}),()=>service.rate(point.id,{rating:'good',requestId:randomUUID()}),()=>service.remove(point.id)])assert.throws(action,code('REVIEW_BUSY'));
  assert.equal(service.get(point.id).title,'済む');assert.equal(service.choose({level:'N4',count:1})[0].id,point.id);
  await assert.rejects(service.normalize(point.id),code('REVIEW_BUSY'));
});

test('same canonical concept merges only sources and preserves mastered schedule, difficulty and history',t=>{
  const{service,activate,manual,snapshot}=setup(t);const existing=activate();service.rate(existing.id,{rating:'mastered',requestId:randomUUID()});const before=service.get(existing.id);
  const draft=manual('別の済んで');const result=service.confirm(draft.id,{...candidate,level:'N5'});
  assert.equal(result.merged,true);assert.equal(result.item.id,existing.id);assert.equal(result.item.status,'mastered');assert.equal(result.item.stage,7);assert.equal(result.item.dueAt,null);assert.equal(result.item.level,'N4');assert.equal(result.item.repetitions,before.repetitions);assert.equal(result.item.sources.length,2);assert.equal(snapshot().review_points.length,1);assert.equal(snapshot().review_events.length,1);
});

test('same literal concept with different scope stays separate and a card can change level explicitly',t=>{
  const{service,activate,manual}=setup(t);const broad=activate();const draft=manual('済んで2');const context=service.confirm(draft.id,{...candidate,scope:'context'}).item;
  assert.notEqual(context.id,broad.id);service.update(broad.id,{level:'N5'});assert.equal(service.choose({level:'N5',count:1})[0].id,broad.id);assert.equal(service.choose({level:'N4',count:1})[0].id,context.id);
});

test('self ratings schedule increasing gaps once per Beijing day and eventually graduate from automatic review',t=>{
  const{service,activate,advance,clock}=setup(t);const point=activate();let lastDue:string|null=null;
  for(const [index,days]of [1,3,7,14,30,60].entries()){
    const result=service.rate(point.id,{rating:'good',requestId:randomUUID()}).item;assert.equal(result.stage,index+1);assert.equal(result.dueAt,new Date(clock().getTime()+days*86400_000).toISOString());lastDue=result.dueAt;
    const same=service.rate(point.id,{rating:'good',requestId:randomUUID()}).item;assert.equal(same.stage,result.stage);assert.equal(same.dueAt,lastDue);
    advance(days*86400_000);
  }
  const mastered=service.rate(point.id,{rating:'good',requestId:randomUUID()}).item;assert.equal(mastered.status,'mastered');assert.equal(mastered.stage,7);assert.equal(mastered.dueAt,null);
  assert.throws(()=>service.choose({level:'N4',count:1}),code('NO_DUE_REVIEW_POINTS'));assert.equal(service.choose({level:'N4',count:1,ids:[point.id]})[0].id,point.id);
});

test('forgotten and difficult ratings reduce mastery while durable request IDs prevent double scheduling',t=>{
  const{service,activate,advance,clock,snapshot}=setup(t);const point=activate();const requestId=randomUUID();
  const first=service.rate(point.id,{rating:'good',requestId}),duplicate=service.rate(point.id,{rating:'good',requestId});assert.equal(first.created,true);assert.equal(duplicate.created,false);assert.equal(duplicate.item.repetitions,1);assert.equal(snapshot().review_events.length,1);
  assert.throws(()=>service.rate(point.id,{rating:'again',requestId}),code('REVIEW_IDEMPOTENCY_CONFLICT'));
  advance(86400_000);service.rate(point.id,{rating:'good',requestId:randomUUID()});
  const hard=service.rate(point.id,{rating:'hard',requestId:randomUUID()}).item;assert.equal(hard.stage,1);assert.equal(hard.dueAt,new Date(clock().getTime()+86400_000).toISOString());
  const again=service.rate(point.id,{rating:'again',requestId:randomUUID()}).item;assert.equal(again.stage,0);assert.equal(again.lapses,1);assert.equal(again.dueAt,new Date(clock().getTime()+600_000).toISOString());
});

test('review exams only allow feedback after linked submission and pure auto selection favors due weak points',t=>{
  const{db,service,activate,submit,advance}=setup(t);const weak=activate('済む'),other=activate('しまう');
  service.rate(other.id,{rating:'good',requestId:randomUUID()});assert.equal(service.choose({level:'N4',count:10}).length,1);assert.equal(service.choose({level:'N4',count:1})[0].id,weak.id);
  assert.throws(()=>service.rate(weak.id,{rating:'good',requestId:randomUUID(),examId:'exam-one'}),code('REVIEW_EXAM_NOT_SUBMITTED'));submit();
  assert.throws(()=>service.rate(weak.id,{rating:'good',requestId:randomUUID(),examId:'exam-one'}),code('REVIEW_EXAM_NOT_SUBMITTED'));
  db.prepare('UPDATE exams SET questions_json=? WHERE id=?').run(JSON.stringify([{...question,reviewPointIds:[weak.id]}]),'exam-one');assert.equal(service.rate(weak.id,{rating:'again',requestId:randomUUID(),examId:'exam-one'}).item.stage,0);
  advance(11*60_000);assert.equal(service.choose({level:'N4',count:1})[0].id,weak.id);
  for(const bad of [{level:'N5',count:1,ids:[weak.id]},{level:'N4',count:1,ids:[weak.id,other.id]},{level:'N4',count:2,ids:[weak.id,weak.id]},{level:'N4',count:41}])assert.throws(()=>service.choose(bad));
});

test('paused and mastered points stop automatic selection and can be resumed without deleting history',t=>{
  const{service,activate}=setup(t);const point=activate();service.update(point.id,{status:'paused'});assert.throws(()=>service.choose({level:'N4',count:1}),code('NO_DUE_REVIEW_POINTS'));assert.throws(()=>service.rate(point.id,{rating:'good',requestId:randomUUID()}),code('REVIEW_NOT_ACTIVE'));
  assert.equal(service.update(point.id,{status:'active'}).item.stage,0);service.rate(point.id,{rating:'mastered',requestId:randomUUID()});const resumed=service.update(point.id,{status:'active'}).item;assert.equal(resumed.dueAt,base);assert.equal(resumed.stage,0);assert.equal(resumed.repetitions,1);
});

test('paper deletion detaches source references but retains usable knowledge and individual deletion cascades records',t=>{
  const{db,service,add}=setup(t);const point=service.confirm(add().item.id,candidate).item;service.rate(point.id,{rating:'good',requestId:randomUUID()});
  db.prepare('DELETE FROM exams WHERE id=?').run('exam-one');const retained=service.get(point.id);assert.equal(retained.sources[0].examId,null);assert.equal(retained.sources[0].context,question.prompt);assert.equal(retained.title,'済む');
  service.remove(point.id);for(const table of ['review_points','review_sources','review_events'])assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),0);
});

test('pending normalization recovers exactly once and preserves completed candidates and schedules',async t=>{
  const{db,service,manual,diagnostics}=setup(t,{async generate(){return JSON.stringify(candidate);}});const pending=manual('済んで'),done=manual('しまう');await service.normalize(done.id);
  db.prepare("UPDATE review_points SET normalization_status='pending' WHERE id=?").run(pending.id);service.recoverPending('整理已中断，可重试。');service.recoverPending('整理已中断，可重试。');
  assert.equal(service.get(pending.id).normalizationStatus,'failed');assert.equal(service.get(done.id).normalizationStatus,'completed');assert.equal(diagnostics.list({operation:'review'}).total,1);
});

test('backup row schemas and semantic validator reject mismatched anchors, states, canonical keys and event counters',t=>{
  const{service,activate,snapshot}=setup(t);const point=activate();service.rate(point.id,{rating:'again',requestId:randomUUID()});const valid=snapshot();validateReviewBackup(valid,new Map([['exam-one',[question]]]));
  assert.ok(Object.keys(reviewPointRowSchema.shape).includes('canonical_key'));assert.ok(Object.keys(reviewSourceRowSchema.shape).includes('context'));assert.ok(Object.keys(reviewEventRowSchema.shape).includes('request_id'));
  for(const change of [(copy:any)=>{copy.review_points[0].canonical_key='a'.repeat(64);},(copy:any)=>{copy.review_sources[0].text='違う';},(copy:any)=>{copy.review_points[0].repetitions=99;},(copy:any)=>{copy.review_events[0].point_id='missing';},(copy:any)=>{copy.review_points[0].status='mastered';},(copy:any)=>{copy.review_sources=[];}]){const bad=structuredClone(valid);change(bad);assert.throws(()=>validateReviewBackup(bad,new Map([['exam-one',[question]]])));}
});

test('list filters preserve accurate per-scope counts, due status and bounded pagination',t=>{
  const{service,activate,manual}=setup(t);const active=activate();manual('しまう');service.update(active.id,{meaning:'事情结束，完成。'});
  const all=service.list({status:'all',pageSize:1});assert.equal(all.total,2);assert.equal(all.items.length,1);assert.equal(all.pages,2);assert.deepEqual(all.summary,{total:2,draft:1,active:1,mastered:0,paused:0,due:1});
  assert.equal(service.list({status:'due'}).items[0].id,active.id);assert.equal(service.list({status:'all',q:'事情结束'}).total,1);assert.equal(service.list({status:'all',level:'N5'}).total,0);
  for(const query of [{page:0},{status:'unknown'},{unknown:true}])assert.throws(()=>service.list(query));
});
