import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AuthManager, IntegrationError } from '../server/auth.js';
import { ModelService } from '../server/model.js';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApplication } from '../server/app.js';
import { validateBackup } from '../server/learning.js';
import type { ModelRequestProgress } from '../server/model-progress.js';

const encode = new TextEncoder();
const event = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const textDelta = (text = '私の秘密の答案') => ({type:'response.output_text.delta',output_index:0,content_index:0,delta:text});
const completed = (text = '完成した答案') => ({type:'response.completed',response:{id:'resp-progress-test',status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}});
const delay = (milliseconds = 5) => new Promise<void>(done => setTimeout(done,milliseconds));
async function until(predicate: () => boolean, label: string) {
  const end=Date.now()+2000;
  while(!predicate()&&Date.now()<end)await delay();
  assert.ok(predicate(),label);
}
function controlledStream(signal?:AbortSignal|null) {
  let controller:ReadableStreamDefaultController<Uint8Array>,ended=false;
  const abort=()=>{if(!ended){ended=true;controller.error(signal?.reason);}};
  const body=new ReadableStream<Uint8Array>({start(value){controller=value;signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();},cancel(){ended=true;signal?.removeEventListener('abort',abort);}});
  return {response:new Response(body,{headers:{'Content-Type':'text/event-stream','X-Request-Id':'req-progress-test'}}),
    push(value:unknown){assert.ok(!ended,'mock stream still open');controller.enqueue(encode.encode(typeof value==='string'?value:event(value)));},
    close(){if(!ended){ended=true;signal?.removeEventListener('abort',abort);controller.close();}}};
}
type Reply=(init:RequestInit)=>Response|Promise<Response>;
async function setup(t:TestContext,reply:Reply,requestTimeoutMs=1000) {
  const directory=mkdtempSync(join(tmpdir(),'japanese-progress-http-')),db=openDatabase(':memory:');seedDatabase(db);
  const auth={credentialDir:join(directory,'credentials'),accountKey:()=> 'progress-test-account',status:()=>({connected:true,planAuthorized:true}),getAccessToken:async()=> 'synthetic-progress-token'} as unknown as AuthManager;
  let calls=0;
  const transport:typeof fetch=async(input,init={})=>{
    if(String(input).endsWith('/models'))return Response.json({models:[{slug:'progress-test-model',display_name:'测试模型',visibility:'list'}]});
    assert.equal(String(input),'https://api.openai.com/v1/responses');calls++;return reply(init);
  };
  const model=new ModelService(auth,{fetch:transport,settingsFile:join(directory,'model-settings.json'),requestTimeoutMs});
  await model.listModels();
  const holder=express(),server=holder.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
  const application=createApplication({port,origin,host:'127.0.0.1',dataDir:directory,dbPath:join(directory,'study.sqlite'),credentialDir:join(directory,'credentials')},db,auth,model);
  holder.use(application.app);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const response=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json() as any};
  }
  return {...application,db,model,origin,call,calls:()=>calls};
}

