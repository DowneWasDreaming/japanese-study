import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthManager,IntegrationError } from '../server/auth.js';
import { ModelService } from '../server/model.js';
import { TokenUsageService,parseReportedTokenUsage,type TokenUsageEvent } from '../server/token-usage.js';

const migration = readFileSync(new URL('../migrations/005.sql',import.meta.url),'utf8');
const usage = {input_tokens:100,output_tokens:30,total_tokens:130,input_tokens_details:{cached_tokens:40},output_tokens_details:{reasoning_tokens:10}};
function entry(overrides:Partial<TokenUsageEvent> = {}):TokenUsageEvent {
  return {id:randomUUID(),occurredAt:'2026-10-20T03:00:00.000Z',model:'test-model',responseId:'resp_test_usage',status:'completed',...parseReportedTokenUsage(usage),...overrides};
}
function database(t:TestContext,path=':memory:') {
  const db=new DatabaseSync(path);db.exec(migration);t.after(()=>db.close());return db;
}
function fixture(t:TestContext,response:()=>Response|Promise<Response>) {
  const directory=mkdtempSync(join(tmpdir(),'japanese-token-model-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const state={connected:true,authorized:true};
  const auth={credentialDir:directory,accountKey:()=> 'fake-account',status:()=>({connected:state.connected,planAuthorized:state.authorized}),async getAccessToken(){
    if(!state.connected)throw new IntegrationError(401,'CHATGPT_NOT_CONNECTED','请先连接。');
    if(!state.authorized)throw new IntegrationError(403,'CHATGPT_PLAN_NOT_AUTHORIZED','请先授权。');return 'fake-transport-token';
  }} as unknown as AuthManager;
  const events:TokenUsageEvent[]=[];let requests=0;
  const transport:typeof fetch=async(input)=>{
    if(String(input).endsWith('/models'))return Response.json({models:[{slug:'test-model',display_name:'测试模型',visibility:'list'}]});
    requests++;return response();
  };
  const service=new ModelService(auth,{fetch:transport,onUsage:event=>{events.push(event);}});
  return {service,events,state,auth,transport,requests:()=>requests};
}
const sse=(events:unknown[])=>new Response(events.map(value=>'data: '+JSON.stringify(value)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const completed=(reported:unknown=usage)=>({type:'response.completed',response:{id:'resp_usage',status:'completed',usage:reported,output:[{type:'message',content:[{type:'output_text',text:'解释完成。'}]}]}});
const messages=[{role:'user' as const,content:'私の質問です。'}];

test('token counts accept real zero and treat cache/reasoning as subsets rather than additional usage',()=>{
  assert.deepEqual(parseReportedTokenUsage(usage),{usageState:'reported',inputTokens:100,outputTokens:30,totalTokens:130,cachedTokens:40,reasoningTokens:10});
  assert.deepEqual(parseReportedTokenUsage({input_tokens:0,output_tokens:0,total_tokens:0,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}),{usageState:'reported',inputTokens:0,outputTokens:0,totalTokens:0,cachedTokens:0,reasoningTokens:0});
});

test('invalid or absent core usage is unknown; absent and invalid optional detail does not discard valid totals',()=>{
  for(const invalid of [undefined,null,{},[],{...usage,input_tokens:'100'},{...usage,output_tokens:-1},{...usage,input_tokens:1.5},{...usage,total_tokens:131},{...usage,total_tokens:Number.MAX_SAFE_INTEGER+1},{input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:1,total_tokens:Number.MAX_SAFE_INTEGER}]) {
    const parsed=parseReportedTokenUsage(invalid);assert.equal(parsed.usageState,'unavailable');assert.equal(parsed.totalTokens,null);assert.equal(parsed.inputTokens,null);
  }
  for(const details of [{},{input_tokens_details:null,output_tokens_details:[]},{input_tokens_details:{cached_tokens:'40'},output_tokens_details:{reasoning_tokens:-1}},{input_tokens_details:{cached_tokens:101},output_tokens_details:{reasoning_tokens:31}}]) {
    const parsed=parseReportedTokenUsage({input_tokens:100,output_tokens:30,total_tokens:130,...details});
    assert.equal(parsed.usageState,'reported');assert.equal(parsed.totalTokens,130);assert.equal(parsed.cachedTokens,null);assert.equal(parsed.reasoningTokens,null);
  }
});

test('completed model stream records usage once without altering official request or model output',async t=>{
  const f=fixture(t,()=>sse([completed(),completed()]));assert.equal(await f.service.generate(messages),'解释完成。');
  assert.equal(f.events.length,1);const e=f.events[0];assert.equal(e.status,'completed');assert.equal(e.model,'test-model');assert.equal(e.responseId,'resp_usage');assert.equal(e.usageState,'reported');assert.equal(e.totalTokens,130);assert.ok(!Number.isNaN(Date.parse(e.occurredAt)));
  for(const privateText of ['私の質問','解释完成','fake-transport-token'])assert.ok(!JSON.stringify(e).includes(privateText));
});

test('completed output remains usable when usage is missing, malformed or callback throws',async t=>{
  for(const value of [null,{input_tokens:5,output_tokens:2,total_tokens:99}]) {
    const f=fixture(t,()=>sse([completed(value)]));assert.equal(await f.service.generate(messages),'解释完成。');assert.equal(f.events[0].usageState,'unavailable');
  }
  const f=fixture(t,()=>sse([completed()]));
  const throwing=new ModelService(f.auth,{fetch:f.transport,onUsage(){throw new Error('broken counter');}});
  assert.equal(await throwing.generate(messages),'解释完成。');
  const rejecting=new ModelService(f.auth,{fetch:f.transport,onUsage:async()=>{throw new Error('broken async counter');}});
  assert.equal(await rejecting.generate(messages),'解释完成。');
});

test('failed, incomplete and invalid terminal outputs retain reported usage while preserving original errors',async t=>{
  for(const kind of ['response.failed','response.incomplete','invalid-completed'] as const)await t.test(kind,async sub=>{
    const terminal=kind==='invalid-completed'?{...completed(),response:{...completed().response,status:'in_progress'}}:{type:kind,response:{id:'resp_failure_usage',status:kind==='response.failed'?'failed':'incomplete',usage,error:{code:'server_error',message:'Provider failed.'},incomplete_details:{reason:'max_output_tokens'}}};
    const f=fixture(sub,()=>sse([terminal]));await assert.rejects(f.service.generate(messages),{code:kind==='response.failed'?'server_error':kind==='response.incomplete'?'MODEL_RESPONSE_INCOMPLETE':'MODEL_COMPLETION_INVALID'});
    assert.equal(f.events.length,1);assert.equal(f.events[0].status,'failed');assert.equal(f.events[0].usageState,'reported');assert.equal(f.events[0].totalTokens,130);
  });
});

test('network, HTTP failures, invalid MIME and interrupted streams count actual attempts as unavailable exactly once',async t=>{
  const cases=[
    {name:'network',response:()=>{throw new TypeError('fetch failed');},code:'OPENAI_NETWORK_ERROR'},
    {name:'HTTP',response:()=>Response.json({error:{code:'server_error'}},{status:503}),code:'server_error'},
    {name:'MIME',response:()=>Response.json({output_text:'not SSE'}),code:'MODEL_STREAM_INVALID'},
    {name:'EOF',response:()=>sse([{type:'response.output_text.delta',delta:'部分结果'}]),code:'MODEL_STREAM_INTERRUPTED'},
    {name:'read failure',response:()=>new Response(new ReadableStream({start(c){c.error(new Error('disconnected'));}}),{headers:{'content-type':'text/event-stream'}}),code:'MODEL_STREAM_INTERRUPTED'},
  ];
  for(const example of cases)await t.test(example.name,async sub=>{
    const f=fixture(sub,example.response);await assert.rejects(f.service.generate(messages),{code:example.code});assert.equal(f.requests(),1);assert.equal(f.events.length,1);assert.equal(f.events[0].status,'failed');assert.equal(f.events[0].usageState,'unavailable');assert.equal(f.events[0].totalTokens,null);
  });
});

test('authentication, catalog and cached quota errors do not invent extra inference attempts',async t=>{
  const f=fixture(t,()=>sse([{type:'error',code:'subscription_sharing_usage_limit_exceeded',message:'Usage limit reached.'}]));
  f.state.authorized=false;await assert.rejects(f.service.generate(messages));assert.equal(f.events.length,0);f.state.authorized=true;
  await f.service.listModels();assert.equal(f.events.length,0);await assert.rejects(f.service.generate(messages));await assert.rejects(f.service.generate(messages));assert.equal(f.events.length,1);assert.equal(f.requests(),1);
  await assert.rejects(f.service.generate(messages,'unlisted'));assert.equal(f.events.length,1);
});

test('usage storage is idempotent, rejects forged invalid counts and never masks closed-database failures',t=>{
  const db=database(t),service=new TokenUsageService(db);const e=entry();assert.equal(service.record(e),true);assert.equal(service.record(e),false);
  assert.equal(service.record(entry({totalTokens:131})),false);assert.equal(service.record(entry({cachedTokens:101})),false);assert.equal(service.record(entry({usageState:'unavailable'})),false);
  const result=service.list({period:'all'});assert.equal(result.total,1);assert.equal(result.summary.totalTokens,130);assert.equal(result.summary.cachedTokens,40);assert.equal(result.items[0].id,e.id);
  const closed=new DatabaseSync(':memory:');closed.exec(migration);closed.close();assert.equal(new TokenUsageService(closed).record(entry()),false);
});

test('summary distinguishes unavailable counts from reported zero and missing optional detail',t=>{
  const service=new TokenUsageService(database(t));let result=service.list({period:'all'});assert.equal(result.summary.requests,0);assert.equal(result.summary.totalTokens,null);
  service.record(entry({...parseReportedTokenUsage(undefined),status:'failed'}));result=service.list({period:'all'});assert.equal(result.summary.unavailableRequests,1);assert.equal(result.summary.failedRequests,1);assert.equal(result.summary.totalTokens,null);
  service.record(entry({...parseReportedTokenUsage({input_tokens:0,output_tokens:0,total_tokens:0})}));result=service.list({period:'all'});assert.equal(result.summary.requests,2);assert.equal(result.summary.reportedRequests,1);assert.equal(result.summary.totalTokens,0);assert.equal(result.summary.cachedTokens,null);
});

test('UTC+8 calendar ranges include midnight and exclude next midnight, with stable detail pagination',t=>{
  const service=new TokenUsageService(database(t),{now:()=>new Date('2026-10-20T04:00:00.000Z')});
  for(const occurredAt of ['2026-10-13T15:59:59.999Z','2026-10-13T16:00:00.000Z','2026-10-19T15:59:59.999Z','2026-10-19T16:00:00.000Z','2026-10-20T15:59:59.999Z','2026-10-20T16:00:00.000Z'])assert.equal(service.record(entry({occurredAt})),true);
  const day=service.list({period:'day'});assert.equal(day.total,2);assert.deepEqual(day.range,{start:'2026-10-19T16:00:00.000Z',end:'2026-10-20T16:00:00.000Z'});assert.equal(day.summary.totalTokens,260);
  const week=service.list({period:'week'});assert.equal(week.total,4);assert.equal(week.range.start,'2026-10-13T16:00:00.000Z');assert.equal(service.list({period:'all'}).total,6);
  for(let i=0;i<25;i++)service.record(entry());const first=service.list({period:'all',page:1}),second=service.list({period:'all',page:2});assert.equal(first.pageSize,20);assert.equal(first.pages,2);assert.equal(first.items.length,20);assert.equal(second.items.length,11);assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,31);
  for(const query of [{period:'month'},{page:0},{page:1.2},{page:1000001},{page:'1e100'},{extra:'bad'}])assert.throws(()=>service.list(query));
});

test('usage and collection start persist on reopen without pretending to recover old requests',t=>{
  const directory=mkdtempSync(join(tmpdir(),'japanese-token-storage-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'usage.sqlite');
  let db=new DatabaseSync(path);db.exec(migration);const first=new TokenUsageService(db);const started=first.list({period:'all'}).collectionStartedAt;assert.ok(!Number.isNaN(Date.parse(started)));first.record(entry());db.close();
  db=new DatabaseSync(path);db.exec(migration);const restored=new TokenUsageService(db).list({period:'all'});assert.equal(restored.collectionStartedAt,started);assert.equal(restored.total,1);assert.equal(restored.summary.totalTokens,130);db.close();
});

test('aggregation does not expose rounded totals when reported counts exceed exact JavaScript integer range',t=>{
  const service=new TokenUsageService(database(t));service.record(entry({inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:0,totalTokens:Number.MAX_SAFE_INTEGER,cachedTokens:null,reasoningTokens:null}));service.record(entry({inputTokens:1,outputTokens:0,totalTokens:1,cachedTokens:null,reasoningTokens:null}));const result=service.list({period:'all'});assert.equal(result.summary.inputTokens,null);assert.equal(result.summary.totalTokens,null);assert.equal(result.summary.outputTokens,0);assert.equal(result.summary.reportedRequests,2);
});
