import { checkedReviewReply } from './review-fixtures.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../server/db.js';
import { seedDatabase, type Question } from '../server/seed.js';
import { LearningService, type AIProvider } from '../server/learning.js';
import { AuthManager, IntegrationError } from '../server/auth.js';
import type { ModelService } from '../server/model.js';
import { createApplication } from '../server/app.js';
import { createLearningRouter } from '../server/learning-router.js';
import { localBoundary, errorHandler } from '../server/security.js';

type Payload = { selectedText: string; context: string; level: string };
type Reply = (payload: Payload, call: number) => string | Promise<string>;
const candidate = (title: string) => ({ title, kind: 'word', reading: 'ことば', meaning: '词汇的整体含义。', focus: '复习整体用法与常见搭配，不只记当前词形。', note: '结合原句确认复习范围。' });

async function setup(t: TestContext, reply: Reply = payload => JSON.stringify(candidate(payload.selectedText))) {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-review-batch-http-'));
  const db = openDatabase(':memory:'); seedDatabase(db);
  const requests: Payload[] = [], releases: (() => void)[] = [];
  const provider: AIProvider = { async generate(messages) { const payload = JSON.parse(messages.at(-1)!.content) as Payload; requests.push(payload); return checkedReviewReply(await reply(payload, requests.length),messages); } };
  const service = new LearningService(db, provider, { backupDir: join(directory, 'backups') });
  let extraBusy = false;
  const app = express(), server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app.use(localBoundary(origin)); app.use(express.json({ limit: '15mb' })); app.use('/api', createLearningRouter(service, db, () => extraBusy)); app.use(errorHandler);
  t.after(async () => {
    releases.forEach(release => release());
    for (let attempt = 0; attempt < 500 && service.isBusy(); attempt++) await delay(2);
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true });
  });
  async function call(path: string, body?: unknown, method = 'POST') {
    const response = await fetch(origin + '/api' + path, body === undefined ? undefined : { method, headers: { Origin: origin, 'X-Study-Client': 'local-web', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as any };
  }
  const add = (text: string, level = 'N5') => service.reviews.add({ text, level }).item;
  const get = async (id: string) => (await call('/review/points/' + id)).json.item;
  const overview = async () => { const result = await call('/review/normalize-batch'); assert.equal(result.status, 200); return result.json; };
  const start = () => call('/review/normalize-batch', {});
  async function finished() {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = await overview();
      if (value.batch && !['running', 'stopping'].includes(value.batch.status)) return value.batch;
      await delay(2);
    }
    throw new Error('The temporary batch did not finish within the bounded test wait.');
  }
  function hold() {
    let release!: () => void; const promise = new Promise<void>(done => { release = done; }); releases.push(release); return { promise, release };
  }
  return { db, service, requests, origin, call, add, get, overview, start, finished, hold, setExtraBusy: (busy: boolean) => { extraBusy = busy; } };
}

test('one HTTP action normalizes and schedules all twenty-six drafts across levels and pages without manual confirmation', { timeout: 15_000 }, async t => {
  const { db, requests, call, add, get, overview, start, finished } = await setup(t);
  const points = Array.from({ length: 26 }, (_, index) => add('学習語' + index, index % 2 ? 'N3' : 'N5'));
  assert.equal((await call('/review/points?status=draft&pageSize=10&level=N5')).json.items.length, 10);
  const before = await overview(); assert.equal(before.totalDraftCount, 26); assert.equal(before.eligibleCount, 26);
  const started = await start(); assert.ok(started.status >= 200 && started.status < 300, JSON.stringify(started.json));
  const job = await finished(); assert.equal(job.status, 'completed'); assert.equal(job.total, 26); assert.equal(job.processed, 26); assert.equal(job.succeeded, 26); assert.equal(job.failed, 0); assert.equal(job.current, null);
  assert.equal(requests.length, 26); assert.deepEqual(new Set(requests.map(item => item.selectedText)), new Set(points.map(point => point.title)));
  assert.ok(job.items.every((item: any) => item.status === 'completed')); assert.equal((await overview()).eligibleCount, 0);
  for (const point of points) { const saved = await get(point.id); assert.equal(saved.status, 'active'); assert.equal(saved.normalizationStatus, 'none'); assert.equal(saved.candidate, null); assert.equal(saved.title, point.title); assert.equal(saved.stage, 0); assert.ok(saved.dueAt); assert.equal(saved.repetitions,0); }
  assert.equal((await overview()).totalDraftCount,0);assert.equal((await call('/review/points?status=due&pageSize=100')).json.total,26);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM review_events').get()!.n), 0);
  const repeat = await start(); assert.equal(repeat.status, 400); assert.equal(repeat.json.error.code, 'NO_REVIEW_NORMALIZATION_PENDING'); assert.equal(requests.length, 26);
});

