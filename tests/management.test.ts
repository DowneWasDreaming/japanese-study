import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db.js';
import { seedDatabase, type Question } from '../server/seed.js';
import { LearningService, validateBackup } from '../server/learning.js';
import { knowledgePoints, DataManagementService } from '../server/learning-management.js';

async function setup(t: TestContext, file = false) {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-management-'));
  const path = file ? join(directory, 'learning.sqlite') : ':memory:';
  const db = openDatabase(path);
  seedDatabase(db);
  const learning = new LearningService(db, undefined, { backupDir: join(directory, 'backups') });
  let busy = false, backupCalls = 0;
  const manager = new DataManagementService(db, { isBusy: () => busy,
    backup: () => { backupCalls++; return learning.createDeletionBackup(); } });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = await learning.createExam({ level: 'N5', count: 2, types: ['fill'], mode: 'practice', source: 'builtin' });
  const second = await learning.createExam({ level: 'N4', count: 2, types: ['single'], mode: 'practice', source: 'builtin' });
  const questions = (id: string) => JSON.parse(String(db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json)) as Question[];
  const insertGrade = (id: string, question: Question, status = 'completed', correct: number | null = 1, stamp = '2026-10-13T04:00:00.000Z') => {
    db.prepare('INSERT INTO grades(exam_id,question_id,status,score,max_score,correct,feedback,suggestion,reference,error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, question.id, status, status === 'completed' ? (correct ? question.points : 0) : null, question.points,
        status === 'completed' ? correct : null, '已评阅。', '', question.answer, status === 'failed' ? '连接失败' : null, stamp);
  };
  return { db, path, directory, learning, manager, first: first.id, second: second.id, questions, insertGrade,
    setBusy: (value: boolean) => { busy = value; }, backupCalls: () => backupCalls };
}
const isError = (code: string, status?: number) => (error: any) => error.code === code && (status === undefined || error.status === status);
const count = (db: ReturnType<typeof openDatabase>, table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);

function addConversation(db: ReturnType<typeof openDatabase>, id: string) {
  const stamp = '2026-10-13T03:00:00.000Z';
  db.prepare('INSERT INTO conversations(id,title,kind,level,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, '讲解', 'word', 'N5', stamp, stamp);
  for (const role of ['user', 'assistant']) db.prepare('INSERT INTO messages(conversation_id,role,content,created_at) VALUES(?,?,?,?)').run(id, role, '内容', stamp);
}

test('knowledge points distinguish generated questions from completed grades and normalize duplicate tags', async t => {
  const { db, first, second, questions, insertGrade } = await setup(t);
  const firstQuestions = questions(first), secondQuestions = questions(second);
  firstQuestions[0].knowledgePoints = [' は\u3099 ', 'ば', 'ば'];
  firstQuestions[1].knowledgePoints = ['ば', '助词'];
  secondQuestions[0].knowledgePoints = ['ば'];
  secondQuestions[1].knowledgePoints = ['未作答'];
  db.prepare('UPDATE exams SET questions_json=?,created_at=? WHERE id=?').run(JSON.stringify(firstQuestions), '2026-10-12T00:00:00.000Z', first);
  db.prepare('UPDATE exams SET questions_json=?,created_at=? WHERE id=?').run(JSON.stringify(secondQuestions), '2026-10-13T00:00:00.000Z', second);
  insertGrade(first, firstQuestions[0], 'completed', 1, '2026-10-13T01:00:00.000Z');
  insertGrade(first, firstQuestions[1], 'completed', 0, '2026-10-13T02:00:00.000Z');
  insertGrade(second, secondQuestions[0], 'failed', null);
  const items = knowledgePoints(db).items;
  const n5 = items.find(point => point.name === 'ば' && point.level === 'N5')!;
  assert.equal(n5.questionCount, 2); assert.equal(n5.attempts, 2); assert.equal(n5.correct, 1); assert.equal(n5.accuracy, 0.5);
  assert.equal(n5.lastPracticed, '2026-10-13T02:00:00.000Z'); assert.equal(n5.examId, first);
  const n4 = items.find(point => point.name === 'ば' && point.level === 'N4')!;
  assert.equal(n4.questionCount, 1); assert.equal(n4.attempts, 0); assert.equal(n4.accuracy, null); assert.equal(n4.lastPracticed, null);
  assert.equal(items.find(point => point.name === '未作答')!.accuracy, null);
  assert.equal(knowledgePoints(db, { level: 'N5', q: ' は\u3099 ' }).items.length, 1);
  assert.deepEqual(knowledgePoints(db, { q: '不存在' }).items, []);
});

test('knowledge point history updates to the latest saved paper and disappears with removed papers', async t => {
  const { db, first, second, questions, manager } = await setup(t);
  for (const [id, stamp] of [[first, '2026-10-12T00:00:00.000Z'], [second, '2026-10-13T00:00:00.000Z']]) {
    const qs = questions(id); for (const q of qs) { q.level = 'N5'; q.knowledgePoints = ['词汇']; }
    db.prepare('UPDATE exams SET level=?,questions_json=?,created_at=? WHERE id=?').run('N5', JSON.stringify(qs), stamp, id);
  }
  assert.equal(knowledgePoints(db).items[0].questionCount, 4);
  assert.equal(knowledgePoints(db).items[0].examId, second);
  const preview = manager.preview({ scope: 'exam', id: second });
  manager.remove({ token: preview.token, confirmation: '删除' });
  assert.equal(knowledgePoints(db).items[0].questionCount, 2);
  assert.equal(knowledgePoints(db).items[0].examId, first);
});

test('preview and summary show counts without database writes or backups', async t => {
  const { db, first, questions, manager, backupCalls } = await setup(t);
  const question = questions(first)[0];
  db.prepare('INSERT INTO answers(exam_id,question_id,answer,updated_at) VALUES(?,?,?,?)').run(first, question.id, '回答', '2026-10-13T00:00:00.000Z');
  const before = db.prepare('SELECT total_changes() AS n').get()!.n;
  const preview = manager.preview({ scope: 'exam', id: first });
  assert.equal(preview.counts.exams, 1); assert.equal(preview.counts.answers, 1);
  assert.equal(manager.summary().counts.exams, 2); assert.equal(manager.summary().busy, false);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before); assert.equal(backupCalls(), 0);
  assert.equal(new Date(preview.expiresAt).getTime() > Date.now(), true);
});

