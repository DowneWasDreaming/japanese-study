import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { LearningError } from './learning.js';

export interface KnowledgePointRecord {
  name: string;
  level: string;
  questionCount: number;
  attempts: number;
  correct: number;
  accuracy: number | null;
  lastPracticed: string | null;
  lastGenerated: string;
  examId: string;
}

/** Statistics use saved paper snapshots, so changing the question bank cannot
 * change an old result. A point contributes at most once per saved question. */
export function knowledgePoints(db: DatabaseSync, query: { level?: string; q?: string } = {}) {
  const points = new Map<string, KnowledgePointRecord>();
  const grades = new Map(db.prepare("SELECT exam_id, question_id, correct, updated_at FROM grades WHERE status='completed'").all()
    .map(row => [JSON.stringify([row.exam_id, row.question_id]), row]));
  const exams = db.prepare('SELECT id, level, created_at, questions_json FROM exams ORDER BY created_at, id').all();
  for (const exam of exams) {
    const questions = JSON.parse(String(exam.questions_json)) as { id: string; level?: string; knowledgePoints?: string[] }[];
    for (const question of questions) {
      const level = question.level || String(exam.level);
      const tags = new Set((question.knowledgePoints || []).map(name => name.normalize('NFC').trim()).filter(Boolean));
      const grade = grades.get(JSON.stringify([exam.id, question.id]));
      for (const name of tags) {
        const key = JSON.stringify([level, name]);
        let point = points.get(key);
        if (!point) {
          point = { name, level, questionCount: 0, attempts: 0, correct: 0, accuracy: null,
            lastPracticed: null, lastGenerated: String(exam.created_at), examId: String(exam.id) };
          points.set(key, point);
        }
        point.questionCount++;
        if (String(exam.created_at) >= point.lastGenerated) {
          point.lastGenerated = String(exam.created_at);
          point.examId = String(exam.id);
        }
        if (grade) {
          point.attempts++;
          if (grade.correct === 1) point.correct++;
          const practiced = String(grade.updated_at);
          if (!point.lastPracticed || practiced > point.lastPracticed) point.lastPracticed = practiced;
        }
      }
    }
  }
  const search = (query.q || '').normalize('NFC').trim().toLocaleLowerCase();
  const items = [...points.values()].filter(point => (!query.level || point.level === query.level)
    && (!search || point.name.toLocaleLowerCase().includes(search)));
  for (const point of items) point.accuracy = point.attempts ? point.correct / point.attempts : null;
  items.sort((a, b) => b.lastGenerated.localeCompare(a.lastGenerated) || a.level.localeCompare(b.level) || a.name.localeCompare(b.name));
  return { items };
}

const scopes = ['exam', 'conversation', 'exams', 'mistakes', 'saved', 'conversations', 'cache', 'all'] as const;
type DeleteScope = typeof scopes[number];
interface DeleteRequest { scope: DeleteScope; id?: string }
export interface DataCounts {
  exams: number; answers: number; grades: number; mistakes: number; saved: number;
  conversations: number; messages: number; cache: number; reports: number; gradingEvents: number; annotations: number;
}
interface StoredPreview {
  request: DeleteRequest;
  signature: string;
  expiresAt: number;
  counts: DataCounts;
}
const labels: Record<DeleteScope, string> = {
  exam: '这份试卷及其关联记录', conversation: '这段讲解对话及其消息', exams: '全部试卷及其关联记录',
  mistakes: '全部错题记录', saved: '全部单词本与收藏记录', conversations: '全部讲解对话及消息',
  cache: '全部讲解缓存', all: '全部个人学习记录',
};
const emptyCounts = (): DataCounts => ({ exams: 0, answers: 0, grades: 0, mistakes: 0, saved: 0,
  conversations: 0, messages: 0, cache: 0, reports: 0, gradingEvents: 0, annotations: 0 });
const objectInput = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LearningError('数据操作参数无效。', 'INVALID_DELETE_REQUEST');
  return input as Record<string, unknown>;
};