test('batch HTTP rechecks legacy candidates and skips unsubmitted sources while preserving checked mastered merge targets', async t => {
  const { db, service, requests, call, add, get, overview, start, finished } = await setup(t,payload=>JSON.stringify(candidate(payload.selectedText==='整理済み'?'確認済み':payload.selectedText)));
  const cached = add('整理済み');db.prepare("UPDATE review_points SET normalization_status='completed',candidate_json=? WHERE id=?").run(JSON.stringify(candidate('確認済み')),cached.id);
  const ready = add('確認済み','N3'); service.reviews.confirm(ready.id, candidate('確認済み'));await service.reviews.audit(ready.id);service.reviews.rate(ready.id,{rating:'mastered',requestId:randomUUID()});
  const question: Question = { id: randomUUID(), level: 'N5', category: 'grammar', type: 'fill', prompt: '宿題が済んでから出かける。', answer: '済んで', acceptedAnswers: ['済んで'], explanation: '済む的て形。', knowledgePoints: ['済む'], points: 10, rubric: '按参考答案。', source: 'builtin' };
  const examId = randomUUID(); db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(examId, '尚未交卷', 'N5', 'grammar', 'exam', 'builtin', 'draft', new Date().toISOString(), JSON.stringify([question]), JSON.stringify({ level: 'N5', count: 1, types: ['fill'], mode: 'exam', source: 'builtin', basis: 'all', gradingMode: 'mixed' }));
  const offset = question.prompt.indexOf('済んで'); const blocked = service.reviews.add({ examId, questionId: question.id, source: 'prompt', start: offset, end: offset + 3, text: '済んで' }).item;
  const fresh = add('未整理'); const readyBefore = await get(ready.id), blockedBefore = await get(blocked.id);
  const before = await overview(); assert.equal(before.totalDraftCount, 3); assert.equal(before.eligibleCount, 2); assert.equal(before.completedCount, 1); assert.equal(before.blockedCount, 1);
  await start(); const job = await finished(); assert.equal(job.total, 2); assert.deepEqual(new Set(job.items.map((item:any)=>item.id)),new Set([cached.id,fresh.id])); assert.equal(requests.length, 3,'existing target and each legacy/fresh candidate are explicitly checked once');
  assert.deepEqual(await get(blocked.id), blockedBefore);const merged=await get(ready.id);assert.equal(merged.status,'mastered');assert.equal(merged.level,'N3');assert.equal(merged.stage,7);assert.equal(merged.repetitions,readyBefore.repetitions);assert.equal(merged.lastReviewedAt,readyBefore.lastReviewedAt);assert.ok(merged.sources.some((source:any)=>source.text==='整理済み'));
  assert.equal((await call('/review/points/'+cached.id)).status,404);assert.equal((await get(fresh.id)).status, 'active'); assert.equal((await overview()).completedCount, 0); assert.equal((await overview()).blockedCount, 1);
});

