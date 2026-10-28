import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { FailureDiagnostics } from '../server/diagnostics.js';
import { ReviewService,validateReviewBackup } from '../server/review.js';
import { selectExistingUsages } from '../server/review-verification.js';

const plain={title:'～ておく',kind:'grammar' as const,reading:'ておく',meaning:'事先做好准备。',focus:'在需要之前事先完成某件事情。',note:''};
const answer=(input:any,outcome='verified',usageKey='事前準備')=>({...plain,usageKey,assessment:{outcome,reason:outcome==='uncertain'?'缺少能判断具体义项的上下文。':outcome==='corrected'?'原理解把事前准备误当成后悔，应按原句纠正。':'原文支持这个用法。',evidence:outcome==='uncertain'?[]:[input.context],originalUnderstanding:input.intent||''}});
function setup(t:TestContext,reply:(input:any,n:number)=>unknown=(input)=>answer(input)){
  const db=openDatabase(':memory:');let calls=0,clock=new Date('2026-10-28T02:00:00.000Z');const requests:any[]=[];
  const service=new ReviewService(db,{async generate(messages){const input=JSON.parse(messages[1].content);requests.push(input);const result=reply(input,++calls);if(result instanceof Error)throw result;return JSON.stringify(result);}},{diagnostics:new FailureDiagnostics(db),now:()=>clock});
  const add=(text='旅行の前にホテルを予約しておきます。',intent='事先准备的用法',scope:'broad'|'context'='context')=>service.add({text,intent,scope,level:'N4'}).item;
  const snapshot=()=>({review_points:db.prepare('SELECT * FROM review_points').all(),review_sources:db.prepare('SELECT * FROM review_sources').all(),review_events:db.prepare('SELECT * FROM review_events').all()});
  const manual=(text:string,title=plain.title)=>{const draft=add(text);return service.confirm(draft.id,{...plain,title}).item;};
  t.after(()=>db.close());return {service,db,add,manual,snapshot,requests,calls:()=>calls,advance:()=>{clock=new Date(clock.getTime()+86400_000);}};
}