test('HTTP progress distinguishes waiting headers, processing and received text without exposing the actual language or credentials',async t=>{
  let releaseHeaders!:(response:Response)=>void,stream!:ReturnType<typeof controlledStream>;
  const {model,call,calls,origin}=await setup(t,init=>{
    stream=controlledStream(init.signal);
    return new Promise<Response>((resolve,reject)=>{releaseHeaders=resolve;init.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});});
  });
  assert.deepEqual((await call('/ai/progress')).data,{items:[]});
  const running=model.generate([{role:'user',content:'PRIVATE_PROMPT_NO_PROGRESS_LEAK'}]).then(value=>({value,error:null}),error=>({value:null,error}));
  await until(()=>calls()===1,'the one inference request started');
  const before=(await call('/ai/progress')).data.items[0] as ModelRequestProgress;
  assert.equal(before.state,'waiting_headers');assert.equal(before.headersAt,null);assert.equal(before.httpStatus,null);assert.equal(before.textCharacters,0);
  releaseHeaders(stream.response);await until(()=>model.getRequestProgress().items[0]?.httpStatus===200,'HTTP response headers reached the model reader');
  stream.push({type:'response.created',response:{id:'resp-progress-test'}});
  stream.push({type:'response.reasoning_text.delta',delta:'PRIVATE_REASONING_NO_PROGRESS_LEAK'});
  await until(()=>model.getRequestProgress().items[0]?.eventCount===2,'processing events reached the reader');
  const processing=(await call('/ai/progress')).data.items[0] as ModelRequestProgress;
  assert.equal(processing.state,'processing');assert.equal(processing.httpStatus,200);assert.ok(processing.firstByteAt&&processing.firstEventAt);assert.equal(processing.firstTextAt,null);assert.equal(processing.textCharacters,0);
  stream.push(textDelta());await until(()=>model.getRequestProgress().items[0]?.textCharacters>0,'answer text reached the reader');
  const received=(await call('/ai/progress')).data.items[0] as ModelRequestProgress;
  assert.equal(received.state,'receiving_text');assert.equal(received.textCharacters,'私の秘密の答案'.length);assert.ok(received.firstTextAt&&received.lastTextAt);assert.ok(received.receivedBytes>0);
  const serialized=JSON.stringify(received);
  for(const privateText of ['PRIVATE_PROMPT_NO_PROGRESS_LEAK','PRIVATE_REASONING_NO_PROGRESS_LEAK','私の秘密の答案','synthetic-progress-token'])assert.ok(!serialized.includes(privateText),privateText);
  const rebound=await new Promise<number>((resolve,reject)=>{const req=request(origin+'/api/ai/progress',{headers:{Host:'external.invalid'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();});assert.equal(rebound,403);
  assert.equal(calls(),1,'progress GETs neither infer nor retry');
  stream.push(completed());const result=await running;assert.equal(result.error,null);assert.equal(result.value,'完成した答案');
  const final=(await call('/ai/progress')).data.items[0] as ModelRequestProgress;
  assert.equal(final.state,'completed');assert.ok(final.endedAt);assert.equal(final.errorCode,null);assert.ok(!JSON.stringify(final).includes('完成した答案'));
});

test('HTTP polling does not renew the fixed deadline and timeout diagnostics retain received-text timing through v5 restore',async t=>{
  let stream!:ReturnType<typeof controlledStream>;
  const {call,calls,model,db}=await setup(t,init=>{stream=controlledStream(init.signal);stream.push({type:'response.created',response:{id:'resp-http-timeout'}});stream.push(textDelta('PRIVATE_PARTIAL_OUTPUT'));return stream.response;},180);
  const running=call('/exams',{level:'N5',count:1,types:['fill'],source:'ai'});
  await until(()=>model.getRequestProgress().items[0]?.textCharacters>0,'generated answer bytes were observed');
  let polls=0;
  while(model.getRequestProgress().items.some(item=>!item.endedAt)){
    const current=await call('/ai/progress');assert.equal(current.status,200);polls++;await delay(5);
  }
  const failed=await running;assert.equal(failed.status,504);assert.equal(failed.data.error.code,'MODEL_REQUEST_TIMEOUT');assert.ok(polls>=1);assert.equal(calls(),1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n),0,'partial output never becomes a paper');
  const history=(await call('/diagnostics?operation=generate')).data;assert.equal(history.total,1);
  const record=history.items[0];assert.equal(record.code,'MODEL_REQUEST_TIMEOUT');assert.equal(record.networkCode,'TimeoutError');assert.equal(record.upstreamStatus,200);assert.equal(record.upstreamMessage,null);
  const progress=record.progress as ModelRequestProgress;assert.ok(progress);assert.equal(progress.state,'failed');assert.equal(progress.reason,'total_timeout');assert.equal(progress.timeoutMs,180);assert.ok(progress.elapsedMs>=175);assert.ok(progress.firstTextAt&&progress.lastTextAt&&progress.endedAt);assert.equal(progress.textCharacters,'PRIVATE_PARTIAL_OUTPUT'.length);assert.ok(progress.sinceLastTextMs!>=0);
  assert.ok(!JSON.stringify(history).includes('PRIVATE_PARTIAL_OUTPUT'),'failure diagnostics retain counters, never the partial answer');
  const backup=(await call('/backup')).data;assert.equal(validateBackup(backup).version,5);
  assert.match(backup.tables.ai_failures[0].detail,/stream_progress_v1:/);assert.equal((await call('/restore',backup)).status,200);
  const restored=(await call('/diagnostics?operation=generate')).data.items[0];assert.deepEqual(restored.progress,progress);assert.equal(calls(),1,'diagnostics and backup operations never issue another model request');
});

