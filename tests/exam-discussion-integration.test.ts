import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { LearningService, validateBackup, type AIProvider } from '../server/learning.js';
import { createLearningRouter } from '../server/learning-router.js';
import { DataManagementService } from '../server/learning-management.js';
import { localBoundary, errorHandler } from '../server/security.js';

type CapturedRequest = { messages: Parameters<AIProvider['generate']>[0]; model?: string };
const aiAnswer = (text = '这个表达在本题中说明动作发生的时间，请结合前后的助词理解。') => text;

async function setup(t: TestContext, ai?: AIProvider) {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-exam-discussion-integration-'));
  const db = openDatabase(':memory:'); seedDatabase(db);
  const requests: CapturedRequest[] = [];
  const provider: AIProvider = { async generate(messages, model) {
    requests.push({ messages: structuredClone(messages), model });
    return ai ? ai.generate(messages, model) : aiAnswer(`这是第 ${requests.length} 次上下文回答。`);
  } };
  const service = new LearningService(db, provider, { backupDir: join(directory, 'backups') });
  const { id } = await service.createExam({ level: 'N5', count: 2, types: ['reading'], mode: 'exam', source: 'builtin', gradingMode: 'mixed', model: 'test-discussion-model' });
  const questions = JSON.parse(String(db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json)) as { id: string; prompt: string; passage: string; answer: string; options: { id: string; text: string }[] }[];
  let extraBusy = false;
  const app = express(); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app.use(localBoundary(origin)); app.use(express.json());
  app.use('/api', createLearningRouter(service, db, () => extraBusy)); app.use(errorHandler);
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true });
  });
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(origin + '/api' + path, body === undefined ? undefined : { method,
      headers: { Origin: origin, 'X-Study-Client': 'local-web', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as any };
  };
  const path = '/exams/' + id + '/discussion';
  const list = (questionId = questions[0].id) => call(path + '?questionId=' + encodeURIComponent(questionId));
  const ask = (text: string, questionId = questions[0].id, clientRequestId = randomUUID()) => call(path, { questionId, text, clientRequestId });
  const reply = (turnId: string) => call(path + '/' + turnId + '/reply', {});
  const submit = async () => {
    service.saveAnswers(id, Object.fromEntries(questions.map(question => [question.id, question.answer])));
    return service.submit(id);
  };
  const manager = new DataManagementService(db, { isBusy: () => service.isBusy(), backup: () => service.createDeletionBackup() });
  return { directory, db, service, manager, id, questions, requests, origin, path, call, list, ask, reply, submit, setExtraBusy: (value: boolean) => { extraBusy = value; } };
}

test('exam discussion HTTP queues multiple questions before submission, validates origin and input, and deduplicates repeated sends', async t => {
  const { service, id, questions, requests, origin, path, call, list, ask, reply } = await setup(t);
  const empty = await list(); assert.equal(empty.status, 200); assert.equal(empty.json.canAsk, false); assert.equal(empty.json.questionId, questions[0].id); assert.equal(empty.json.limits.maxText, 4000);
  const clientRequestId = randomUUID();
  const first = await ask('为什么这里使用这个助词，而不是另一个？', questions[0].id, clientRequestId);
  assert.equal(first.status, 200); assert.equal(first.json.items.length, 1); assert.equal(first.json.items[0].status, 'queued'); assert.equal(first.json.items[0].answer, null);
  const turnId = first.json.items[0].id;
  const repeated = await ask('为什么这里使用这个助词，而不是另一个？', questions[0].id, clientRequestId);
  assert.equal(repeated.status, 200); assert.equal(repeated.json.items.length, 1); assert.equal(repeated.json.items[0].id, turnId);
  assert.equal((await ask('使用相同发送编号但不同文本。', questions[0].id, clientRequestId)).status, 409);
  assert.equal((await ask('为什么这里使用这个助词，而不是另一个？', questions[1].id, clientRequestId)).status, 409);
  await ask('我还不明白这个句子的主语是谁。');
  assert.equal((await list()).json.items.length, 2);
  assert.equal(requests.length, 0, 'queued questions must not trigger model requests before submission');
  assert.equal((await reply(turnId)).status, 403);
  assert.equal(service.getExam(id).questions[0].answer, undefined);
  for (const body of [
    { questionId: questions[0].id, text: '', clientRequestId: randomUUID() },
    { questionId: questions[0].id, text: '长'.repeat(4001), clientRequestId: randomUUID() },
    { questionId: 'not-this-paper', text: '为什么？', clientRequestId: randomUUID() },
    { questionId: questions[0].id, text: '为什么？', clientRequestId: 'not-a-uuid' },
    { questionId: questions[0].id, text: '为什么？', clientRequestId: randomUUID(), answer: 'forged-answer' },
  ]) assert.ok((await call(path, body)).status >= 400);
  assert.equal((await list('not-this-paper')).status, 404);
  const forged = await fetch(origin + '/api' + path, { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: questions[0].id, text: '为什么？', clientRequestId: randomUUID() }) });
  assert.equal(forged.status, 403); assert.equal(requests.length, 0);
});

