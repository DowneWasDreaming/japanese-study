import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AuthManager,IntegrationError} from '../server/auth.js';
import {ModelService,type ModelOptions} from '../server/model.js';
import {modelRequestProgressSchema} from '../server/model-progress.js';

const input=[{role:'user' as const,content:'private Japanese exercise prompt'}];
const encode=(event:unknown)=>new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n');
const done=()=>encode({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'完成'}]}]}});
type Request={init:RequestInit};
async function setup(t:TestContext,respond:(request:Request)=>Response|Promise<Response>,options:Pick<ModelOptions,'requestTimeoutMs'|'responseTimeoutMs'|'streamIdleTimeoutMs'>={}){
  const directory=mkdtempSync(join(tmpdir(),'japanese-phased-timeout-'));
  t.after(()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  const signals:AbortSignal[]=[];
  const auth={credentialDir:directory,status:()=>({planAuthorized:true}),accountKey:()=> 'phase-account',getAccessToken:async()=> 'fake-phase-token'} as unknown as AuthManager;
  const model=new ModelService(auth,{...options,settingsFile:join(directory,'models.json'),fetch:async(url,init={})=>{
    if(String(url).endsWith('/models'))return Response.json({models:[{slug:'phase-model',display_name:'测试模型',visibility:'list'}]});
    signals.push(init.signal!);return respond({init});
  }});
  await model.listModels();return {model,signals};
}
function stream(request:Request,start:(controller:ReadableStreamDefaultController<Uint8Array>)=>void=()=>{},cleanup:()=>void=()=>{}){
  let controller:ReadableStreamDefaultController<Uint8Array>;const signal=request.init.signal!;
  const abort=()=>{cleanup();controller.error(signal.reason);};
  return new Response(new ReadableStream<Uint8Array>({start(value){controller=value;signal.addEventListener('abort',abort,{once:true});start(value);},cancel(){signal.removeEventListener('abort',abort);cleanup();}}),{headers:{'content-type':'text/event-stream'}});
}
async function failure(promise:Promise<string>){try{await promise;assert.fail('expected failure');}catch(error){assert.ok(error instanceof IntegrationError);return error;}}

test('default inference waits for response, network silence and overall duration with independent limits',async t=>{
  const {model}=await setup(t,()=>{throw new Error('not called');});
  assert.deepEqual(model.getRequestProgress().policy,{totalTimeoutMs:900000,responseTimeoutMs:60000,streamIdleTimeoutMs:120000});
  assert.deepEqual(model.getRequestProgress().items,[]);
});

test('continuous chunks keep a slow generation alive across several idle windows and successful completion clears every deadline',async t=>{
  let interval:ReturnType<typeof setInterval>|undefined,completion:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=>{clearInterval(interval);clearTimeout(completion);};t.after(cleanup);
  const {model,signals}=await setup(t,request=>stream(request,controller=>{
    controller.enqueue(encode({type:'response.created'}));
    interval=setInterval(()=>controller.enqueue(encode({type:'response.output_text.delta',delta:'あ'})),25);
    completion=setTimeout(()=>{controller.enqueue(done());cleanup();controller.close();},225);
  },cleanup),{requestTimeoutMs:400,responseTimeoutMs:60,streamIdleTimeoutMs:60});
  assert.equal(await model.generate(input),'完成');
  const record=model.getRequestProgress().items[0];assert.equal(record.state,'completed');assert.ok(record.elapsedMs>=200);assert.ok(record.textCharacters>4);
  assert.equal(record.timeoutKind,null);assert.equal(record.responseTimeoutMs,60);assert.equal(record.streamIdleTimeoutMs,60);
  await delay(220);assert.equal(signals[0].aborted,false,'completed work must not later be aborted by a leftover timer');
  assert.deepEqual(model.getRequestProgress().items[0],record,'finished timing and counters remain frozen');
});

test('no HTTP response triggers only the response deadline and records exactly which limit ended the request',async t=>{
  const {model}=await setup(t,request=>new Promise((_resolve,reject)=>request.init.signal!.addEventListener('abort',()=>reject(request.init.signal!.reason),{once:true})),{requestTimeoutMs:500,responseTimeoutMs:45,streamIdleTimeoutMs:100});
  const error=await failure(model.generate(input));const record=error.diagnostics.progress!;
  assert.equal(error.code,'MODEL_REQUEST_TIMEOUT');assert.equal(error.diagnostics.reason,'response_timeout');assert.equal(record.timeoutKind,'response_timeout');
  assert.equal(record.headersAt,null);assert.equal(record.receivedBytes,0);assert.equal(record.textCharacters,0);assert.ok(record.elapsedMs>=35&&record.elapsedMs<400);
  assert.match(error.publicMessage,/服务响应/);assert.match(error.publicMessage,/尚未收到 HTTP/);assert.ok(modelRequestProgressSchema.safeParse(record).success);
});

test('HTTP with no further network data triggers the silence limit instead of waiting for the long total cap',async t=>{
  const {model}=await setup(t,request=>stream(request),{requestTimeoutMs:500,responseTimeoutMs:100,streamIdleTimeoutMs:45});
  const error=await failure(model.generate(input));const record=error.diagnostics.progress!;
  assert.equal(error.diagnostics.reason,'stream_idle_timeout');assert.equal(record.timeoutKind,'stream_idle_timeout');assert.equal(record.httpStatus,200);assert.equal(record.receivedBytes,0);
  assert.match(error.publicMessage,/没有收到任何新网络数据/);assert.ok(record.elapsedMs>=35&&record.elapsedMs<400);assert.equal(record.firstTextAt,null);
});

test('heartbeats renew network silence without claiming answer progress or extending the fixed overall cap',async t=>{
  let interval:ReturnType<typeof setInterval>|undefined;const cleanup=()=>clearInterval(interval);t.after(cleanup);
  const {model}=await setup(t,request=>stream(request,controller=>{
    controller.enqueue(encode({type:'response.created'}));
    interval=setInterval(()=>controller.enqueue(new TextEncoder().encode(': keepalive\n\n')),20);
  },cleanup),{requestTimeoutMs:210,responseTimeoutMs:70,streamIdleTimeoutMs:60});
  const error=await failure(model.generate(input));const record=error.diagnostics.progress!;
  assert.equal(error.diagnostics.reason,'total_timeout');assert.equal(record.timeoutKind,'total_timeout');assert.ok(record.elapsedMs>=180&&record.elapsedMs<500);
  assert.ok(record.receivedBytes>0);assert.ok(record.sinceLastByteMs!<80);assert.equal(record.eventCount,1);assert.equal(record.textCharacters,0);assert.equal(record.lastTextAt,null);
});

test('explicit upstream errors and malformed events survive cleanup crossing the silence deadline',async t=>{
  for(const kind of ['official','validation']){
    const {model}=await setup(t,()=>new Response(new ReadableStream<Uint8Array>({
      start(controller){controller.enqueue(kind==='official'?encode({type:'response.failed',response:{error:{code:'server_error',message:'official phase error'}}}):new TextEncoder().encode('data: {invalid\n\n'));},
      async cancel(){await delay(70);},
    }),{headers:{'content-type':'text/event-stream'}}),{requestTimeoutMs:200,responseTimeoutMs:100,streamIdleTimeoutMs:25});
    const error=await failure(model.generate(input));assert.equal(error.code,kind==='official'?'server_error':'MODEL_STREAM_INVALID');
    assert.notEqual(error.diagnostics.reason,'stream_idle_timeout');assert.equal(error.diagnostics.progress!.timeoutKind,null);
    if(kind==='official')assert.match(error.diagnostics.upstreamMessage!,/official phase error/);
  }
});

test('old progress snapshots without phase limits remain readable without inventing historical timing',async t=>{
  const {model}=await setup(t,request=>stream(request,controller=>{controller.enqueue(done());controller.close();}));
  await model.generate(input);const current=model.getRequestProgress().items[0];
  const {responseTimeoutMs,streamIdleTimeoutMs,timeoutKind,...old}=current;
  const restored=modelRequestProgressSchema.parse(old);assert.equal(restored.responseTimeoutMs,undefined);assert.equal(restored.streamIdleTimeoutMs,undefined);assert.equal(restored.timeoutKind,undefined);
});
