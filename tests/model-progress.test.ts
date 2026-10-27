import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {AuthManager,IntegrationError} from '../server/auth.js';
import {ModelService,type ModelMessage} from '../server/model.js';
import {ModelProgressTracker,modelRequestProgressSchema} from '../server/model-progress.js';

const messages:ModelMessage[]=[{role:'user',content:'private prompt for a Japanese exercise'}];
const event=(value:unknown)=>new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n');
const complete=(text='答え')=>({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}});
type Request={url:string,init:RequestInit};
async function fixture(t:TestContext,respond:(request:Request)=>Response|Promise<Response>,requestTimeoutMs=120){
  const directory=mkdtempSync(join(tmpdir(),'japanese-model-progress-'));
  t.after(()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  let account:string|null='account-a',authorized=true;const requests:Request[]=[],usage:unknown[]=[];
  const auth={credentialDir:directory,accountKey:()=>account,status:()=>({connected:!!account,planAuthorized:authorized}),getAccessToken:async()=> 'fake-token'} as unknown as AuthManager;
  const service=new ModelService(auth,{requestTimeoutMs,settingsFile:join(directory,'models.json'),onUsage:e=>{usage.push(e);},fetch:async(input,init={})=>{
    const request={url:String(input),init};requests.push(request);
    if(request.url.endsWith('/models'))return Response.json({models:[{slug:'test-model',display_name:'测试模型',visibility:'list'}]});
    return respond(request);
  }});
  await service.listModels();
  // AbortSignal.timeout is intentionally unref'ed by Node. Keep a short test
  // handle alive while verifying mocked streams with no external socket.
  const guard=setTimeout(()=>{},requestTimeoutMs+1000);t.after(()=>clearTimeout(guard));
  return {service,requests,usage,setAccount:(value:string|null)=>{account=value;},setAuthorized:(value:boolean)=>{authorized=value;}};
}
function stream(request:Request,onStart:(controller:ReadableStreamDefaultController<Uint8Array>)=>void=()=>{}){
  const signal=request.init.signal!;let controller:ReadableStreamDefaultController<Uint8Array>;
  const abort=()=>controller.error(signal.reason);
  return new Response(new ReadableStream<Uint8Array>({start(value){controller=value;signal.addEventListener('abort',abort,{once:true});onStart(value);},cancel(){signal.removeEventListener('abort',abort);}}),{headers:{'content-type':'text/event-stream','x-request-id':'test-progress-request'}});
}
async function rejected(promise:Promise<string>){try{await promise;assert.fail('expected failure');}catch(error){assert.ok(error instanceof IntegrationError);return error;}}

test('request timeout distinguishes no HTTP, headers without events, and events without answer text',async t=>{
  const phases=['headers','events','text'] as const;
  for(const phase of phases){
    const f=await fixture(t,request=>phase==='headers'?new Promise<Response>((_resolve,reject)=>request.init.signal!.addEventListener('abort',()=>reject(request.init.signal!.reason),{once:true})):stream(request,controller=>{if(phase==='text')controller.enqueue(event({type:'response.created',response:{id:'response-test',status:'in_progress'}}));}));
    const failure=await rejected(f.service.generate(messages));const p=failure.diagnostics.progress!;
    assert.equal(failure.code,'MODEL_REQUEST_TIMEOUT');assert.equal(failure.status,504);assert.equal(failure.diagnostics.reason,'total_timeout');assert.equal(failure.diagnostics.networkCode,'TimeoutError');
    assert.match(failure.diagnostics.detail!,/timeout/i);assert.equal(p.state,'failed');assert.equal(p.timeoutMs,120);assert.equal(p.textCharacters,0);assert.equal(p.firstTextAt,null);assert.equal(p.lastTextAt,null);
    assert.equal(failure.diagnostics.upstreamStatus,phase==='headers'?undefined:200);assert.equal(p.httpStatus,phase==='headers'?null:200);
    assert.match(failure.publicMessage,phase==='headers'?/尚未收到 HTTP/:phase==='events'?/未收到模型事件/:/未收到答案正文/);
    assert.equal(p.eventCount,phase==='text'?1:0);assert.equal(f.usage.length,1);assert.ok(modelRequestProgressSchema.safeParse(p).success);
  }
});

test('ongoing text beyond the deadline and stalled output have separate last-text evidence without heartbeat inflation',async t=>{
  for(const continuous of [true,false]){
    let interval:ReturnType<typeof setInterval>|undefined;let textCount=0;
    t.after(()=>clearInterval(interval));
    const f=await fixture(t,request=>stream(request,controller=>{
      controller.enqueue(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:'あ'}));textCount++;
      interval=setInterval(()=>{try{if(continuous){controller.enqueue(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:'い'}));textCount++;}else controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));}catch{clearInterval(interval);}},15);
    }),180);
    const failure=await rejected(f.service.generate(messages));clearInterval(interval);const p=failure.diagnostics.progress!;
    assert.equal(failure.code,'MODEL_REQUEST_TIMEOUT');assert.match(failure.publicMessage,/部分答案正文/);assert.equal(p.textCharacters,textCount);assert.ok(p.firstTextAt&&p.lastTextAt);assert.ok(p.receivedBytes>0);
    if(continuous){assert.ok(p.sinceLastTextMs!<100);assert.ok(p.eventCount>1);}else{assert.equal(p.textCharacters,1);assert.equal(p.eventCount,1);assert.ok(p.sinceLastTextMs!>=100);assert.ok(p.sinceLastByteMs!<100);}
    assert.ok(!JSON.stringify(p).includes(messages[0].content));assert.ok(!JSON.stringify(p).includes('keepalive\n'));
  }
});

