import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {AuthManager,IntegrationError} from '../server/auth.js';
import {ModelService,type ModelOptions} from '../server/model.js';
import {openDatabase} from '../server/db.js';
import {seedDatabase} from '../server/seed.js';
import {createApplication} from '../server/app.js';
import {validateBackup} from '../server/learning.js';
import {modelRequestProgressSchema,type ModelRequestProgress} from '../server/model-progress.js';

const encoder=new TextEncoder();
const delay=(ms=5)=>new Promise<void>(done=>setTimeout(done,ms));
async function until(check:()=>boolean,label:string){const end=Date.now()+3000;while(!check()&&Date.now()<end)await delay();assert.ok(check(),label);}
const event=(value:unknown)=>'data: '+JSON.stringify(value)+'\n\n';
function stream(signal?:AbortSignal|null){
  let controller:ReadableStreamDefaultController<Uint8Array>,closed=false;
  const timers:ReturnType<typeof setTimeout>[]=[];
  const clear=()=>{timers.forEach(clearTimeout);signal?.removeEventListener('abort',abort);};
  const abort=()=>{if(!closed){closed=true;clear();controller.error(signal?.reason);}};
  const body=new ReadableStream<Uint8Array>({start(value){controller=value;signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();},cancel(){closed=true;clear();}});
  return {response:new Response(body,{headers:{'Content-Type':'text/event-stream','x-request-id':'req-timeout-policy-http'}}),
    push(value:unknown){if(!closed)controller.enqueue(encoder.encode(typeof value==='string'?value:event(value)));},
    later(ms:number,action:()=>void){timers.push(setTimeout(()=>{if(!closed)action();},ms));},
    close(){if(!closed){closed=true;clear();controller.close();}}};
}
type TimeoutOptions=Pick<ModelOptions,'requestTimeoutMs'|'responseTimeoutMs'|'streamIdleTimeoutMs'>;
async function setup(t:TestContext,reply:(init:RequestInit)=>Response|Promise<Response>,options:TimeoutOptions={}){
  const directory=mkdtempSync(join(tmpdir(),'japanese-timeout-policy-http-')),db=openDatabase(':memory:');seedDatabase(db);
  const auth={credentialDir:join(directory,'credentials'),accountKey:()=> 'timeout-policy-account',status:()=>({connected:true,planAuthorized:true}),getAccessToken:async()=> 'synthetic-timeout-policy-token'} as unknown as AuthManager;
  let calls=0;
  const model=new ModelService(auth,{...options,settingsFile:join(directory,'model-settings.json'),fetch:async(input,init={})=>{
    if(String(input).endsWith('/models'))return Response.json({models:[{slug:'timeout-policy-model',display_name:'超时测试模型',visibility:'list'}]});
    calls++;assert.equal(String(input),'https://api.openai.com/v1/responses');
    assert.deepEqual(Object.keys(JSON.parse(String(init.body))).sort(),['input','model','store','stream'],'timeout policy does not add undocumented request fields');
    return reply(init);
  }});
  await model.listModels();
  const holder=express(),server=holder.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
  const application=createApplication({port,origin,host:'127.0.0.1',dataDir:directory,dbPath:join(directory,'study.sqlite'),credentialDir:auth.credentialDir},db,auth,model);holder.use(application.app);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const response=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json() as any};
  }
  const generate=()=>call('/exams',{level:'N5',count:1,types:['fill'],source:'ai',mode:'practice'});
  return {...application,db,model,call,generate,calls:()=>calls};
}

test('continuous output survives an earlier total-deadline equivalent and saves exactly one complete paper',async t=>{
  const answer=JSON.stringify({questions:[{type:'fill',prompt:'仕事が終わったので、家に（　）。',answer:'かえります',acceptedAnswers:['かえります'],explanation:'「帰ります」表示回去。',knowledgePoints:['帰る'],points:10,rubric:'填写准确的假名。'}]});
  const options={requestTimeoutMs:1800,responseTimeoutMs:140,streamIdleTimeoutMs:140};
  const fixture=await setup(t,init=>{
    const source=stream(init.signal);source.push({type:'response.created',response:{id:'resp-slow-complete'}});
    const chunks=answer.match(/.{1,24}/gs)!;
    chunks.forEach((delta,index)=>source.later(40*(index+1),()=>source.push({type:'response.output_text.delta',output_index:0,content_index:0,delta})));
    source.later(40*(chunks.length+1),()=>{source.push({type:'response.completed',response:{id:'resp-slow-complete',status:'completed',output:[{type:'message',content:[{type:'output_text',text:answer}]}]}});source.close();});
    return source.response;
  },options);
  const before=(await fixture.call('/ai/progress')).data;
  assert.deepEqual(before.policy,{totalTimeoutMs:1800,responseTimeoutMs:140,streamIdleTimeoutMs:140});assert.deepEqual(before.items,[]);
  const running=fixture.generate();await until(()=>fixture.calls()===1,'one generation request began');
  let polls=0;while(!fixture.model.getRequestProgress().items[0]?.endedAt){await fixture.call('/ai/progress');polls++;await delay(10);}
  const saved=await running;assert.equal(saved.status,200,JSON.stringify(saved.data));assert.ok(polls>1);assert.equal(fixture.calls(),1,'polling never retries the model');
  const progress=fixture.model.getRequestProgress().items[0];assert.equal(progress.state,'completed');assert.ok(progress.elapsedMs>180,'slow valid streaming survives the former equivalent cutoff');assert.equal(progress.timeoutMs,1800);
  assert.equal(Number(fixture.db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n),1);assert.equal((await fixture.call('/diagnostics')).data.total,0);
  const paper=(await fixture.call('/exams/'+saved.data.id)).data;assert.equal(paper.questions.length,1);assert.equal(paper.questions[0].answer,undefined,'unfinished answering still hides its stored reference');
});