/** Deletion confirmations are short-lived, single-use, and bound to the exact
 * database state that the user reviewed. No preview writes to the database. */
export class DataManagementService {
  private readonly previews = new Map<string, StoredPreview>();
  constructor(private readonly db: DatabaseSync, private readonly options: { isBusy: () => boolean; backup: () => string }) {}

  summary() { return { counts: this.allCounts(), busy: this.options.isBusy() }; }

  preview(input: unknown) {
    this.requireIdle();
    const data = objectInput(input);
    if (Object.keys(data).some(key => key !== 'scope' && key !== 'id')
      || typeof data.scope !== 'string' || !scopes.includes(data.scope as DeleteScope)) {
      throw new LearningError('请选择有效的数据删除范围。', 'INVALID_DELETE_REQUEST');
    }
    const scope = data.scope as DeleteScope;
    const single = scope === 'exam' || scope === 'conversation';
    if ((single && (typeof data.id !== 'string' || !data.id.length || data.id.length > 200))
      || (!single && data.id !== undefined)) throw new LearningError('数据删除范围与记录编号不匹配。', 'INVALID_DELETE_REQUEST');
    const request: DeleteRequest = { scope, ...(single ? { id: data.id as string } : {}) };
    this.prune();
    if (this.previews.size >= 500) throw new LearningError('确认请求过多，请稍后重试。', 'DELETE_PREVIEW_LIMIT', 429);
    const token = randomUUID();
    const expiresAt = Date.now() + 5 * 60_000;
    const snapshot = transaction(this.db, () => {
      if (single) {
        const table = scope === 'exam' ? 'exams' : 'conversations';
        if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(request.id!)) {
          throw new LearningError('这条记录不存在，或已经被删除。', 'DATA_NOT_FOUND', 404);
        }
      }
      return { counts: this.countsFor(request), signature: this.signature() };
    });
    const { counts } = snapshot;
    this.previews.set(token, { request, ...snapshot, expiresAt });
    const warning = scope === 'exam' || scope === 'exams'
      ? '将一并删除关联答案、评分、词句标记与解析、当前关联的错题、纠错报告与评分事件，知识点统计会随之更新。'
      : scope === 'all' ? '将清空试卷、答案、评分、词句标记与解析、错题、收藏、讲解对话及缓存，知识点统计也将清空。'
      : scope === 'conversation' || scope === 'conversations' ? '将删除对话及其全部消息；讲解缓存需另行删除。'
      : scope === 'cache' ? '删除缓存后，再次请求 AI 讲解时需要重新生成；现有讲解对话仍保留。'
      : scope === 'mistakes' ? '仅清空错题本，试卷、答案和评分仍保留。'
      : '将移除单词本与收藏标记，原始学习内容仍保留。';
    return { token, ...request, label: labels[scope], counts,
      warning: `${warning} 操作前会保存一份可恢复备份；原始题库、账号连接与请求限额记录保留，已有备份及导出文件也保留。`,
      expiresAt: new Date(expiresAt).toISOString() };
  }

  remove(input: unknown) {
    const data = objectInput(input);
    if (Object.keys(data).some(key => key !== 'token' && key !== 'confirmation')
      || typeof data.token !== 'string' || data.token.length > 200 || data.confirmation !== '删除') {
      throw new LearningError('请输入“删除”并确认已经查看删除范围。', 'DELETE_CONFIRMATION_REQUIRED');
    }
    const preview = this.previews.get(data.token);
    if (!preview || preview.expiresAt <= Date.now()) {
      this.previews.delete(data.token);
      throw new LearningError('删除确认已失效，请重新查看删除范围。', 'DELETE_PREVIEW_EXPIRED', 409);
    }
    this.requireIdle();
    // Consume a valid confirmation even if the database has changed or a backup
    // fails. A new attempt must show the current impact to the user again.
    this.previews.delete(data.token);
    return transaction(this.db, () => {
      if (preview.signature !== this.signature()) throw new LearningError('学习数据已发生变化，请重新查看删除范围后确认。', 'DELETE_PREVIEW_STALE', 409);
      const beforeDeleteBackup = this.options.backup();
      this.deleteRecords(preview.request);
      return { deleted: true as const, counts: preview.counts, beforeDeleteBackup };
    });
  }

  private requireIdle() {
    if (this.options.isBusy()) throw new LearningError('正在出题、评分或生成讲解，请待操作完成后管理数据。', 'LEARNING_BUSY', 409);
  }
  private signature() {
    const changes = this.db.prepare('SELECT total_changes() AS value').get()!.value;
    const version = this.db.prepare('PRAGMA data_version').get()!.data_version;
    return `${changes}:${version}`;
  }
  private prune() {
    for (const [token, value] of this.previews) if (value.expiresAt <= Date.now()) this.previews.delete(token);
  }
  private count(table: string, where = '', params: string[] = []) {
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params)!.n);
  }
  private allCounts(): DataCounts {
    return { exams: this.count('exams'), answers: this.count('answers'), grades: this.count('grades'), mistakes: this.count('mistakes'),
      saved: this.count('saved'), conversations: this.count('conversations'), messages: this.count('messages'),
      cache: this.count('explanation_cache'), reports: this.count('reports'), gradingEvents: this.count('grading_events'), annotations: this.count('exam_annotations') };
  }
  private countsFor({ scope, id }: DeleteRequest): DataCounts {
    if (scope === 'all') return this.allCounts();
    const counts = emptyCounts();
    if (scope === 'exam' || scope === 'exams') {
      const where = id ? 'exam_id=?' : '';
      const params = id ? [id] : [];
      counts.exams = this.count('exams', id ? 'id=?' : '', params);
      counts.answers = this.count('answers', where, params);
      counts.grades = this.count('grades', where, params);
      counts.mistakes = this.count('mistakes', id ? 'exam_id=?' : 'exam_id IN (SELECT id FROM exams)', params);
      counts.reports = this.count('reports', where, params);
      counts.gradingEvents = this.count('grading_events', where, params);
      counts.annotations = this.count('exam_annotations', where, params);
    } else if (scope === 'conversation' || scope === 'conversations') {
      counts.conversations = this.count('conversations', id ? 'id=?' : '', id ? [id] : []);
      counts.messages = this.count('messages', id ? 'conversation_id=?' : '', id ? [id] : []);
    } else if (scope === 'mistakes') counts.mistakes = this.count('mistakes');
    else if (scope === 'saved') counts.saved = this.count('saved');
    else if (scope === 'cache') counts.cache = this.count('explanation_cache');
    return counts;
  }
  private deleteRecords({ scope, id }: DeleteRequest) {
    if (scope === 'exam' || scope === 'exams' || scope === 'all') {
      const mistakesWhere = scope === 'exam' ? ' WHERE exam_id=?' : scope === 'exams' ? ' WHERE exam_id IN (SELECT id FROM exams)' : '';
      this.db.prepare(`DELETE FROM mistakes${mistakesWhere}`).run(...(scope === 'exam' ? [id!] : []));
      this.db.prepare(`DELETE FROM exams${scope === 'exam' ? ' WHERE id=?' : ''}`).run(...(scope === 'exam' ? [id!] : []));
    }
    if (scope === 'conversation' || scope === 'conversations' || scope === 'all') {
      this.db.prepare(`DELETE FROM conversations${scope === 'conversation' ? ' WHERE id=?' : ''}`).run(...(scope === 'conversation' ? [id!] : []));
    }
    if (scope === 'mistakes') this.db.exec('DELETE FROM mistakes');
    if (scope === 'saved' || scope === 'all') this.db.exec('DELETE FROM saved');
    if (scope === 'cache' || scope === 'all') this.db.exec('DELETE FROM explanation_cache');
  }
}