test('polling observes safe progress without resetting the deadline, exposing text or issuing another request',async t=>{
  let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
  const f=await fixture(t,request=>stream(request,value=>{controller=value;value.enqueue(event({type:'response.in_progress',response:{id:'response-safe'}}));}),300);
  const pending=f.service.generate(messages);await delay(15);const first=f.service.getRequestProgress().items[0];
  assert.equal(first.state,'processing');assert.equal(first.eventCount,1);assert.equal(first.firstTextAt,null);assert.equal(first.model,'test-model');
  await delay(15);const second=f.service.getRequestProgress().items[0];assert.equal(first.id,second.id);assert.ok(second.elapsedMs>=first.elapsedMs);assert.equal(second.startedAt,first.startedAt);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/responses')).length,1);
  controller!.enqueue(event({type:'response.output_text.delta',output_index:0,content_index:0,delta:'private answer'}));await delay(5);
  const active=f.service.getRequestProgress().items[0];assert.equal(active.state,'receiving_text');assert.equal(active.textCharacters,14);assert.ok(!JSON.stringify(active).includes('private answer'));assert.ok(!JSON.stringify(active).includes('fake-token'));
  controller!.enqueue(event({type:'response.output_text.done',output_index:0,content_index:0,text:'private answer'}));
  controller!.enqueue(event({type:'response.output_item.done',output_index:0,item:{id:'message-safe',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'private answer'}]}}));
  controller!.enqueue(event(complete('private answer')));assert.equal(await pending,'private answer');
  const completed=f.service.getRequestProgress().items[0];assert.equal(completed.state,'completed');assert.equal(completed.textCharacters,14);assert.ok(completed.endedAt);assert.equal(completed.errorCode,null);
  await delay(5);assert.deepEqual(f.service.getRequestProgress().items[0],completed,'terminal counters and elapsed times stay frozen');
  f.setAccount('other-account');assert.deepEqual(f.service.getRequestProgress(),{items:[]});f.setAccount('account-a');assert.equal(f.service.getRequestProgress().items.length,1);
  f.setAuthorized(false);assert.deepEqual(f.service.getRequestProgress(),{items:[]});
});

test('EOF, socket failure and explicit upstream error preserve their cause and attach observed progress',async t=>{
  const faults=['eof','socket','upstream'] as const;
  for(const fault of faults){
    const f=await fixture(t,request=>stream(request,controller=>{
      controller.enqueue(event({type:'response.output_text.delta',delta:'partial private answer'}));
      if(fault==='eof')controller.close();
      if(fault==='socket')setTimeout(()=>controller.error(new TypeError('terminated',{cause:Object.assign(new Error('socket closed'),{code:'UND_ERR_SOCKET'})})),5);
      if(fault==='upstream')controller.enqueue(event({type:'response.failed',response:{error:{code:'server_error',message:'temporary official failure'}}}));
    }));
    const failure=await rejected(f.service.generate(messages));assert.equal(failure.code,fault==='upstream'?'server_error':'MODEL_STREAM_INTERRUPTED');
    assert.equal(failure.diagnostics.upstreamStatus,200);assert.equal(failure.diagnostics.progress!.state,'failed');assert.ok(failure.diagnostics.progress!.textCharacters>0);
    if(fault==='eof')assert.equal(failure.diagnostics.reason,'stream_ended_without_completion');
    if(fault==='socket'){assert.equal(failure.diagnostics.networkCode,'UND_ERR_SOCKET');assert.match(failure.diagnostics.detail!,/socket closed/);}
    if(fault==='upstream')assert.match(failure.diagnostics.upstreamMessage!,/temporary official failure/);
  }
});

test('an explicit provider or validation failure is not relabeled when cleanup passes the local deadline',async t=>{
  for(const kind of ['provider','validation']){
    const f=await fixture(t,()=>new Response(new ReadableStream<Uint8Array>({
      start(controller){controller.enqueue(kind==='provider'?event({type:'response.failed',response:{error:{code:'server_error',message:'explicit official failure'}}}):new TextEncoder().encode('data: {broken\n\n'));},
      async cancel(){await delay(70);},
    }),{headers:{'content-type':'text/event-stream'}}),25);
    const failure=await rejected(f.service.generate(messages));assert.equal(failure.code,kind==='provider'?'server_error':'MODEL_STREAM_INVALID');assert.equal(failure.diagnostics.progress!.errorCode,failure.code);
    assert.notEqual(failure.diagnostics.reason,'total_timeout');if(kind==='provider')assert.match(failure.diagnostics.upstreamMessage!,/explicit official failure/);
  }
});

test('progress cache is bounded, expires old terminal entries, and never drops active requests',()=>{
  const tracker=new ModelProgressTracker(),active:string[]=[];
  for(let index=0;index<22;index++){const id=randomUUID();active.push(id);tracker.start(id,'test-model','account-a',180000);}
  assert.equal(tracker.list('account-a').items.length,22,'active records take priority over the history size limit');
  tracker.finish(active[0],'completed');tracker.finish(active[1],'failed','MODEL_REQUEST_TIMEOUT','total_timeout');
  assert.equal(tracker.list('account-a').items.length,20);assert.ok(tracker.list('account-a').items.every(item=>!item.endedAt));
  const other=randomUUID();tracker.start(other,'Bearer private model name','account-b',180000);tracker.event(other,'response.output_text.delta Bearer private-content');
  const safe=tracker.list('account-b').items[0];assert.equal(safe.model,'unknown-model');assert.equal(safe.lastEventType,null);assert.ok(modelRequestProgressSchema.safeParse(safe).success);
  tracker.finish(other,'completed');
  const realNow=Date.now;try{Date.now=()=>realNow()+11*60_000;assert.equal(tracker.list('account-b').items.length,0);assert.equal(tracker.list('account-a').items.length,20);}finally{Date.now=realNow;}
});