test('practice feedback revealing an answer still keeps free questions queued until the whole exam is submitted', async t => {
  const { service, requests, call } = await setup(t);
  const { id } = await service.createExam({ level: 'N5', count: 1, types: ['reading'], mode: 'practice', source: 'builtin' });
  const question = JSON.parse(String(service.db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json))[0];
  service.saveAnswers(id, { [question.id]: question.answer }); await service.feedback(id, question.id);
  assert.equal(service.getExam(id).questions[0].answer, question.answer);
  const path = '/exams/' + id + '/discussion';
  const queued = await call(path, { questionId: question.id, text: '已经看过本题反馈，但交卷前先保存我的问题。', clientRequestId: randomUUID() });
  assert.equal(queued.status, 200); assert.equal(queued.json.canAsk, false); assert.equal(queued.json.items[0].status, 'queued');
  assert.equal((await call(path + '/' + queued.json.items[0].id + '/reply', {})).status, 403);
  assert.equal(requests.length, 0);
});

test('submitted discussion includes full saved question and same-question history, but never another question conversation or grade changes', async t => {
  const { service, id, questions, requests, ask, reply, list, submit } = await setup(t);
  const first = (await ask('FIRST_SAME_QUESTION 为什么材料里这样表达？')).json.items[0];
  const secondQuestion = (await ask('PRIVATE_OTHER_QUESTION 问另外一道题。', questions[1].id)).json.items[0];
  await submit(); const gradesBefore = JSON.stringify(service.getExam(id).grades); const scoreBefore = service.getExam(id).score;
  await reply(secondQuestion.id);
  const answered = await reply(first.id); assert.equal(answered.status, 200); assert.equal(answered.json.items[0].status, 'completed');
  const firstAnswer = answered.json.items[0].answer;
  assert.equal(typeof firstAnswer, 'string'); assert.ok(firstAnswer.length > 0);
  const input = requests.at(-1)!; const serialized = JSON.stringify(input.messages); const payload = JSON.parse(input.messages.at(-1)!.content);
  assert.equal(input.model, 'test-discussion-model');
  assert.deepEqual(payload.question, questions[0]); assert.equal(payload.learnerAnswer, questions[0].answer);
  assert.equal(payload.grade.score, service.getExam(id).grades[questions[0].id].score); assert.deepEqual(payload.history, []);
  assert.ok(serialized.includes('FIRST_SAME_QUESTION'));
  assert.ok(!serialized.includes('PRIVATE_OTHER_QUESTION'), 'other questions must not leak into the selected question history');
  const followup = await ask('FOLLOWUP_SAME_QUESTION 能再给我一个对比例子吗？');
  assert.equal(followup.status, 200); assert.equal(followup.json.items.length, 2); assert.ok(followup.json.items.every((item: any) => item.status === 'completed'));
  const followupInput = JSON.stringify(requests.at(-1)!.messages); const followupPayload = JSON.parse(requests.at(-1)!.messages.at(-1)!.content);
  assert.deepEqual(followupPayload.history, [{ role: 'user', content: 'FIRST_SAME_QUESTION 为什么材料里这样表达？' }, { role: 'assistant', content: firstAnswer }]);
  assert.ok(followupInput.includes('FOLLOWUP_SAME_QUESTION'));
  assert.ok(!followupInput.includes('PRIVATE_OTHER_QUESTION'));
  assert.equal((await list(questions[1].id)).json.items.length, 1);
  assert.equal(JSON.stringify(service.getExam(id).grades), gradesBefore); assert.equal(service.getExam(id).score, scoreBefore);
  const callsBefore = requests.length; await reply(first.id); assert.equal(requests.length, callsBefore, 'completed replies are reused');
});