test('cached-only HTTP activation checks saved suggestions without changing grades or token records and leaves fresh and failed marks untouched',async t=>{
  const {db,requests,call,add,get,finished}=await setup(t,()=>JSON.stringify(candidate('済む')));
  const cached=add('済んで');db.prepare("UPDATE review_points SET normalization_status='completed',candidate_json=? WHERE id=?").run(JSON.stringify(candidate('済む')),cached.id);
  const fresh=add('未整理'),failed=add('前回失敗');db.prepare("UPDATE review_points SET normalization_status='failed',error='以前のモデル接続失敗' WHERE id=?").run(failed.id);
  const paper=await call('/exams',{level:'N5',count:1,types:['fill'],mode:'practice',source:'builtin',basis:'all'});assert.equal(paper.status,200);
  const exam=(await call('/exams/'+paper.json.id)).json;await call('/exams/'+exam.id+'/answers',{answers:{[exam.questions[0].id]:exam.questions[0].answer}},'PUT');assert.equal((await call('/exams/'+exam.id+'/submit',{})).status,200);
  db.prepare("INSERT INTO ai_token_usage(id,created_at,model,status,usage_state,input_tokens,output_tokens,total_tokens) VALUES(?,?,?,'completed','reported',12,7,19)").run(randomUUID(),new Date().toISOString(),'synthetic-cached-activation');
  const preserved=()=>JSON.stringify({grades:db.prepare('SELECT * FROM grades').all(),exams:db.prepare('SELECT * FROM exams').all(),tokens:db.prepare('SELECT * FROM ai_token_usage').all(),requests:db.prepare('SELECT * FROM local_ai_requests').all()});
  const before=preserved(),freshBefore=await get(fresh.id),failedBefore=await get(failed.id);
  const started=await call('/review/normalize-batch',{cachedOnly:true});assert.equal(started.status,202,JSON.stringify(started.json));const batch=await finished();assert.equal(batch.total,1);assert.equal(batch.succeeded,1);assert.equal(batch.failed,0);assert.equal(requests.length,1);
  const saved=await get(cached.id);assert.equal(saved.status,'active');assert.equal(saved.title,'済む');assert.equal(saved.normalizationStatus,'none');assert.equal(saved.candidate,null);assert.ok(saved.dueAt);
  assert.deepEqual(await get(fresh.id),freshBefore);assert.deepEqual(await get(failed.id),failedBefore);assert.equal(preserved(),before);
  assert.equal((await call('/review/normalize-batch',{cachedOnly:true})).status,400);assert.equal(requests.length,1);
});

test('single-item HTTP normalization checks a legacy suggestion once and directly enters the editable review schedule',async t=>{
  const {db,requests,call,add,get}=await setup(t,()=>JSON.stringify(candidate('済む')));
  const point=add('済んで');db.prepare("UPDATE review_points SET normalization_status='completed',candidate_json=? WHERE id=?").run(JSON.stringify(candidate('済む')),point.id);
  const result=await call('/review/points/'+point.id+'/normalize',{});assert.equal(result.status,200,JSON.stringify(result.json));assert.equal(result.json.item.status,'active');assert.equal(result.json.item.title,'済む');assert.ok(result.json.item.dueAt);assert.equal(result.json.item.sources[0].text,'済んで');assert.equal(requests.length,1);
  const repeated=await call('/review/points/'+point.id+'/normalize',{});assert.equal(repeated.status,200);assert.equal(repeated.json.item.dueAt,result.json.item.dueAt);assert.equal(requests.length,1);
  const edited=await call('/review/points/'+point.id,{meaning:'事后直接修改这一个知识点。'},'PUT');assert.equal(edited.status,200);assert.equal((await get(point.id)).meaning,'事后直接修改这一个知识点。');assert.equal(requests.length,1);
});

test('an individual failure records useful HTTP diagnostics, continues other points and retries only the unfinished candidate on demand', async t => {
  let fail = true;
  const { requests, call, add, get, start, finished } = await setup(t, payload => {
    if (payload.selectedText === '失敗語' && fail) throw new IntegrationError(503, 'OPENAI_NETWORK_ERROR', '连接模型时网络中断。', { upstreamStatus: 503, upstreamMessage: 'Synthetic normalization transport failure.', requestId: 'req-batch-normalize-network', networkCode: 'ECONNRESET', stage: 'model-request' });
    return JSON.stringify(candidate(payload.selectedText));
  });
  const points = [add('成功語一'), add('失敗語'), add('成功語二')]; await start(); const first = await finished(); assert.equal(first.status, 'completed'); assert.equal(first.total, 3); assert.equal(first.succeeded, 2); assert.equal(first.failed, 1); assert.equal(requests.length, 3);
  const failure = first.items.find((item: any) => item.id === points[1].id); assert.equal(failure.status, 'failed'); assert.match(failure.error, /网络|OPENAI_NETWORK_ERROR/);
  const history = await call('/diagnostics?operation=review'); assert.equal(history.json.total, 1); assert.equal(history.json.items[0].requestId, 'req-batch-normalize-network'); assert.equal(history.json.items[0].upstreamStatus, 503); assert.ok(history.json.items[0].createdAt); assert.match(history.json.items[0].upstreamMessage, /Synthetic normalization/);
  const failed=await get(points[1].id);assert.equal(failed.normalizationStatus, 'failed');assert.equal(failed.status,'draft');assert.equal(failed.dueAt,null);assert.equal((await get(points[0].id)).status,'active');assert.equal((await get(points[2].id)).status,'active'); fail = false;
  await start(); const retried = await finished(); assert.notEqual(retried.id, first.id); assert.equal(retried.total, 1); assert.equal(retried.succeeded, 1); assert.equal(retried.failed, 0); assert.equal(requests.length, 4); assert.equal(requests.at(-1)!.selectedText, '失敗語');
  assert.equal((await get(points[1].id)).status,'active');assert.equal((await call('/diagnostics?operation=review')).json.total, 1, 'successful retry must preserve earlier failure details');
});