test('single paper deletion cascades dependent records, cleans non-FK mistakes and creates a restorable backup', async t => {
  const { db, first, second, questions, insertGrade, manager, learning } = await setup(t);
  const question = questions(first)[0];
  insertGrade(first, question);
  db.prepare('INSERT INTO answers(exam_id,question_id,answer,updated_at) VALUES(?,?,?,?)').run(first, question.id, question.answer, '2026-10-13T00:00:00.000Z');
  db.prepare('INSERT INTO mistakes(question_id,question_json,exam_id,level,type,errors,last_practiced,knowledge_points_json) VALUES(?,?,?,?,?,?,?,?)')
    .run(question.id, JSON.stringify(question), first, question.level, question.type, 1, '2026-10-13T00:00:00.000Z', JSON.stringify(question.knowledgePoints));
  db.prepare('INSERT INTO reports(id,exam_id,question_id,note,created_at) VALUES(?,?,?,?,?)').run('report', first, question.id, '请复核', '2026-10-13T00:00:00.000Z');
  db.prepare('INSERT INTO grading_events(exam_id,question_id,created_at) VALUES(?,?,?)').run(first, question.id, '2026-10-13T00:00:00.000Z');
  const preview = manager.preview({ scope: 'exam', id: first });
  assert.equal(preview.counts.mistakes, 1); assert.equal(preview.counts.reports, 1); assert.equal(preview.counts.gradingEvents, 1);
  const result = manager.remove({ token: preview.token, confirmation: '删除' });
  assert.equal(result.deleted, true); assert.equal(count(db, 'exams'), 1);
  assert.ok(db.prepare('SELECT 1 FROM exams WHERE id=?').get(second));
  for (const table of ['answers', 'grades', 'mistakes', 'reports', 'grading_events']) assert.equal(count(db, table), 0, table);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const backup = validateBackup(JSON.parse(readFileSync(result.beforeDeleteBackup, 'utf8')));
  assert.equal(backup.tables.exams.length, 2); assert.equal(backup.tables.answers.length, 1);
  learning.restore(backup); assert.equal(count(db, 'exams'), 2); assert.equal(count(db, 'mistakes'), 1);
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), isError('DELETE_PREVIEW_EXPIRED', 409));
});