test('each failed exam discussion reply preserves detailed diagnostics and later success does not overwrite failure history or grades', async t => {
  let failures = 2;
  const upstream = () => Object.assign(new Error('上游暂时不可用。'), { code: 'MODEL_NETWORK_ERROR', status: 502, diagnostics: { upstreamStatus: 503, upstreamMessage: 'Temporary upstream failure.', requestId: 'req-exam-discussion', responseId: 'resp-exam-discussion', stage: 'response-http', networkCode: 'ECONNRESET' } });
  const { service, id, questions, path, call, ask, reply, submit } = await setup(t, { async generate() { if (failures-- > 0) throw upstream(); return aiAnswer('这是重试成功后的具体语法解释。'); } });
  const turn = (await ask('请解释我这道题的错误思路。')).json.items[0]; await submit();
  const grades = JSON.stringify(service.getExam(id).grades);
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = await reply(turn.id); assert.equal(failed.status, 200); assert.equal(failed.json.items[0].status, 'failed'); assert.ok(failed.json.items[0].error);
  }
  const history = service.diagnostics.list({ examId: id, operation: 'followup' });
  assert.equal(history.total, 2); assert.notEqual(history.items[0].id, history.items[1].id);
  for (const item of history.items) { assert.equal(item.questionId, questions[0].id); assert.equal(item.code, 'MODEL_NETWORK_ERROR'); assert.equal(item.upstreamStatus, 503); assert.equal(item.requestId, 'req-exam-discussion'); assert.equal(item.upstreamMessage, 'Temporary upstream failure.'); assert.equal(item.networkCode, 'ECONNRESET'); assert.ok(!Number.isNaN(Date.parse(item.createdAt))); }
  const success = await reply(turn.id); assert.equal(success.json.items[0].status, 'completed'); assert.equal(success.json.items[0].error, null);
  assert.equal(service.diagnostics.list({ examId: id, operation: 'followup' }).total, 2); assert.equal(JSON.stringify(service.getExam(id).grades), grades);
  assert.equal((await call(path + '/' + turn.id, {}, 'DELETE')).status, 200);
  assert.equal(service.diagnostics.list({ examId: id, operation: 'followup' }).total, 2, 'removing a discussion turn keeps prior failure diagnostics until its exam or diagnostic history is deleted');
});

test('v4 discussion backups round-trip, v1/v2/v3 imports initialize empty discussions, and invalid references or states fail before writes', async t => {
  const { service, db, id, ask, reply, submit, list } = await setup(t);
  const queued = (await ask('我想问这个表达的语气。')).json.items[0];
  await submit(); await reply(queued.id);
  const backup = service.backup(); assert.equal(backup.version, 5); assert.equal(backup.tables.exam_qa_turns.length, 1); assert.equal(validateBackup(backup).tables.exam_qa_turns.length, 1);
  const saved = (await list()).json.items[0];
  for (const version of [1, 2, 3]) {
    const legacy = structuredClone(backup) as any; legacy.version = version; delete legacy.tables.exam_qa_turns; delete legacy.tables.review_points; delete legacy.tables.review_sources; delete legacy.tables.review_events;
    if (version < 3) delete legacy.tables.ai_failures;
    if (version < 2) delete legacy.tables.exam_annotations;
    assert.deepEqual(validateBackup(legacy).tables.exam_qa_turns, []);
    const restored = service.restore(legacy); assert.equal((await list()).json.items.length, 0);
    assert.equal(validateBackup(JSON.parse(readFileSync(restored.beforeRestoreBackup, 'utf8'))).tables.exam_qa_turns.length, 1);
    service.restore(backup); assert.deepEqual((await list()).json.items[0], saved);
  }
  const mutations: ((copy: any) => void)[] = [
    copy => { copy.tables.exam_qa_turns[0].exam_id = 'missing-exam'; },
    copy => { copy.tables.exam_qa_turns[0].question_id = 'missing-question'; },
    copy => { copy.tables.exam_qa_turns[0].assistant_text = null; },
    copy => { copy.tables.exam_qa_turns[0].status = 'queued'; },
    copy => { copy.tables.exams.find((exam: any) => exam.id === id).submitted_at = null; },
    copy => { copy.tables.exam_qa_turns[0].unknown = 'unexpected'; },
    copy => { copy.tables.exam_qa_turns.push({ ...copy.tables.exam_qa_turns[0], id: randomUUID() }); },
    copy => { copy.version = 3; },
    copy => { delete copy.tables.exam_qa_turns; },
  ];
  for (const mutate of mutations) {
    const broken = structuredClone(backup); mutate(broken); const before = db.prepare('SELECT total_changes() AS n').get()!.n;
    assert.throws(() => service.restore(broken), (error: any) => error.code === 'INVALID_BACKUP');
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before); assert.equal((await list()).json.items[0].answer, saved.answer);
  }
  assert.equal(service.getExam(id).status, 'completed');
});

