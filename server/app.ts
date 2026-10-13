import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AuthManager, createAuthRouter } from './auth.js';
import { ModelService } from './model.js';
import { LearningService } from './learning.js';
import { createLearningRouter } from './learning-router.js';
import { LimitedGenerator } from './quota.js';
import { localBoundary, errorHandler } from './security.js';
import type { getConfig } from './config.js';

export function createApplication(config: ReturnType<typeof getConfig>, db: DatabaseSync, auth: AuthManager, model: ModelService,
  desktop?: { instance: string; token: string; stop: () => Promise<void> }) {
  const app = express();
  const projectPath = process.platform === 'win32' ? resolve('.').toLowerCase() : resolve('.');
  const project = createHash('sha256').update(projectPath).digest('hex');
  app.disable('x-powered-by');
  app.use(localBoundary(config.origin));
  app.use(express.json({ limit: '15mb' }));
  const limiter = new LimitedGenerator(db, model, Number(process.env.STUDY_AI_HOURLY_LIMIT || 30), Number(process.env.STUDY_AI_DAILY_LIMIT || 150));
  const provider = { async generate(messages: Parameters<ModelService['generate']>[0], selected?: string) {
    if (!auth.status().planAuthorized) throw Object.assign(new Error('请先连接 ChatGPT 并授权使用套餐。'), { code: 'PLAN_PERMISSION_REQUIRED', status: 403 });
    return limiter.generate(messages, selected);
  } };
  const learning = new LearningService(db, provider, { backupDir: resolve(config.dataDir, 'backups') });
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'komorebi-japanese-study', project, storage: 'SQLite', version: '1.0.0', pid: process.pid, desktopInstance: desktop?.instance ?? null }));
  if (desktop) app.post('/api/desktop/stop', (req, res) => {
    const supplied = Buffer.from(String(req.headers['x-study-control'] || ''));
    const expected = Buffer.from(desktop.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.status(403).json({ error: { code: 'INVALID_CONTROL', message: '只能通过本机停止入口关闭服务。' } }); return;
    }
    res.json({ ok: true });
    setImmediate(() => void desktop.stop());
  });
  app.use('/api/auth', createAuthRouter(auth));
  app.get('/auth/callback', async (req, res) => {
    try {
      await auth.callback(new URLSearchParams(req.url.split('?')[1] || ''));
      res.redirect('/#settings?connection=success');
    } catch (error) {
      const code = (error as { code?: string }).code || 'AUTH_CALLBACK_FAILED';
      res.redirect('/#settings?connection=error&code=' + encodeURIComponent(code));
    }
  });
  app.get('/api/models', async (_req, res) => res.json(await model.listModels()));
  app.put('/api/models', async (req, res) => {
    const { model: selection } = z.object({ model: z.string().min(1).max(200) }).parse(req.body);
    await model.setModel(selection); res.json({ selected: model.selectedModel });
  });
  app.get('/api/runtime', (_req, res) => res.json({
    dataDir: config.dataDir, database: config.dbPath, credentialDir: config.credentialDir,
    backups: resolve(config.dataDir, 'backups'), localRequests: limiter.usage(),
    planUsageAvailable: false, note: '本地请求计数是请求尝试次数，不表示 ChatGPT 套餐剩余额度。'
  }));
  let connectionTask: Promise<{ id: string }> | null = null;
  app.post('/api/connection-test', async (_req, res) => {
    if (!auth.status().planAuthorized) throw Object.assign(new Error('尚未获准使用 ChatGPT 套餐。请先完成登录及授权。'), { code: 'PLAN_PERMISSION_REQUIRED', status: 403 });
    if (!connectionTask) connectionTask = (async () => {
      await model.listModels();
      return learning.createExam({ level: 'N5', count: 1, types: ['single'], category: 'word', focus: '基础日语词义', mode: 'practice', source: 'ai', basis: 'all' });
    })();
    try { const result = await connectionTask; res.json({ ...result, verified: true, message: '已获取可用模型、完成真实流式调用，并将校验通过的一道题保存在 SQLite。' }); }
    finally { connectionTask = null; }
  });
  app.use('/api', createLearningRouter(learning, db, ()=>connectionTask!==null));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }));
  app.use(errorHandler);
  return { app, learning, limiter };
}