test('single conversation deletion removes its messages and preserves other conversations and cache', async t => {
  const { db, manager } = await setup(t);
  addConversation(db, 'one'); addConversation(db, 'two');
  db.prepare('INSERT INTO explanation_cache(cache_key,kind,level,input,text,created_at) VALUES(?,?,?,?,?,?)').run('a'.repeat(64), 'word', 'N5', '水', '讲解', '2026-10-13T00:00:00.000Z');
  const preview = manager.preview({ scope: 'conversation', id: 'one' });
  assert.equal(preview.counts.conversations, 1); assert.equal(preview.counts.messages, 2);
  manager.remove({ token: preview.token, confirmation: '删除' });
  assert.equal(count(db, 'conversations'), 1); assert.equal(count(db, 'messages'), 2); assert.equal(count(db, 'explanation_cache'), 1);
  assert.ok(db.prepare('SELECT 1 FROM conversations WHERE id=?').get('two'));
});

test('all deletion clears personal records while preserving original content, bank, quota and account files', async t => {
  const { db, directory, first, questions, manager, insertGrade } = await setup(t);
  const q = questions(first)[0]; insertGrade(first, q);
  addConversation(db, 'one');
  db.prepare('INSERT INTO saved(content_id,type,created_at) VALUES(?,?,?)').run(String(db.prepare('SELECT id FROM content LIMIT 1').get()!.id), 'favorite', '2026-10-13T00:00:00.000Z');
  db.prepare('INSERT INTO explanation_cache(cache_key,kind,level,input,text,created_at) VALUES(?,?,?,?,?,?)').run('a'.repeat(64), 'word', 'N5', '水', '讲解', '2026-10-13T00:00:00.000Z');
  db.prepare('INSERT INTO local_ai_requests(created_at) VALUES(?)').run(Date.now());
  const sentinel = join(directory, 'account-sentinel.json'); writeFileSync(sentinel, 'account file preserved');
  const contentCount = count(db, 'content'), bankCount = count(db, 'question_bank');
  const preview = manager.preview({ scope: 'all' }); const result = manager.remove({ token: preview.token, confirmation: '删除' });
  for (const n of Object.values(manager.summary().counts)) assert.equal(n, 0);
  assert.deepEqual(knowledgePoints(db).items, []); assert.equal(count(db, 'content'), contentCount); assert.equal(count(db, 'question_bank'), bankCount);
  assert.equal(count(db, 'local_ai_requests'), 1); assert.equal(readFileSync(sentinel, 'utf8'), 'account file preserved');
  const backup = JSON.parse(readFileSync(result.beforeDeleteBackup, 'utf8'));
  assert.equal(Object.hasOwn(backup.tables, 'local_ai_requests'), false); assert.equal(backup.tables.exams.length, 2);
});

test('category deletion preserves unrelated records', async t => {
  for (const scope of ['exams', 'mistakes', 'saved', 'conversations', 'cache'] as const) {
    const { db, first, questions, manager } = await setup(t);
    const q = questions(first)[0];
    addConversation(db, 'one');
    db.prepare('INSERT INTO mistakes(question_id,question_json,exam_id,level,type,errors,last_practiced,knowledge_points_json) VALUES(?,?,?,?,?,?,?,?)')
      .run(q.id, JSON.stringify(q), first, q.level, q.type, 1, '2026-10-13T00:00:00.000Z', JSON.stringify(q.knowledgePoints));
    db.prepare('INSERT INTO saved(content_id,type,created_at) VALUES(?,?,?)').run(String(db.prepare('SELECT id FROM content LIMIT 1').get()!.id), 'word', '2026-10-13T00:00:00.000Z');
    db.prepare('INSERT INTO explanation_cache(cache_key,kind,level,input,text,created_at) VALUES(?,?,?,?,?,?)').run('a'.repeat(64), 'word', 'N5', '水', '讲解', '2026-10-13T00:00:00.000Z');
    const preview = manager.preview({ scope }); manager.remove({ token: preview.token, confirmation: '删除' });
    assert.equal(count(db, 'exams'), scope === 'exams' ? 0 : 2);
    assert.equal(count(db, 'mistakes'), scope === 'exams' || scope === 'mistakes' ? 0 : 1);
    assert.equal(count(db, 'saved'), scope === 'saved' ? 0 : 1);
    assert.equal(count(db, 'conversations'), scope === 'conversations' ? 0 : 1);
    assert.equal(count(db, 'messages'), scope === 'conversations' ? 0 : 2);
    assert.equal(count(db, 'explanation_cache'), scope === 'cache' ? 0 : 1);
  }
});