test('a global quota failure stops the batch after one actual attempt and leaves remaining originals available to retry', async t => {
  const { requests, call, add, get, overview, start, finished } = await setup(t, () => { throw new IntegrationError(429, 'rate_limit_exceeded', '官方额度暂时不可用。', { upstreamStatus: 429, upstreamMessage: 'Synthetic quota exhausted.', requestId: 'req-batch-quota', stage: 'upstream-response' }); });
  const points = [add('甲'), add('乙'), add('丙')]; await start(); const job = await finished(); assert.equal(job.status, 'stopped'); assert.equal(requests.length, 1); assert.equal(job.failed, 1); assert.equal(job.succeeded, 0); assert.equal(job.processed, 1); assert.ok(job.stopReason);
  assert.equal(job.items.filter((item: any) => item.status === 'skipped').length, 2); assert.equal((await overview()).eligibleCount, 3);
  const states = await Promise.all(points.map(point => get(point.id))); assert.equal(states.filter(point => point.normalizationStatus === 'failed').length, 1); assert.equal(states.filter(point => point.normalizationStatus === 'none').length, 2); assert.ok(states.every(point => point.status === 'draft'));
  const history = (await call('/diagnostics?operation=review')).json; assert.equal(history.total, 1); assert.equal(history.items[0].requestId, 'req-batch-quota');
});

