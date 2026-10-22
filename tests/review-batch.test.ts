import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {ReviewService,type ReviewBatchStatus} from '../server/review.js';
import {openDatabase} from '../server/db.js';
import {FailureDiagnostics} from '../server/diagnostics.js';
import type {AIProvider} from '../server/learning.js';

const stamp='2026-10-22T02:00:00.000Z';
const candidate={title:'済む',kind:'word',reading:'すむ',meaning:'完成、结束。',focus:'済む的整体用法和常用搭配。',note:'以事情完成为中心理解。'};
const code=(expected:string)=>(error:unknown)=>(error as {code?:string})?.code===expected;
function setup(t:TestContext,generate?:AIProvider['generate']){
  const db=openDatabase(':memory:');let externalBusy=false;const diagnostics=new FailureDiagnostics(db);
  const service=new ReviewService(db,generate?{generate}:undefined,{diagnostics,now:()=>new Date(stamp),isBusy:()=>externalBusy});
  const manual=(text:string)=>service.add({text,level:'N4'}).item;
  t.after(()=>db.close());return {db,service,diagnostics,manual,setBusy:(value:boolean)=>{externalBusy=value;}};
}
async function finished(service:ReviewService):Promise<ReviewBatchStatus>{
  for(let tick=0;tick<1000;tick++){const state=service.batchOverview().batch;if(state&&['completed','stopped'].includes(state.status))return state;await setImmediate();}
  throw new Error('test batch did not finish');
}

test('batch snapshots every draft beyond one page and returns detached progress without activating candidates',async t=>{
  let calls=0,simultaneous=0,maxConcurrent=0;const {service,manual}=setup(t,async()=>{calls++;simultaneous++;maxConcurrent=Math.max(maxConcurrent,simultaneous);await setImmediate();simultaneous--;return JSON.stringify(candidate);});
  for(let index=0;index<106;index++)manual('原文'+index);
  const overview=service.batchOverview();assert.equal(overview.totalDraftCount,106);assert.equal(overview.eligibleCount,106);assert.equal(service.list({status:'draft',pageSize:50}).items.length,50);
  const started=service.startBatch({}).batch;assert.equal(started.total,106);assert.equal(service.isBusy(),true);
  started.status='stopped';started.items[0].status='failed';assert.equal(service.batchOverview().batch!.status,'running','read copies cannot change server task');
  const result=await finished(service);assert.equal(result.processed,106);assert.equal(result.succeeded,106);assert.equal(result.failed,0);assert.equal(calls,106);assert.equal(maxConcurrent,1);assert.equal(result.current,null);assert.ok(result.finishedAt);
  assert.equal(service.batchOverview().completedCount,106);assert.equal(service.batchOverview().eligibleCount,0);assert.equal(service.list({status:'active'}).total,0);assert.equal(service.list({status:'draft',pageSize:100}).total,106);
  assert.throws(()=>service.startBatch({}),code('NO_REVIEW_NORMALIZATION_PENDING'));
});

test('batch skips cached suggestions and unsubmitted sources with exact counts, keeping manual confirmation separate',async t=>{
  let calls=0;const {service,manual,db}=setup(t,async()=>{calls++;return JSON.stringify(candidate);});
  const cached=manual('完成済み');await service.normalize(cached.id);
  db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run('exam','待交卷','N4','word','exam','builtin','draft',stamp,JSON.stringify([{id:'q',prompt:'宿題が済んでから。'}]),'{}');
  const blocked=service.add({examId:'exam',questionId:'q',source:'prompt',start:3,end:6,text:'済んで'}).item;
  const eligible=manual('もう一つ');assert.deepEqual({...service.batchOverview(),batch:undefined},{batch:undefined,totalDraftCount:3,eligibleCount:1,completedCount:1,blockedCount:1});
  const start=service.startBatch({}).batch;assert.deepEqual(start.items.map(item=>item.id),[eligible.id]);await finished(service);assert.equal(calls,2);assert.equal(service.get(blocked.id).normalizationStatus,'none');assert.equal(service.get(cached.id).status,'draft');
  const active=service.confirm(cached.id,candidate).item;assert.equal(active.status,'active');assert.equal(active.repetitions,0);
});

test('an ordinary failure is recorded once while later items complete and only the failed item enters the next batch',async t=>{
  let calls=0;const {service,manual,diagnostics}=setup(t,async()=>{calls++;return calls===2?'not json':JSON.stringify(candidate);});
  for(const text of ['一','二','三'])manual(text);service.startBatch({});const first=await finished(service);
  assert.equal(first.status,'completed');assert.equal(first.processed,3);assert.equal(first.succeeded,2);assert.equal(first.failed,1);assert.equal(calls,3);assert.equal(first.items[1].status,'failed');assert.ok(first.items[1].error?.includes('JSON'));assert.equal(diagnostics.list({operation:'review'}).total,1);
  assert.equal(service.batchOverview().eligibleCount,1);const retry=service.startBatch({}).batch;assert.equal(retry.total,1);assert.notEqual(retry.id,first.id);assert.equal((await finished(service)).succeeded,1);assert.equal(calls,4);assert.equal(diagnostics.list({operation:'review'}).total,1);
});

