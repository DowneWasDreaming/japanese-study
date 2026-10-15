import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { AuthManager, IntegrationError } from '../server/auth.js';
import type { ModelService } from '../server/model.js';
import { createApplication } from '../server/app.js';
import { validateBackup } from '../server/learning.js';

test('HTTP retries preserve distinct failure details after success and ignore former local limit variables', async t => {
  const directory=mkdtempSync(join(tmpdir(),'japanese-diagnostics-http-'));
  const db=openDatabase(':memory:');seedDatabase(db);
  const oldHour=process.env.STUDY_AI_HOURLY_LIMIT,oldDay=process.env.STUDY_AI_DAILY_LIMIT;
  process.env.STUDY_AI_HOURLY_LIMIT='1';process.env.STUDY_AI_DAILY_LIMIT='1';
  const auth={status:()=>({connected:true,planAuthorized:true})} as unknown as AuthManager;
  let calls=0,resets=0;
  const model={selectedModel:'mock-model',resetFailurePause(){resets++;},async generate(){
    calls++;
    if(calls===1)throw new IntegrationError(503,'OPENAI_NETWORK_ERROR','连接模型服务失败。',{stage:'request',networkCode:'ECONNRESET',detail:'connection reset',model:'actual-first-model'});
    if(calls===2)throw new IntegrationError(429,'rate_limit_exceeded','官方限制暂时阻止了本次请求。',{upstreamStatus:429,upstreamMessage:'Too many requests for this test model.',requestId:'req-diagnostic-test',stage:'upstream-response'});
    return JSON.stringify({score:10,feedback:'正确。',suggestion:'继续练习。',reference:'参考表达。'});
  }} as unknown as ModelService;
  const holder=express(),server=holder.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
  const config={port,origin,host:'127.0.0.1',dataDir:directory,dbPath:join(directory,'study.sqlite'),credentialDir:join(directory,'credentials')};
  holder.use(createApplication(config,db,auth,model).app);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();
    if(oldHour===undefined)delete process.env.STUDY_AI_HOURLY_LIMIT;else process.env.STUDY_AI_HOURLY_LIMIT=oldHour;
    if(oldDay===undefined)delete process.env.STUDY_AI_DAILY_LIMIT;else process.env.STUDY_AI_DAILY_LIMIT=oldDay;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const result=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:result.status,data:await result.json() as any};
  }
  const created=await call('/exams',{level:'N5',count:1,types:['single'],source:'builtin',mode:'exam',gradingMode:'ai'});
  assert.equal(created.status,200);const id=created.data.id;
  const question=JSON.parse(String(db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json))[0];
  await call(`/exams/${id}/answers`,{answers:{[question.id]:question.answer}},'PUT');
  assert.equal((await call(`/exams/${id}/submit`,{})).data.status,'partial');
  assert.equal((await call(`/exams/${id}/retry`,{})).data.status,'partial');
  assert.equal((await call(`/exams/${id}/retry`,{})).data.status,'completed');
  assert.equal(calls,3);assert.ok(resets>=3);
  const history=await call(`/diagnostics?examId=${id}`);assert.equal(history.status,200);assert.equal(history.data.total,2);
  const network=history.data.items.find((item:any)=>item.code==='OPENAI_NETWORK_ERROR');
  assert.equal(network.category,'network');assert.equal(network.networkCode,'ECONNRESET');assert.equal(network.model,'actual-first-model');
  const upstream=history.data.items.find((item:any)=>item.code==='rate_limit_exceeded');
  assert.equal(upstream.upstreamStatus,429);assert.equal(upstream.requestId,'req-diagnostic-test');assert.match(upstream.upstreamMessage,/Too many requests/);
  assert.notEqual(network.id,upstream.id);assert.ok(network.createdAt&&upstream.createdAt);
  const filtered=await call(`/diagnostics?examId=${id}&category=network&pageSize=1`);assert.equal(filtered.data.total,1);
  assert.equal((await call('/diagnostics?page=-1')).status,400);
  const runtime=(await call('/runtime')).data;assert.equal(runtime.localRequests.limitEnabled,false);assert.equal(runtime.localRequests.hour,3);assert.equal(runtime.localRequests.hourlyLimit,null);
  const backup=validateBackup((await call('/backup')).data);assert.equal(backup.version,3);assert.equal(backup.tables.ai_failures.length,2);
  assert.equal((await call(`/exams/${id}`)).data.score,10);
});
