import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { AuthManager } from '../server/auth.js';
import { ModelService } from '../server/model.js';
import { TokenUsageService } from '../server/token-usage.js';
import { createApplication } from '../server/app.js';
import { validateBackup } from '../server/learning.js';

test('HTTP token totals collect actual stream metadata across partial grading and retries while learning backup and deletion preserve statistics', async t => {
  const directory=mkdtempSync(join(tmpdir(),'japanese-token-http-'));
  const db=openDatabase(':memory:');seedDatabase(db);
  const auth={credentialDir:join(directory,'credentials'),accountKey:()=> 'synthetic-account',status:()=>({connected:true,planAuthorized:true}),getAccessToken:async()=> 'synthetic-transport-token'} as unknown as AuthManager;
  const usage=new TokenUsageService(db);let calls=0;
  const transport:typeof fetch=async input=>{
    if(String(input).endsWith('/models'))return Response.json({models:[{slug:'test-model',display_name:'测试模型',visibility:'list'}]});
    assert.equal(String(input),'https://api.openai.com/v1/responses');calls++;
    const counts=calls===1?{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:30},output_tokens_details:{reasoning_tokens:5}}:
      calls===2?{input_tokens:70,output_tokens:4,total_tokens:74}:calls===4?{input_tokens:0,output_tokens:0,total_tokens:0}:undefined;
    const result=calls===2?{type:'response.failed',response:{id:'resp-usage-'+calls,status:'failed',usage:counts,error:{code:'server_error',message:'Synthetic upstream failure.'}}}:
      {type:'response.completed',response:{id:'resp-usage-'+calls,status:'completed',usage:counts,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({score:10,feedback:'回答正确。',suggestion:'继续练习。',reference:'参考表达。'})}]}]}};
    return new Response('data: '+JSON.stringify(result)+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  const model=new ModelService(auth,{fetch:transport,settingsFile:join(directory,'model-settings.json'),onUsage:event=>{usage.record(event);}});
  const holder=express(),server=holder.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
  holder.use(createApplication({port,origin,host:'127.0.0.1',dataDir:directory,dbPath:join(directory,'study.sqlite'),credentialDir:join(directory,'credentials')},db,auth,model).app);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const response=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json() as any};
  }
  const initial=(await call('/token-usage')).data;
  assert.equal(initial.summary.requests,0);assert.equal(initial.summary.totalTokens,null);assert.ok(initial.collectionStartedAt);
  const created=await call('/exams',{level:'N5',count:3,types:['single'],source:'builtin',mode:'exam',gradingMode:'ai'});assert.equal(created.status,200);
  const id=created.data.id;const questions=JSON.parse(String(db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json)) as {id:string;answer:string}[];
  await call(`/exams/${id}/answers`,{answers:Object.fromEntries(questions.map(q=>[q.id,q.answer]))},'PUT');
  assert.equal((await call(`/exams/${id}/submit`,{})).data.status,'partial');
  const first=(await call('/token-usage?period=all')).data;
  assert.equal(first.summary.requests,3);assert.equal(first.summary.reportedRequests,2);assert.equal(first.summary.unavailableRequests,1);
  assert.equal(first.summary.totalTokens,194);assert.equal(first.summary.inputTokens,170);assert.equal(first.summary.outputTokens,24);
  assert.equal(first.summary.cachedTokens,30);assert.equal(first.summary.reasoningTokens,5);
  assert.equal(first.summary.failedRequests,1);assert.equal(first.summary.completedRequests,2);
  assert.equal(first.items.find((item:any)=>item.responseId==='resp-usage-3').totalTokens,null);
  assert.equal((await call(`/exams/${id}/retry`,{})).data.status,'completed');assert.equal(calls,4);
  const complete=(await call('/token-usage?period=all')).data;
  assert.equal(complete.summary.reportedRequests,3);assert.equal(complete.summary.requests,4);assert.equal(complete.summary.totalTokens,194);
  assert.equal(complete.items.find((item:any)=>item.responseId==='resp-usage-4').totalTokens,0);
  assert.equal((await call(`/exams/${id}`)).data.score,30);
  assert.equal((await call('/token-usage?period=all')).data.summary.requests,4,'GET does not infer or charge');assert.equal(calls,4);
  for(const query of ['period=invalid','page=0','page=bad','unknown=value','period=day&period=all'])assert.equal((await call('/token-usage?'+query)).status,400);
  const backup=validateBackup((await call('/backup')).data);assert.equal(backup.version,4);
  assert.ok(!Object.hasOwn(backup.tables,'ai_token_usage'));assert.ok(!Object.hasOwn(backup.tables,'ai_token_usage_metadata'));
  const preview=await call('/data/delete-preview',{scope:'all'});assert.equal(preview.status,200);
  assert.equal((await call('/data',{token:preview.data.token,confirmation:'删除'},'DELETE')).status,200);
  assert.equal((await call('/token-usage?period=all')).data.summary.requests,4);
  assert.equal((await call('/restore',backup)).status,200);
  assert.equal((await call('/token-usage?period=all')).data.summary.requests,4);
});