test('quota, account and unavailable-model failures stop queued requests without marking them failed',async t=>{
  for(const fault of [{code:'subscription_sharing_usage_limit_exceeded',status:503},{code:'subscription_sharing_user_unavailable',status:503},{code:'AUTH_CHANGED',status:409},{code:'MODEL_UNAVAILABLE',status:400},{code:'unexpected',status:401},{code:'unexpected',status:403},{code:'unexpected',status:429}]){
    let calls=0;const {service,manual}=setup(t,async()=>{calls++;throw Object.assign(new Error('Bearer secret-test-value 请求失败。'),fault);});
    for(const text of ['一','二','三'])manual(text);service.startBatch({});const result=await finished(service);assert.equal(result.status,'stopped',fault.code);assert.equal(calls,1);assert.equal(result.processed,1);assert.equal(result.failed,1);assert.equal(result.items.filter(item=>item.status==='skipped').length,2);assert.equal(service.batchOverview().eligibleCount,3);assert.ok(!JSON.stringify(result).includes('secret-test-value'));assert.ok(result.stopReason);
  }
});

test('batch start is idempotent while running, all review mutations lock and stop waits for the current point only',async t=>{
  let release!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});const {service,manual}=setup(t,async()=>{calls++;await gate;return JSON.stringify(candidate);});
  const first=manual('一'),second=manual('二');const job=service.startBatch({}).batch;const same=service.startBatch({}).batch;assert.equal(same.id,job.id);await setImmediate();assert.equal(calls,1);
  await assert.rejects(service.normalize(first.id),code('REVIEW_BUSY'));await assert.rejects(service.normalize(second.id),code('REVIEW_BUSY'));assert.throws(()=>service.remove(second.id),code('REVIEW_BUSY'));assert.throws(()=>manual('三'),code('REVIEW_BUSY'));assert.throws(()=>service.confirm(second.id,candidate),code('REVIEW_BUSY'));
  assert.throws(()=>service.stopBatch('wrong',{}),code('REVIEW_BATCH_NOT_FOUND'));assert.throws(()=>service.stopBatch(job.id,{extra:true}));
  assert.equal(service.stopBatch(job.id,{}).batch.status,'stopping');assert.equal(service.isBusy(),true);assert.equal(service.startBatch({}).batch.id,job.id);
  release();const stopped=await finished(service);assert.equal(stopped.status,'stopped');assert.equal(stopped.processed,1);assert.equal(stopped.succeeded,1);assert.equal(calls,1);assert.equal(service.get(first.id).normalizationStatus,'completed');assert.equal(service.get(second.id).normalizationStatus,'none');assert.equal(stopped.items[1].status,'skipped');assert.equal(service.stopBatch(job.id,{}).batch.status,'stopped');assert.equal(service.isBusy(),false);
});

test('stop before dispatch performs zero requests and a new batch can resume all untouched entries',async t=>{
  let calls=0;const {service,manual}=setup(t,async()=>{calls++;return JSON.stringify(candidate);});for(const text of ['一','二'])manual(text);
  const job=service.startBatch({}).batch;service.stopBatch(job.id,{});const stopped=await finished(service);assert.equal(stopped.status,'stopped');assert.equal(stopped.processed,0);assert.equal(calls,0);assert.ok(stopped.items.every(item=>item.status==='skipped'));
  const next=service.startBatch({}).batch;assert.notEqual(next.id,job.id);assert.equal((await finished(service)).succeeded,2);assert.equal(calls,2);
});

test('batch rejects external work and malformed inputs, and missing model permission stops on its first item',async t=>{
  const {service,manual,setBusy}=setup(t);manual('一');manual('二');assert.throws(()=>service.startBatch({extra:true}));setBusy(true);assert.throws(()=>service.startBatch({}),code('REVIEW_BUSY'));assert.equal(service.batchOverview().batch,null);setBusy(false);
  service.startBatch({});const stopped=await finished(service);assert.equal(stopped.failed,1);assert.equal(stopped.status,'stopped');assert.ok(stopped.stopReason?.includes('PLAN_PERMISSION_REQUIRED'));assert.equal(stopped.items[1].status,'skipped');
});

test('a reopened service recovers interrupted point state and skips saved candidates without relying on in-memory progress',async t=>{
  let calls=0;const {db,service,diagnostics,manual}=setup(t,async()=>{calls++;return JSON.stringify(candidate);});const saved=manual('已整理'),pending=manual('中断'),queued=manual('排队');await service.normalize(saved.id);
  db.prepare("UPDATE review_points SET normalization_status='pending' WHERE id=?").run(pending.id);
  const restored=new ReviewService(db,{async generate(){calls++;return JSON.stringify(candidate);}},{diagnostics,now:()=>new Date(stamp)});
  assert.equal(restored.batchOverview().batch,null);assert.equal(restored.batchOverview().eligibleCount,2);assert.equal(restored.get(pending.id).normalizationStatus,'failed');assert.equal(restored.get(queued.id).normalizationStatus,'none');assert.equal(diagnostics.list({operation:'review'}).total,1);
  restored.startBatch({});const result=await finished(restored);assert.equal(result.succeeded,2);assert.equal(calls,3);assert.equal(restored.get(saved.id).normalizationStatus,'completed');
});