test('deletion requires explicit confirmation and rejects malformed or missing record selections', async t => {
  const { db, first, manager, backupCalls } = await setup(t);
  for (const input of [null, [], {}, { scope: 'invalid' }, { scope: 'exam' }, { scope: 'exam', id: 1 }, { scope: 'all', id: first }, { scope: 'all', extra: true }]) {
    assert.throws(() => manager.preview(input), isError('INVALID_DELETE_REQUEST', 400));
  }
  assert.throws(() => manager.preview({ scope: 'exam', id: 'missing' }), isError('DATA_NOT_FOUND', 404));
  const preview = manager.preview({ scope: 'all' });
  for (const input of [{ token: preview.token }, { token: preview.token, confirmation: 'yes' }, { token: preview.token, confirmation: '删除', scope: 'all' }]) {
    assert.throws(() => manager.remove(input), isError('DELETE_CONFIRMATION_REQUIRED', 400));
  }
  assert.equal(count(db, 'exams'), 2); assert.equal(backupCalls(), 0);
});

test('busy operations block preview and confirmation without database changes', async t => {
  const { db, manager, setBusy, backupCalls } = await setup(t);
  setBusy(true); assert.equal(manager.summary().busy, true);
  assert.throws(() => manager.preview({ scope: 'all' }), isError('LEARNING_BUSY', 409));
  setBusy(false); const preview = manager.preview({ scope: 'all' }); setBusy(true);
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), isError('LEARNING_BUSY', 409));
  assert.equal(count(db, 'exams'), 2); assert.equal(backupCalls(), 0);
});

test('confirmation expires and rejects changed database state on this connection and another connection', async t => {
  const { db, path, manager, backupCalls } = await setup(t, true);
  let preview = manager.preview({ scope: 'all' });
  db.prepare('UPDATE exams SET title=?').run('更新标题');
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), isError('DELETE_PREVIEW_STALE', 409));
  preview = manager.preview({ scope: 'all' });
  const other = openDatabase(path);
  try { other.prepare('UPDATE exams SET title=?').run('另一个连接更新'); } finally { other.close(); }
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), isError('DELETE_PREVIEW_STALE', 409));
  preview = manager.preview({ scope: 'all' });
  const future = Date.now() + 300_001; t.mock.method(Date, 'now', () => future);
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), isError('DELETE_PREVIEW_EXPIRED', 409));
  assert.equal(count(db, 'exams'), 2); assert.equal(backupCalls(), 0);
});

test('backup failure prevents all deletions and consumes the confirmation', async t => {
  const { db } = await setup(t);
  const manager = new DataManagementService(db, { isBusy: () => false, backup: () => { throw new Error('backup disk failure'); } });
  const preview = manager.preview({ scope: 'all' });
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), /backup disk failure/);
  assert.equal(count(db, 'exams'), 2); assert.equal(db.isTransaction, false);
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), isError('DELETE_PREVIEW_EXPIRED', 409));
});

test('a failed deletion transaction restores previously deleted dependent rows', async t => {
  const { db, first, questions, manager, backupCalls } = await setup(t);
  const q = questions(first)[0];
  db.prepare('INSERT INTO mistakes(question_id,question_json,exam_id,level,type,errors,last_practiced,knowledge_points_json) VALUES(?,?,?,?,?,?,?,?)')
    .run(q.id, JSON.stringify(q), first, q.level, q.type, 1, '2026-10-13T00:00:00.000Z', JSON.stringify(q.knowledgePoints));
  db.exec("CREATE TEMP TRIGGER prevent_delete BEFORE DELETE ON exams BEGIN SELECT RAISE(ABORT, 'temporary failure'); END;");
  const preview = manager.preview({ scope: 'all' });
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), /temporary failure/);
  assert.equal(count(db, 'exams'), 2); assert.equal(count(db, 'mistakes'), 1); assert.equal(backupCalls(), 1);
  assert.equal(db.isTransaction, false);
});
