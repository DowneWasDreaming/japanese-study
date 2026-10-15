import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { LearningService, validateBackup, type AIProvider } from '../server/learning.js';
import { createLearningRouter } from '../server/learning-router.js';
import { DataManagementService } from '../server/learning-management.js';
import { localBoundary, errorHandler } from '../server/security.js';

const modelResult = (messages: Parameters<AIProvider['generate']>[0]) => {
  const input = JSON.parse(messages.at(-1)!.content);
  return JSON.stringify({ explanations: input.marks.map((mark: { id: string; text: string }) => ({
    id: mark.id, reading: '读音依本题中的完整表达。', meaning: '结合本题语境的中文意思。', analysis: `这里解释「${mark.text}」的语法及用法。`,
    examples: [{ ja: '学校へ行きます。', zh: '去学校。' }], tip: '注意本题中的实际语境。',
  })) });
};
async function setup(t: TestContext, provider: AIProvider = { async generate(messages) { return modelResult(messages); } }) {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-annotation-integration-'));
  const db = openDatabase(':memory:'); seedDatabase(db);
  const service = new LearningService(db, provider, { backupDir: join(directory, 'backups') });
  t.after(() => { db.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true }); });
  const { id } = await service.createExam({ level: 'N5', count: 1, types: ['reading'], mode: 'practice', source: 'builtin' });
  const question = service.getExam(id).questions[0];
  const text = String(question.passage);
  const mark = service.annotations.add(id, { questionId: question.id, source: 'passage', start: 0, end: Math.min(8, text.length), text: text.slice(0, 8) });
  const manager = new DataManagementService(db, { isBusy: () => service.isBusy(), backup: () => service.createDeletionBackup() });
  return { directory, db, service, manager, id, question, mark };
}

test('annotation backups round-trip, legacy v1 restores, and pending work becomes retryable without changing grades', async t => {
  const { db, service, id, question } = await setup(t);
  const full = JSON.parse(String(db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json))[0];
  service.saveAnswers(id, { [String(question.id)]: full.answer });
  await service.submit(id);
  const beforeScore = service.getExam(id).score;
  await service.annotations.explain(id);
  const completed = service.annotations.list(id).items[0];
  assert.equal(completed.status, 'completed');
  assert.equal(service.getExam(id).score, beforeScore);
  const backup = service.backup();
  assert.equal(backup.version, 3);
  assert.equal(backup.tables.exam_annotations.length, 1);
  assert.equal(validateBackup(backup).tables.exam_annotations.length, 1);
  const legacy = structuredClone(backup) as any;
  legacy.version = 1; delete legacy.tables.exam_annotations; delete legacy.tables.ai_failures;
  assert.deepEqual(validateBackup(legacy).tables.exam_annotations, []);
  const restore = service.restore(legacy);
  assert.equal(service.annotations.list(id).items.length, 0);
  const safety = validateBackup(JSON.parse(readFileSync(restore.beforeRestoreBackup, 'utf8')));
  assert.equal(safety.tables.exam_annotations.length, 1, 'restore safety copy retains current annotations');
  service.restore(backup);
  assert.deepEqual(service.annotations.list(id).items[0].explanation, completed.explanation);
  assert.equal(service.getExam(id).score, beforeScore);
  const pending = structuredClone(backup) as any;
  Object.assign(pending.tables.exam_annotations[0], { status: 'pending', explanation_json: null, error: null });
  service.restore(pending);
  const recovered = service.annotations.list(id).items[0];
  assert.equal(recovered.status, 'failed'); assert.ok(recovered.error);
  assert.equal(service.getExam(id).score, beforeScore);
  await service.annotations.explain(id);
  assert.equal(service.annotations.list(id).items[0].status, 'completed');
});

test('annotation backup validation rejects broken anchors, references and premature analysis before any restore writes', async t => {
  const { service, db, id } = await setup(t);
  const backup = service.backup();
  const mutations: ((copy: any) => void)[] = [
    b => { b.version = 999; },
    b => { b.version = 1; },
    b => { delete b.tables.exam_annotations; },
    b => { b.tables.exam_annotations[0].text = '原文中没有的词句'; },
    b => { b.tables.exam_annotations[0].question_id = 'another-question'; },
    b => { b.tables.exam_annotations[0].exam_id = 'another-exam'; },
    b => { b.tables.exam_annotations[0].end_offset = 999999; },
    b => { b.tables.exam_annotations[0].option_id = 'not-an-option'; },
    b => { b.tables.exam_annotations[0].status = 'completed'; },
    b => { b.tables.exam_annotations[0].status = 'pending'; },
    b => { b.tables.exam_annotations[0].status = 'failed'; b.tables.exam_annotations[0].error = '中断'; },
    b => { b.tables.exam_annotations.push({ ...b.tables.exam_annotations[0], id: 'new-id-same-anchor' }); },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(backup); mutate(bad);
    const before = db.prepare('SELECT total_changes() AS n').get()!.n;
    assert.throws(() => service.restore(bad), (error: any) => error.code === 'INVALID_BACKUP');
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before);
    assert.equal(service.annotations.list(id).items.length, 1);
  }
});