test('one normalization corrects a misconception with exact evidence and joins review automatically',async t=>{
  const {service,add,calls}=setup(t,input=>answer(input,'corrected'));const draft=add(undefined,'我认为这是后悔的用法。');
  const result=await service.normalize(draft.id);assert.equal(calls(),1);assert.equal(result.item.status,'active');assert.equal(result.item.verification?.outcome,'corrected');assert.equal(result.item.usageKey,'事前準備');assert.match(result.item.focus,/事先/);assert.equal(service.choose({level:'N4',count:1})[0].id,result.item.id);assert.equal(result.item.verificationCurrent,true);
});
test('uncertain drafts are isolated, not failures, and no manual confirm, rate or hand-picked exam bypass exists',async t=>{
  const {service,add}=setup(t,input=>answer(input,'uncertain'));const draft=add('ように','这个就是目的用法。');const result=await service.normalize(draft.id);
  assert.equal(result.item.verification?.outcome,'uncertain');assert.equal(result.item.normalizationStatus,'none');assert.equal(service.list({status:'draft'}).total,0);assert.equal(service.list({status:'uncertain'}).total,1);
  assert.throws(()=>service.confirm(draft.id,plain),{code:'REVIEW_UNCERTAIN'});assert.throws(()=>service.rate(draft.id,{rating:'good',requestId:randomUUID()}),{code:'REVIEW_UNCERTAIN'});assert.throws(()=>service.choose({level:'N4',count:1,ids:[draft.id]}),{code:'INVALID_REVIEW_SELECTION'});assert.throws(()=>service.choose({level:'N4',count:1}),{code:'NO_DUE_REVIEW_POINTS'});
});
test('uncertain existing cards preserve history but cannot be restored to active or mastered manually',async t=>{
  const {service,manual,snapshot}=setup(t,input=>answer(input,'uncertain'));const old=manual('ように');service.rate(old.id,{rating:'mastered',requestId:randomUUID()});const before=snapshot();const result=await service.audit(old.id);
  assert.equal(result.item.stage,7);assert.equal(result.item.status,'mastered');assert.deepEqual(snapshot().review_events,before.review_events);assert.throws(()=>service.update(old.id,{status:'active'}),{code:'REVIEW_UNCERTAIN'});assert.throws(()=>service.update(old.id,{status:'mastered'}),{code:'REVIEW_UNCERTAIN'});
});
test('uncertain audit reports do not claim a progress reset when proposed kind and usage differ',async t=>{
  const {service,manual,snapshot}=setup(t,(input,n)=>n===1?answer(input):{...answer(input,'uncertain','未確定'),kind:'expression'});
  const old=manual('ホテルを予約しておきます。');await service.audit(old.id);service.rate(old.id,{rating:'mastered',requestId:randomUUID()});const before=service.get(old.id),history=snapshot().review_events;
  const result=await service.audit(old.id,{force:true});assert.equal(result.item.verification?.outcome,'uncertain');assert.notEqual(result.item.verification?.progressReset,true);assert.equal(result.item.stage,before.stage);assert.equal(result.item.status,before.status);assert.equal(result.item.dueAt,before.dueAt);assert.equal(result.item.usageKey,before.usageKey);assert.equal(result.item.kind,before.kind);assert.deepEqual(snapshot().review_events,history);
});
test('clarification invalidates cached uncertainty without autoactivating and a subsequent checked result resolves it',async t=>{
  const {service,add,calls,snapshot}=setup(t,input=>input.notes?{...answer(input),assessment:{...answer(input).assessment,evidence:['旅行の前にホテルを予約しておきます。']}}:answer(input,'uncertain'));
  const draft=add('ておく');await service.normalize(draft.id);await service.audit(draft.id);assert.equal(calls(),1);assert.equal(service.auditOverview().eligibleCount,0);
  const clarified=service.clarify(draft.id,{text:'原句：旅行の前にホテルを予約しておきます。'});assert.equal(clarified.item.status,'draft');assert.equal(clarified.item.verification?.outcome,'uncertain');assert.equal(clarified.item.verificationCurrent,false);
  const result=await service.audit(draft.id);assert.equal(calls(),2);assert.equal(result.item.status,'active');assert.equal(result.item.verification?.outcome,'verified');assert.equal(result.item.sources.length,2);assert.doesNotThrow(()=>validateReviewBackup(snapshot()));
});
test('same-name different semantic uses remain separate while exact verified duplicates merge',async t=>{
  const {service,add}=setup(t,input=>({...answer(input,'verified',input.intent.includes('后悔')?'後悔':'完了'),title:'～てしまう',reading:'てしまう'}));
  const complete=await service.normalize(add('宿題を全部やってしまった。','全部完成').id);const regret=await service.normalize(add('大事な切符をなくしてしまった。','后悔').id);
  assert.notEqual(complete.item.id,regret.item.id);assert.equal(service.list({status:'all'}).total,2);
  const duplicate=await service.normalize(add('レポートをもう書いてしまいました。','全部完成').id);assert.equal(duplicate.merged,true);assert.equal(duplicate.item.id,complete.item.id);assert.equal(duplicate.item.sources.length,2);assert.equal(service.list({status:'all'}).total,2);
});
test('auditing old incorrect mastered usage resets current stage but retains every historical rating',async t=>{
  const {service,manual,snapshot}=setup(t,input=>answer(input,'corrected'));const old=manual('ホテルを予約しておきます。');service.rate(old.id,{rating:'mastered',requestId:randomUUID()});const before=snapshot();const result=await service.audit(old.id);
  assert.equal(result.item.status,'active');assert.equal(result.item.stage,0);assert.equal(result.item.repetitions,1);assert.equal(result.item.verification?.progressReset,true);assert.deepEqual(snapshot().review_events,before.review_events);assert.doesNotThrow(()=>validateReviewBackup(snapshot()));
});
test('existing equivalent cards merge as aliases, preserving strongest mastery, original events and sources',async t=>{
  const {service,manual,snapshot,db}=setup(t,input=>answer(input));const first=manual('一つ目の準備をしておきます。','～ておく'),second=manual('二つ目の準備をしておきます。','ておく');service.rate(second.id,{rating:'mastered',requestId:randomUUID()});const before=snapshot().review_events;
  await service.audit(first.id);const result=await service.audit(second.id);assert.equal(result.merged,true);assert.equal(result.item.stage,7);assert.equal(result.item.status,'mastered');assert.equal(result.item.repetitions,1);assert.equal(result.item.sources.length,2);assert.equal(service.list({status:'all'}).total,1);assert.equal(db.prepare('SELECT merged_into FROM review_points WHERE id=?').get(second.id)!.merged_into,first.id);assert.deepEqual(snapshot().review_events,before);assert.doesNotThrow(()=>validateReviewBackup(snapshot()));
  service.remove(first.id);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_points').get()!.n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_events').get()!.n,0);
});
test('bad evidence or unsupported unstructured replies cannot update an old card or its history',async t=>{
  const {service,manual,snapshot}=setup(t,input=>({...answer(input),assessment:{...answer(input).assessment,evidence:['这个句子从未出现。']}}));const old=manual('ホテルを予約しておきます。');service.rate(old.id,{rating:'good',requestId:randomUUID()});const before=snapshot();const result=await service.audit(old.id);
  assert.equal(result.item.normalizationStatus,'failed');assert.match(result.item.error!,/INVALID_REVIEW_EVIDENCE/);for(const key of ['title','focus','meaning','stage','due_at','repetitions','lapses','verification_json'])assert.equal(snapshot().review_points[0][key],before.review_points[0][key]);assert.deepEqual(snapshot().review_events,before.review_events);
});
test('a new duplicate cannot clear an existing uncertain card without checking its original sources',async t=>{
  const {service,add,manual}=setup(t,(input,n)=>answer(input,n===2?'uncertain':'verified'));
  const old=manual('以前の原文では準備しておきます。');await service.audit(old.id);await service.audit(old.id,{force:true});assert.equal(service.get(old.id).verification?.outcome,'uncertain');
  const merged=await service.normalize(add('新しい原文でも準備しておきます。').id);assert.equal(merged.merged,true);assert.equal(merged.item.verification?.outcome,'uncertain');assert.equal(merged.item.verificationCurrent,false);assert.equal(service.auditOverview().eligibleCount,1);assert.throws(()=>service.choose({level:'N4',count:1,ids:[old.id]}),{code:'INVALID_REVIEW_SELECTION'});
  const checked=await service.audit(old.id);assert.equal(checked.item.verification?.outcome,'verified');assert.equal(checked.item.sources.length,2);
});
test('batch verification is server-owned, counts uncertainty separately and skips unchanged successful checks',async t=>{
  const {service,add,calls}=setup(t,input=>answer(input,input.context==='ように'?'uncertain':'verified'));add();add('ように');const start=service.startAuditBatch({});assert.equal(start.batch.kind,'audit');
  for(let n=0;n<100&&service.auditOverview().batch?.status==='running';n++)await new Promise(resolve=>setTimeout(resolve,5));
  const done=service.auditOverview();assert.equal(done.batch?.status,'completed');assert.equal(done.batch?.succeeded,1);assert.equal(done.batch?.uncertain,1);assert.equal(done.batch?.failed,0);assert.equal(calls(),2);assert.equal(done.eligibleCount,0);assert.throws(()=>service.startAuditBatch({}),{code:'NO_REVIEW_AUDIT_PENDING'});assert.equal(calls(),2);
});
test('backup rejects alias cycles, nonexistent targets and unsafe verification reports',async t=>{
  const {service,manual,snapshot}=setup(t,input=>answer(input));const old=manual('ホテルを予約しておきます。');await service.audit(old.id);const good=snapshot();assert.doesNotThrow(()=>validateReviewBackup(good));
  const cycle=structuredClone(good);cycle.review_points[0].merged_into=old.id;cycle.review_points[0].canonical_key=null;assert.throws(()=>validateReviewBackup(cycle));
  const missing=structuredClone(good);missing.review_points[0].merged_into='missing';missing.review_points[0].canonical_key=null;assert.throws(()=>validateReviewBackup(missing));
  const unsafe=structuredClone(good);const report=JSON.parse(String(unsafe.review_points[0].verification_json));report.reason='Bearer '+["sk","real","secret","value","123456789"].join('-');unsafe.review_points[0].verification_json=JSON.stringify(report);assert.throws(()=>validateReviewBackup(unsafe));
});
test('semantic matching context excludes dozens of unrelated cards, keeps same-name senses and obeys its character budget',()=>{
  const item=(title:string,usage_key:string)=>({title,usage_key,kind:'grammar',scope:'context',meaning:'含义'.repeat(150),focus:'训练目标'.repeat(150)});
  const unrelated=Array.from({length:80},(_,index)=>item('無関係漢字番号'+index,'無関係'));
  const all=[...unrelated,item('～てしまう','完了'),item('～てしまう','後悔'),item('～ておく','事前準備')];
  const selected=selectExistingUsages(all,['てしまった']);assert.deepEqual(selected.map(item=>item.usageKey),['完了','後悔']);assert.ok(JSON.stringify(selected).length<=4000);
  assert.equal(selectExistingUsages(all,['済んで']).length,0);assert.equal(selectExistingUsages([item('済む','全体用法')],['済んで'])[0].title,'済む');assert.equal(selectExistingUsages(all,['ておきます'])[0].usageKey,'事前準備');
});
