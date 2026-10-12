import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { getConfig } from './config.js';
import { openDatabase } from './db.js';
import { seedDatabase } from './seed.js';
import { AuthManager } from './auth.js';
import { ModelService } from './model.js';
import { createApplication } from './app.js';

const config = getConfig();
const db = openDatabase(config.dbPath);
seedDatabase(db);
const auth = new AuthManager({ credentialDir: config.credentialDir, redirectUri: config.origin + '/auth/callback' });
try { await auth.init(); }
catch (error) {
  console.warn(`ChatGPT 连接暂不可用（${(error as { code?: string }).code || 'AUTH_INIT_FAILED'}），基础学习仍可使用。请在设置中查看错误。`);
}
const model = new ModelService(auth, { settingsFile: resolve(config.credentialDir, 'model-settings.json') });
const { app } = createApplication(config, db, auth, model);
const production = process.argv.includes('--production');
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if (production) {
  if (!existsSync(resolve('dist/index.html'))) throw new Error('请先运行 pnpm build，再启动生产服务。');
  app.use(express.static(resolve('dist'), { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(config.port, config.host, () => {
  console.log(`木漏れ日 · 日语学习室\nLocal: ${config.origin}\nSQLite: ${config.dbPath}\n${production ? '生产' : '开发'}模式。按 Ctrl+C 停止。`);
});
server.on('error', error => {
  console.error((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用。修改 PORT 后重启。` : '本地服务启动失败。');
  process.exitCode = 1;
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await vite?.close(); db.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