test('response and stream-idle deadlines report different causes and persist their policy in v5 backups',async t=>{
  for(const kind of ['response_timeout','stream_idle_timeout'] as const){
    const fixture=await setup(t,init=>{
      if(kind==='stream_idle_timeout'){const source=stream(init.signal);source.push({type:'response.created',response:{id:'resp-idle'}});return source.response;}
      return new Promise<Response>((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}));
    },{requestTimeoutMs:1500,responseTimeoutMs:90,streamIdleTimeoutMs:120});
    const failed=await fixture.generate();assert.equal(failed.status,504);assert.equal(failed.data.error.code,'MODEL_REQUEST_TIMEOUT');assert.equal(fixture.calls(),1);
    assert.equal(Number(fixture.db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n),0);
    const record=(await fixture.call('/diagnostics')).data.items[0],progress=record.progress as ModelRequestProgress;
    assert.equal(progress.reason,kind);assert.equal(progress.timeoutKind,kind);assert.equal(progress.timeoutMs,1500);assert.equal(progress.responseTimeoutMs,90);assert.equal(progress.streamIdleTimeoutMs,120);
    assert.equal(progress.httpStatus,kind==='response_timeout'?null:200);assert.equal(progress.textCharacters,0);assert.equal(progress.firstTextAt,null);assert.equal(record.upstreamStatus,progress.httpStatus);
    const backup=(await fixture.call('/backup')).data;assert.equal(validateBackup(backup).version,5);assert.equal((await fixture.call('/restore',backup)).status,200);
    assert.deepEqual((await fixture.call('/diagnostics')).data.items[0].progress,progress);assert.equal(fixture.calls(),1);
  }
});

test('heartbeats keep the transport alive but cannot renew the total deadline or invent answer text',async t=>{
  const fixture=await setup(t,init=>{
    const source=stream(init.signal);source.push({type:'response.created',response:{id:'resp-heartbeats'}});
    for(let index=1;index<=30;index++)source.later(index*30,()=>source.push(': heartbeat\n\n'));
    return source.response;
  },{requestTimeoutMs:480,responseTimeoutMs:140,streamIdleTimeoutMs:140});
  const running=fixture.generate();await until(()=>fixture.calls()===1,'heartbeat request began');
  let polls=0;while(!fixture.model.getRequestProgress().items[0]?.endedAt){const current=(await fixture.call('/ai/progress')).data.items[0];if(current){assert.equal(current.firstTextAt,null);assert.equal(current.textCharacters,0);}polls++;await delay(10);}
  const failed=await running;assert.equal(failed.status,504);assert.ok(polls>1);assert.equal(fixture.calls(),1);
  const progress=(await fixture.call('/diagnostics')).data.items[0].progress as ModelRequestProgress;
  assert.equal(progress.reason,'total_timeout');assert.equal(progress.timeoutKind,'total_timeout');assert.equal(progress.eventCount,1);assert.ok(progress.receivedBytes>0);assert.equal(progress.firstTextAt,null);assert.equal(progress.textCharacters,0);assert.ok(progress.elapsedMs>=470);assert.ok(progress.sinceLastByteMs!<140);
  assert.equal(Number(fixture.db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n),0);
});

test('historical 180-second snapshots remain readable without the new staged-policy fields',async t=>{
  const fixture=await setup(t,()=>{throw new Error('no model request expected');});
  const start=new Date('2026-10-27T03:30:47.000Z').toISOString(),end=new Date(Date.parse(start)+180000).toISOString();
  const legacy={id:'20000000-0000-4000-8000-000000000001',model:'timeout-policy-model',state:'failed',startedAt:start,headersAt:null,firstByteAt:null,lastByteAt:null,firstEventAt:null,lastEventAt:null,firstTextAt:null,lastTextAt:null,endedAt:end,elapsedMs:180000,sinceLastByteMs:null,sinceLastEventMs:null,sinceLastTextMs:null,timeoutMs:180000,receivedBytes:0,eventCount:0,textCharacters:0,lastEventType:null,httpStatus:null,errorCode:'MODEL_REQUEST_TIMEOUT',reason:'total_timeout'};
  assert.equal(modelRequestProgressSchema.safeParse(legacy).success,true);
  const recorded=fixture.learning.diagnostics.record(new IntegrationError(504,'MODEL_REQUEST_TIMEOUT','旧版本180秒超时。',{networkCode:'TimeoutError',progress:legacy as ModelRequestProgress}),{operation:'generate'});assert.ok(recorded);
  const backup=(await fixture.call('/backup')).data;assert.equal(validateBackup(backup).version,5);assert.equal((await fixture.call('/restore',backup)).status,200);
  const current=(await fixture.call('/diagnostics')).data.items[0].progress;assert.equal(current.timeoutMs,180000);assert.equal(current.responseTimeoutMs,undefined);assert.equal(current.streamIdleTimeoutMs,undefined);assert.equal(current.timeoutKind,undefined);assert.deepEqual(current,legacy);assert.equal(fixture.calls(),0);
  assert.deepEqual((await fixture.call('/ai/progress')).data.policy,{totalTimeoutMs:900000,responseTimeoutMs:60000,streamIdleTimeoutMs:120000},'new defaults do not rewrite historical policy');
});