test('annotation requests protect destructive operations, preserve grades, and participate in delete preview and recovery', async t => {
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const { service, manager, id, question } = await setup(t, { async generate(messages) { started(); await held; return modelResult(messages); } });
  await service.submit(id);
  const backup = service.backup();
  const grades = JSON.stringify(service.getExam(id).grades);
  const preview = manager.preview({ scope: 'exam', id });
  assert.equal(preview.counts.annotations, 1); assert.match(preview.warning, /标记/);
  const flight = service.annotations.explain(id); await began;
  assert.equal(service.isBusy(), true);
  assert.throws(() => manager.preview({ scope: 'all' }), (error: any) => error.status === 409);
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), (error: any) => error.status === 409);
  assert.throws(() => service.restore(backup), (error: any) => error.code === 'RESTORE_BUSY');
  assert.throws(() => service.setGradingMode(id, { gradingMode: 'ai' }), (error: any) => error.status === 409);
  assert.throws(() => service.annotations.add(id, { questionId: question.id, source: 'prompt', start: 0, end: 1, text: String(question.prompt).slice(0, 1) }), (error: any) => error.status === 409);
  release(); await flight;
  assert.equal(service.isBusy(), false);
  assert.equal(JSON.stringify(service.getExam(id).grades), grades);
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), (error: any) => error.code === 'DELETE_PREVIEW_STALE');
  const fresh = manager.preview({ scope: 'exam', id });
  const removed = manager.remove({ token: fresh.token, confirmation: '删除' });
  assert.equal(removed.counts.annotations, 1);
  assert.equal(manager.summary().counts.annotations, 0);
  const saved = validateBackup(JSON.parse(readFileSync(removed.beforeDeleteBackup, 'utf8')));
  assert.equal(saved.tables.exam_annotations.length, 1);
  service.restore(saved);
  assert.equal(service.annotations.list(id).items[0].status, 'completed');
});

test('local HTTP annotation flow validates origins, persists multiple sources and keeps analysis separate from submission', async t => {
  const { service, id, question } = await setup(t);
  let extraBusy = false;
  const app = express(); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app.use(localBoundary(origin)); app.use(express.json());
  app.use('/api', createLearningRouter(service, service.db, () => extraBusy)); app.use(errorHandler);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(origin + '/api' + path, body === undefined ? undefined : { method,
      headers: { Origin: origin, 'X-Study-Client': 'local-web', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as any };
  };
  const path = '/exams/' + id + '/annotations';
  const before = await call(path); assert.equal(before.status, 200); assert.equal(before.json.canExplain, false);
  assert.equal((await call(path + '/explain', {})).status, 403);
  const option = (question.options as { id: string; text: string }[])[0];
  const body = { questionId: question.id, source: 'option', optionId: option.id, start: 0, end: option.text.length, text: option.text };
  const added = await call(path, body); assert.equal(added.status, 200); assert.equal(added.json.items.length, 2);
  assert.equal((await call(path, { ...body, text: '原文之外' })).status, 400);
  const forged = await fetch(origin + '/api' + path, { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(forged.status, 403);
  const submitted = await call('/exams/' + id + '/submit', {}); assert.equal(submitted.status, 200);
  assert.equal(submitted.json.annotations.length, 2);
  assert.ok(submitted.json.annotations.every((item: any) => item.status === 'marked'));
  extraBusy = true;
  assert.equal((await call(path + '/explain', {})).status, 409);
  assert.equal((await call(path, body)).status, 409);
  assert.equal((await call(path + '/' + added.json.items[1].id, {}, 'DELETE')).status, 409);
  extraBusy = false;
  const result = await call(path + '/explain', {});
  assert.equal(result.status, 200); assert.ok(result.json.items.every((item: any) => item.status === 'completed'));
  assert.equal((await call(path + '/explain', { retryFailedOnly: 'yes' })).status, 400);
  const after = await call('/exams/' + id);
  assert.deepEqual(after.json.grades, submitted.json.grades); assert.equal(after.json.score, submitted.json.score);
  assert.equal((await call(path + '/' + result.json.items[0].id, {}, 'DELETE')).json.items.length, 1);
});
