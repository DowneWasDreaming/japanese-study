import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { AuthManager } from '../server/auth.js';
import { ModelService } from '../server/model.js';
import { createApplication } from '../server/app.js';
import { validateBackup } from '../server/learning.js';

test('HTTP study flow persists drafts, grades once, records knowledge and confirms recoverable deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-http-'));
  const dbPath = join(directory, 'data', 'study.sqlite');
  let db = openDatabase(dbPath); seedDatabase(db);
  const auth = new AuthManager({ credentialDir: join(directory, 'credentials') }); await auth.init();
  const model = new ModelService(auth);
  const holder = express(); const server = holder.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number }; const origin = `http://127.0.0.1:${port}`;
  const config = { port, origin, host: '127.0.0.1', dataDir: join(directory, 'data'), dbPath, credentialDir: join(directory, 'credentials') };
  holder.use(createApplication(config, db, auth, model).app);
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(origin + path, body === undefined ? undefined : { method, headers: { Origin: origin, 'X-Study-Client': 'local-web', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json() as any;
    return { status: response.status, json };
  };
  try {
    const unauth = await call('/api/connection-test', {}); assert.equal(unauth.status, 403);
    const status = (await call('/api/auth/status')).json;
    assert.equal(status.connected, false); assert.equal(status.planAuthorized, false);
    assert.ok(!JSON.stringify(status).includes('access_token'));
    const contents = (await call('/api/content')).json.items; assert.ok(contents.length > 20);
    const created = await call('/api/exams', { level: 'N5', count: 2, types: ['single', 'fill'], category: 'mixed', focus: '', mode: 'exam', source: 'builtin', basis: 'all' });
    assert.equal(created.status, 200, JSON.stringify(created.json)); const id = created.json.id;
    const exam = (await call('/api/exams/' + id)).json;
    assert.equal(exam.questions.length, 2);
    assert.equal(exam.gradingMode, 'mixed'); assert.equal(exam.gradingModeLocked, false);
    const aiMode = await call('/api/exams/' + id + '/grading-mode', { gradingMode: 'ai' }, 'PUT');
    assert.equal(aiMode.status, 200, JSON.stringify(aiMode.json)); assert.equal(aiMode.json.gradingMode, 'ai');
    assert.equal((await call('/api/exams/' + id + '/grading-mode', { gradingMode: 'unknown' }, 'PUT')).status, 400);
    assert.equal((await call('/api/exams/' + id + '/grading-mode', { gradingMode: 'mixed' }, 'PUT')).status, 200);
    for (const question of exam.questions) {
      assert.ok(!Object.hasOwn(question, 'answer')); assert.ok(!Object.hasOwn(question, 'acceptedAnswers'));
      assert.ok(!Object.hasOwn(question, 'explanation')); assert.ok(!Object.hasOwn(question, 'rubric'));
    }
    const draft = { [exam.questions[0].id]: 'incorrect', [exam.questions[1].id]: '不正解' };
    await call('/api/exams/' + id + '/answers', { answers: draft }, 'PUT');
    assert.deepEqual((await call('/api/exams/' + id)).json.answers, draft);
    const feedback = await call('/api/exams/' + id + '/feedback', { questionId: exam.questions[0].id }); assert.equal(feedback.status, 403);
    const first = await call('/api/exams/' + id + '/submit', {}); assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.gradingModeLocked, true);
    assert.equal((await call('/api/exams/' + id + '/grading-mode', { gradingMode: 'ai' }, 'PUT')).status, 409);
    await call('/api/exams/' + id + '/submit', {});
    const grades = db.prepare('SELECT count(*) AS n FROM grades WHERE exam_id=?').get(id) as { n: number }; assert.equal(grades.n, 2);
    assert.ok((await call('/api/mistakes')).json.items.length > 0);
    const repeat = await call('/api/exams/' + id + '/repeat', {}); assert.equal(repeat.status, 200); assert.notEqual(repeat.json.id, id);
    assert.equal((await call('/api/backup')).status, 409, '完整备份不得提前公开未交卷考试答案');
    await call('/api/exams/' + repeat.json.id + '/submit', {});
    const backup = (await call('/api/backup')).json; assert.ok(backup.version); assert.ok(!JSON.stringify(backup).includes('access_token'));
    const restored = await call('/api/restore', backup); assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.ok((await call('/api/exams')).json.items.some((item: any) => item.id === id));
    const knowledge = (await call('/api/knowledge?level=N5')).json.items;
    assert.ok(knowledge.length > 0);
    assert.ok(knowledge.every((point: any) => point.level === 'N5' && point.questionCount > 0 && point.attempts > 0));
    assert.ok(knowledge.every((point: any) => point.accuracy >= 0 && point.accuracy <= 1));
    const summary = (await call('/api/data/summary')).json;
    assert.equal(summary.counts.exams, 2); assert.equal(summary.busy, false);
    const forbidden = await fetch(origin + '/api/data', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'invented', confirmation: '删除' }) });
    assert.equal(forbidden.status, 403, '删除接口同样要求本机页面 Origin 与客户端标记');
    db.prepare('INSERT INTO local_ai_requests(created_at) VALUES(?)').run(Date.now());
    const preview = await call('/api/data/delete-preview', { scope: 'exam', id: repeat.json.id });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.counts.exams, 1);
    assert.ok(db.prepare('SELECT id FROM exams WHERE id=?').get(repeat.json.id), '预览不得删除数据');
    const unconfirmed = await call('/api/data', { token: preview.json.token }, 'DELETE');
    assert.equal(unconfirmed.status, 400);
    assert.ok(db.prepare('SELECT id FROM exams WHERE id=?').get(repeat.json.id));
    const deleted = await call('/api/data', { token: preview.json.token, confirmation: '删除' }, 'DELETE');
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    assert.equal(deleted.json.deleted, true);
    assert.equal((await call('/api/exams/' + repeat.json.id)).status, 404);
    assert.equal((await call('/api/exams/' + id)).status, 200);
    assert.equal((db.prepare('SELECT count(*) AS n FROM mistakes WHERE exam_id=?').get(repeat.json.id) as { n: number }).n, 0);
    const beforeDelete = validateBackup(JSON.parse(readFileSync(deleted.json.beforeDeleteBackup, 'utf8')));
    assert.ok(beforeDelete.tables.exams.some(item => item.id === repeat.json.id));
    const recovered = await call('/api/restore', beforeDelete);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
    assert.equal((await call('/api/exams/' + repeat.json.id)).status, 200);
    assert.equal((db.prepare('SELECT count(*) AS n FROM local_ai_requests').get() as { n: number }).n, 1, '删除及恢复保留本地请求计数');
    const aiPaper = await call('/api/exams', { level: 'N5', count: 1, types: ['single'], source: 'builtin', mode: 'practice', gradingMode: 'ai' });
    assert.equal(aiPaper.status, 200, JSON.stringify(aiPaper.json));
    const aiExam = (await call('/api/exams/' + aiPaper.json.id)).json;
    assert.equal(aiExam.gradingMode, 'ai');
    await call('/api/exams/' + aiExam.id + '/answers', { answers: { [aiExam.questions[0].id]: aiExam.questions[0].options[0].id } }, 'PUT');
    const failedAI = await call('/api/exams/' + aiExam.id + '/submit', {});
    assert.equal(failedAI.json.status, 'partial', '未授权的 AI 判卷不能悄悄改回本机评分');
    const failedGrade = failedAI.json.grades[aiExam.questions[0].id];
    assert.equal(failedGrade.status, 'failed'); assert.equal(failedGrade.score, null);
    const annotationInput = { questionId: aiExam.questions[0].id, source: 'prompt', start: 0, end: 3, text: aiExam.questions[0].prompt.slice(0, 3) };
    const markWithoutAuth = await call('/api/exams/' + aiExam.id + '/annotations', annotationInput);
    assert.equal(markWithoutAuth.status, 200); assert.equal(markWithoutAuth.json.items.length, 1);
    const noAuthAnalysis = await call('/api/exams/' + aiExam.id + '/annotations/explain', {});
    assert.equal(noAuthAnalysis.status, 200); assert.equal(noAuthAnalysis.json.items[0].status, 'failed');
    assert.match(noAuthAnalysis.json.items[0].error, /PLAN_PERMISSION_REQUIRED/);
    assert.deepEqual((await call('/api/exams/' + aiExam.id)).json.grades, failedAI.json.grades, '标记解析权限失败不能改动既有评分');
    assert.equal((await call('/api/exams/' + aiExam.id + '/grading-mode', { gradingMode: 'mixed' }, 'PUT')).status, 409);
    validateBackup((await call('/api/backup')).json);
    assert.equal((await call('/api/restore', beforeDelete)).status, 200);
    // Connection verification waits for the model catalog before createExam is
    // called. It must still protect deletion/restoration during that first wait.
    const originalStatus = auth.status.bind(auth);
    const originalCatalog = model.listModels.bind(model);
    let catalogStarted!: () => void; let releaseCatalog!: () => void;
    const started = new Promise<void>(resolve => { catalogStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseCatalog = resolve; });
    auth.status = () => ({ ...originalStatus(), planAuthorized: true });
    model.listModels = async () => { catalogStarted(); await held; throw new Error('模拟模型目录失败'); };
    const pendingConnection = call('/api/connection-test', {});
    try {
      await started;
      assert.equal((await call('/api/data/summary')).json.busy, true);
      assert.equal((await call('/api/data/delete-preview', { scope: 'all' })).status, 409);
      assert.equal((await call('/api/restore', beforeDelete)).status, 409);
      assert.equal((await call('/api/exams/' + id + '/annotations', { questionId: exam.questions[0].id, source: 'prompt', start: 0, end: 1, text: exam.questions[0].prompt.slice(0, 1) })).status, 409);
      assert.equal((await call('/api/exams/' + id + '/annotations/explain', {})).status, 409);
    } finally {
      releaseCatalog(); await pendingConnection;
      auth.status = originalStatus; model.listModels = originalCatalog;
    }
    assert.equal((await call('/api/data/summary')).json.busy, false);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); db = openDatabase(dbPath); seedDatabase(db);
    assert.ok(db.prepare('SELECT id FROM exams WHERE id=?').get(id));
    assert.equal((db.prepare('SELECT count(*) AS n FROM answers WHERE exam_id=?').get(id) as { n: number }).n, 2);
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