test('startup and restore recover pending discussion exactly once while preserving successful grades', async t => {
  const { service, db, id, ask, submit, list } = await setup(t);
  const turn = (await ask('请说明这句话省略了什么。')).json.items[0]; await submit();
  const grades = JSON.stringify(service.getExam(id).grades);
  db.prepare("UPDATE exam_qa_turns SET status='pending',error=NULL WHERE id=?").run(turn.id);
  const restarted = new LearningService(db); const recovered = restarted.discussions.list(id, turn.questionId);
  assert.equal(recovered.items[0].status, 'failed'); assert.ok(recovered.items[0].error);
  const histories = restarted.diagnostics.list({ examId: id, operation: 'followup' }); assert.equal(histories.total, 1); assert.equal(histories.items[0].source, 'recovery'); assert.equal(histories.items[0].category, 'interrupted');
  new LearningService(db); assert.equal(restarted.diagnostics.list({ examId: id, operation: 'followup' }).total, 1);
  const pendingBackup = service.backup() as any;
  Object.assign(pendingBackup.tables.exam_qa_turns[0], { status: 'pending', error: null, assistant_text: null });
  service.restore(pendingBackup); assert.equal((await list()).json.items[0].status, 'failed');
  assert.equal(JSON.stringify(service.getExam(id).grades), grades);
});

test('discussion flights lock global data changes, respect connection-test busy, and delete cascades with a restorable safety copy', { timeout: 20_000 }, async t => {
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const { service, manager, id, questions, path, call, ask, reply, submit, setExtraBusy, list } = await setup(t, { async generate() { started(); await held; return aiAnswer(); } });
  t.after(() => release());
  const turn = (await ask('我想确认这句话的时态。')).json.items[0]; await submit();
  const backup = service.backup(); const preview = manager.preview({ scope: 'exam', id }); assert.equal(preview.counts.discussions, 1);
  setExtraBusy(true);
  assert.equal((await reply(turn.id)).status, 409); assert.equal((await ask('临时问题。')).status, 409);
  assert.equal((await call(path + '/' + turn.id, {}, 'DELETE')).status, 409); setExtraBusy(false);
  const flight = reply(turn.id); await began;
  assert.equal(service.isBusy(), true);
  assert.throws(() => manager.preview({ scope: 'all' }), (error: any) => error.status === 409);
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), (error: any) => error.status === 409);
  assert.throws(() => service.restore(backup), (error: any) => error.code === 'RESTORE_BUSY');
  assert.throws(() => service.setGradingMode(id, { gradingMode: 'ai' }), (error: any) => error.status === 409);
  const prompt = questions[0].prompt;
  assert.throws(() => service.annotations.add(id, { questionId: questions[0].id, source: 'prompt', start: 0, end: 1, text: prompt.slice(0, 1) }), (error: any) => error.status === 409);
  release(); const completed = await flight; assert.equal(completed.json.items[0].status, 'completed'); assert.equal(service.isBusy(), false);
  assert.throws(() => manager.remove({ token: preview.token, confirmation: '删除' }), (error: any) => error.code === 'DELETE_PREVIEW_STALE');
  const fresh = manager.preview({ scope: 'exam', id }); const removed = manager.remove({ token: fresh.token, confirmation: '删除' });
  assert.equal(removed.counts.discussions, 1); assert.equal(manager.summary().counts.discussions, 0);
  const safety = validateBackup(JSON.parse(readFileSync(removed.beforeDeleteBackup, 'utf8'))); assert.equal(safety.tables.exam_qa_turns.length, 1);
  service.restore(safety); assert.equal((await list()).json.items[0].status, 'completed');
  const deleted = await call(path + '/' + turn.id, {}, 'DELETE'); assert.equal(deleted.status, 200); assert.equal(deleted.json.items.length, 0);
});