test('background status survives refresh and concurrent start, holds the learning lock, and stops after its current item', { timeout: 15_000 }, async t => {
  let firstGate!: Promise<void>;
  const { service, requests, origin, call, add, get, overview, start, finished, hold } = await setup(t, async (payload, count) => { if (count === 1) await firstGate; return JSON.stringify(candidate(payload.selectedText)); });
  const gate = hold(); firstGate = gate.promise;
  const points = [add('一'), add('二'), add('三')], backup = service.backup();
  const started = await Promise.race([start(), delay(1000).then(() => { throw new Error('Batch start waited for AI instead of returning a background job.'); })]);
  assert.ok(started.status >= 200 && started.status < 300); assert.equal(started.json.batch.status, 'running'); assert.equal(service.isBusy(), true);
  const repeated = await start(), current = await overview(); assert.equal(repeated.json.batch.id, started.json.batch.id); assert.equal(current.batch.id, started.json.batch.id); assert.equal(current.batch.current?.id, current.batch.items.find((item: any) => item.status === 'running')?.id); assert.equal(requests.length, 1);
  const queuedId = current.batch.items.find((item: any) => item.status === 'queued').id;
  assert.equal((await call('/review/points/' + queuedId + '/normalize', {})).status, 409);
  assert.equal((await call('/review/points/' + queuedId + '/confirm', candidate('不能提前确认'))).status, 409);
  assert.equal((await call('/review/points/' + queuedId, undefined)).status, 200);
  assert.equal((await call('/review/points/' + queuedId, {}, 'DELETE')).status, 409);
  assert.equal((await call('/data/delete-preview', { scope: 'all' })).status, 409);
  assert.equal((await call('/restore', backup)).status, 409);
  const forged = await fetch(origin + '/api/review/normalize-batch/' + started.json.batch.id + '/stop', { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(forged.status, 403);
  const stop = await call('/review/normalize-batch/' + started.json.batch.id + '/stop', {}); assert.equal(stop.json.batch.status, 'stopping'); assert.equal(requests.length, 1); assert.equal(service.isBusy(), true);
  gate.release(); const stopped = await finished(); assert.equal(stopped.status, 'stopped'); assert.equal(stopped.processed, 1); assert.equal(stopped.succeeded, 1); assert.equal(stopped.items.filter((item: any) => item.status === 'skipped').length, 2); assert.equal(service.isBusy(), false);
  const states = await Promise.all(points.map(point => get(point.id))); assert.equal(states.filter(point => point.status === 'active').length, 1); assert.equal((await overview()).eligibleCount, 2);
  await start(); const remaining = await finished(); assert.equal(remaining.total, 2); assert.equal(remaining.succeeded, 2); assert.equal(requests.length, 3);
});

test('batch mutation HTTP validates the local origin, strict body, connection lock and empty selection before using AI', async t => {
  const { requests, origin, call, add, start, setExtraBusy } = await setup(t);
  const empty = await start(); assert.equal(empty.status, 400); assert.equal(empty.json.error.code, 'NO_REVIEW_NORMALIZATION_PENDING');
  add('語');
  const forged = await fetch(origin + '/api/review/normalize-batch', { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(forged.status, 403);
  assert.equal((await call('/review/normalize-batch', { ids: ['untrusted'] })).status, 400);
  setExtraBusy(true); assert.equal((await start()).status, 409); setExtraBusy(false);
  assert.equal((await call('/review/normalize-batch/' + randomUUID() + '/stop', {})).status, 404); assert.equal(requests.length, 0);
});

test('a new explicit batch action clears the application quota pause once, while status polling never resets or calls the model', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-review-batch-app-')), db = openDatabase(':memory:'); seedDatabase(db);
  let resets = 0, attempts = 0, upstreamAvailable = false, pausedError: IntegrationError | null = null;
  const auth = { status: () => ({ connected: true, planAuthorized: true }) } as unknown as AuthManager;
  const model = {
    selectedModel: 'batch-http-model', resetFailurePause() { resets++; pausedError = null; },
    async generate(messages: Parameters<AIProvider['generate']>[0]) {
      if (pausedError) throw pausedError;
      attempts++;
      if (!upstreamAvailable) { pausedError = new IntegrationError(429, 'rate_limit_exceeded', '官方暂时限制调用。', { upstreamStatus: 429, requestId: 'req-batch-app-quota', upstreamMessage: 'Synthetic quota pause.' }); throw pausedError; }
      return checkedReviewReply(JSON.stringify(candidate(JSON.parse(messages.at(-1)!.content).selectedText)),messages);
    },
  } as unknown as ModelService;
  const holder = express(), server = holder.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const application = createApplication({ port, origin, host: '127.0.0.1', dataDir: directory, dbPath: join(directory, 'study.sqlite'), credentialDir: join(directory, 'credentials') }, db, auth, model); holder.use(application.app);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); db.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true }); });
  for (const text of ['甲', '乙', '丙']) application.learning.reviews.add({ text, level: 'N5' });
  async function call(body?: unknown) { const response = await fetch(origin + '/api/review/normalize-batch', body === undefined ? undefined : { method: 'POST', headers: { Origin: origin, 'X-Study-Client': 'local-web', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.status >= 200 && response.status < 300); return response.json() as Promise<any>; }
  async function finished() { for (let attempt = 0; attempt < 500; attempt++) { const value = await call(); if (value.batch && !['running', 'stopping'].includes(value.batch.status)) return value.batch; await delay(2); } throw new Error('Application batch did not finish.'); }
  await call({}); const stopped = await finished(); assert.equal(stopped.status, 'stopped'); assert.equal(attempts, 1); assert.equal(resets, 1);
  await call(); await call(); assert.equal(attempts, 1); assert.equal(resets, 1);
  upstreamAvailable = true;
  await call({}); const complete = await finished(); assert.equal(complete.status, 'completed'); assert.equal(complete.succeeded, 3); assert.equal(attempts, 4); assert.equal(resets, 2, 'only the second explicit user action clears the previous global pause');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM ai_failures').get()!.n), 1); assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM local_ai_requests').get()!.n), 4);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM review_points WHERE status='active' AND stage=0 AND due_at IS NOT NULL").get()!.n),3);assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM review_events').get()!.n),0);
});