test('a timeout before HTTP and one after headers retain different evidence instead of claiming a network disconnection',async t=>{
  for(const headers of [false,true]){
    const {call,model,calls}=await setup(t,init=>{
      if(headers)return controlledStream(init.signal).response;
      return new Promise<Response>((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}));
    },80);
    const failed=await call('/exams',{level:'N5',count:1,types:['fill'],source:'ai'});assert.equal(failed.status,504);assert.equal(failed.data.error.code,'MODEL_REQUEST_TIMEOUT');assert.equal(calls(),1);
    const entry=(await call('/diagnostics')).data.items[0],progress=entry.progress as ModelRequestProgress;
    assert.equal(entry.networkCode,'TimeoutError');assert.equal(progress.httpStatus,headers?200:null);assert.equal(progress.headersAt!==null,headers);assert.equal(progress.receivedBytes,0);assert.equal(progress.eventCount,0);assert.equal(progress.textCharacters,0);assert.equal(progress.firstTextAt,null);assert.equal(progress.reason,'total_timeout');
    assert.equal(model.getRequestProgress().items[0].errorCode,'MODEL_REQUEST_TIMEOUT');
  }
});

test('a structured upstream stream error preserves its official message and code alongside the observed progress',async t=>{
  const {call,calls}=await setup(t,()=>new Response(event({type:'response.created',response:{id:'resp-explicit-failure'}})+event({type:'response.failed',response:{id:'resp-explicit-failure',status:'failed',error:{code:'server_error',message:'Synthetic upstream generation failure.'}}}),{headers:{'Content-Type':'text/event-stream'}}));
  const failed=await call('/exams',{level:'N5',count:1,types:['fill'],source:'ai'});assert.equal(failed.status,503);assert.equal(failed.data.error.code,'server_error');
  const row=(await call('/diagnostics')).data.items[0];assert.equal(row.code,'server_error');assert.equal(row.upstreamStatus,200);assert.match(row.upstreamMessage,/Synthetic upstream generation failure/);assert.equal(row.progress.httpStatus,200);assert.equal(row.progress.eventCount,2);assert.equal(row.progress.textCharacters,0);assert.equal(row.progress.errorCode,'server_error');assert.notEqual(row.progress.reason,'total_timeout');assert.equal(calls(),1);
});

test('legacy failure records have no invented progress and malformed telemetry is not exposed as a trusted snapshot',async t=>{
  const {learning,call,db}=await setup(t,()=>{throw new Error('no inference expected');});
  const legacy=learning.diagnostics.record(new IntegrationError(502,'MODEL_STREAM_INTERRUPTED','旧记录仅保存了超时信息。',{networkCode:'TimeoutError',upstreamStatus:200,detail:'The operation was aborted due to timeout'}),{operation:'generate'});assert.ok(legacy);
  const malformed=learning.diagnostics.record(Object.assign(new Error('无效遥测不能被记录为有效进度。'),{code:'MODEL_REQUEST_TIMEOUT',diagnostics:{progress:{id:'not-a-uuid',model:'unsafe model name',state:'receiving_text',rawText:'PRIVATE_TELEMETRY_FIELD',textCharacters:99}}}),{operation:'generate'});assert.ok(malformed);
  const history=(await call('/diagnostics')).data;assert.equal(history.total,2);assert.ok(history.items.every((row:any)=>row.progress===null));assert.ok(!JSON.stringify(history).includes('PRIVATE_TELEMETRY_FIELD'));
  db.prepare('UPDATE ai_failures SET detail=? WHERE id=?').run('stream_progress_v1: '+JSON.stringify({id:'invalid',textCharacters:999999999999999999,extra:'not-a-valid-snapshot'}),legacy.id);
  const invalid=(await call('/diagnostics')).data.items.find((row:any)=>row.id===legacy.id);assert.equal(invalid.progress,null,'backup text cannot bypass the strict snapshot schema');
});
