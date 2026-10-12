import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { AuthManager } from '../server/auth.js';
import { ModelService } from '../server/model.js';
import { createApplication } from '../server/app.js';

test('HTTP study flow persists drafts, conceals answers, grades once and supports backups', async () => {
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
    for (const question of exam.questions) {
      assert.ok(!Object.hasOwn(question, 'answer')); assert.ok(!Object.hasOwn(question, 'acceptedAnswers'));
      assert.ok(!Object.hasOwn(question, 'explanation')); assert.ok(!Object.hasOwn(question, 'rubric'));
    }
    const draft = { [exam.questions[0].id]: 'incorrect', [exam.questions[1].id]: '不正解' };
    await call('/api/exams/' + id + '/answers', { answers: draft }, 'PUT');
    assert.deepEqual((await call('/api/exams/' + id)).json.answers, draft);
    const feedback = await call('/api/exams/' + id + '/feedback', { questionId: exam.questions[0].id }); assert.equal(feedback.status, 403);
    const first = await call('/api/exams/' + id + '/submit', {}); assert.equal(first.status, 200, JSON.stringify(first.json));
    await call('/api/exams/' + id + '/submit', {});
    const grades = db.prepare('SELECT count(*) AS n FROM grades WHERE exam_id=?').get(id) as { n: number }; assert.equal(grades.n, 2);
    assert.ok((await call('/api/mistakes')).json.items.length > 0);
    const repeat = await call('/api/exams/' + id + '/repeat', {}); assert.equal(repeat.status, 200); assert.notEqual(repeat.json.id, id);
    assert.equal((await call('/api/backup')).status, 409, '完整备份不得提前公开未交卷考试答案');
    await call('/api/exams/' + repeat.json.id + '/submit', {});
    const backup = (await call('/api/backup')).json; assert.ok(backup.version); assert.ok(!JSON.stringify(backup).includes('access_token'));
    const restored = await call('/api/restore', backup); assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.ok((await call('/api/exams')).json.items.some((item: any) => item.id === id));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); db = openDatabase(dbPath); seedDatabase(db);
    assert.ok(db.prepare('SELECT id FROM exams WHERE id=?').get(id));
    assert.equal((db.prepare('SELECT count(*) AS n FROM answers WHERE exam_id=?').get(id) as { n: number }).n, 2);
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
