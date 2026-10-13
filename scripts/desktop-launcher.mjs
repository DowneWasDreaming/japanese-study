import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, closeSync, openSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer } from 'node:net';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex');
process.chdir(project);
const runtime = join(project, '.local', 'runtime');
const stateFile = join(runtime, 'desktop.json');
const action = process.argv[2];
const noBrowser = process.argv.includes('--no-browser');
const resultFile = process.argv.find(arg => arg.startsWith('--result-file='))?.slice(14);
const pause = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
async function readState() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); } catch { return null; }
}
async function health(origin) {
  try {
    const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
const ourApp = info => info?.ok === true && info.app === 'komorebi-japanese-study' && info.project === projectId;
const matching = (info, state) => ourApp(info) && info.desktopInstance === state.instance && info.pid === state.pid;
async function portOccupied(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); done(result); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(true));
  });
}

async function acquireLock() {
  const deadline = Date.now() + 120_000;
  // Windows releases the exclusive named pipe even if the helper crashes.
  // No stale PID file, partially written lock or cleanup race can block restart.
  const pipe = '\\\\.\\pipe\\komorebi-launcher-' + projectId;
  while (Date.now() < deadline) {
    const mutex = createServer(socket => socket.destroy());
    const result = await new Promise(done => {
      mutex.once('error', done);
      mutex.listen(pipe, () => done(null));
    });
    if (!result) return mutex;
    if (!['EADDRINUSE', 'EACCES'].includes(result.code)) throw result;
    await pause(300);
  }
  throw new Error('另一个启动或停止操作尚未结束，请稍后再双击。');
}
function runNode(args) {
  return new Promise((done, fail) => {
    const log = openSync(join(runtime, 'setup.log'), 'a');
    const child = spawn(process.execPath, args, { cwd: project, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, PATH: dirname(process.execPath) + ';' + (process.env.PATH || '') } });
    closeSync(log);
    child.once('error', fail);
    child.once('exit', code => code === 0 ? done() : fail(new Error('安装或构建失败。请查看 .local/runtime/setup.log，确认网络及 Node.js 环境后重新双击。')));
  });
}
function newestSource() {
  let latest = 0;
  const visit = path => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else latest = Math.max(latest, stat.mtimeMs);
  };
  for (const name of ['src', 'index.html', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json']) visit(join(project, name));
  return latest;
}
async function prepare() {
  if (!existsSync(join(project, 'node_modules', 'tsx', 'package.json'))) {
    const candidates = [
      join(dirname(process.execPath), '..', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
      join(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    const manager = candidates.find(existsSync);
    if (!manager) throw new Error('此目录缺少运行依赖，且没有找到包管理器。请安装包含 npm 的 Node.js 24 或更新版本，再双击启动。');
    await runNode([manager, 'install', ...(manager.includes('pnpm') ? ['--frozen-lockfile'] : [])]);
  }
  const page = join(project, 'dist', 'index.html');
  if (!existsSync(page) || statSync(page).mtimeMs < newestSource()) {
    await runNode([join(project, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
    await runNode([join(project, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
  }
}
async function openBrowser(origin) {
  if (noBrowser) return;
  // A fixed loopback URL is passed as an argument, never as shell source.
  await new Promise((done, fail) => {
    const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', origin], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', fail); child.once('spawn', () => { child.unref(); done(); });
  });
}
async function start() {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须是 1024 到 65535 之间的整数。');
  const origin = `http://127.0.0.1:${port}`;
  const info = await health(origin);
  if (ourApp(info)) { await openBrowser(origin); return { action: 'opened', origin, pid: info.pid }; }
  const previous = await readState();
  if (previous && alive(previous.pid)) {
    if (previous.origin !== origin) throw new Error('另一个端口上已有此目录启动的服务。请先双击停止，再使用新端口启动。');
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && alive(previous.pid)) {
      const ready = await health(origin);
      if (matching(ready, previous)) { await openBrowser(origin); return { action: 'opened', origin, pid: previous.pid }; }
      if (ready) throw new Error(`端口 ${port} 上的服务与启动记录不一致。请检查 .local/runtime/server.log。`);
      await pause(500);
    }
    if (alive(previous.pid)) throw new Error('网站仍在启动中。请稍后重新双击；没有重复启动或覆盖停止记录。');
  }
  if (info) throw new Error(`端口 ${port} 已被其他程序占用，请关闭占用程序后再双击启动。`);
  if (await portOccupied(port)) throw new Error(`端口 ${port} 已被其他程序占用，请关闭占用程序后再双击启动。`);
  await prepare();
  const state = { pid: 0, instance: randomUUID(), token: randomBytes(32).toString('hex'), origin };
  const log = openSync(join(runtime, 'server.log'), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--production', `--desktop-instance=${state.instance}`], {
    cwd: project, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, STUDY_DESKTOP_TOKEN: state.token }
  });
  closeSync(log);
  let failure;
  child.on('error', error => { failure = error; });
  await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  state.pid = child.pid;
  // Record ownership before readiness so a slow or failed launch is recoverable.
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  child.unref();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const ready = await health(origin);
    if (matching(ready, state)) { await openBrowser(origin); return { action: 'started', origin, pid: state.pid }; }
    if (ready && !matching(ready, state)) throw new Error(`端口 ${port} 已被其他程序占用，请关闭占用程序后再双击启动。`);
    if (failure || !alive(state.pid)) throw new Error('网站启动失败，可能是端口被占用或运行环境异常。请查看 .local/runtime/server.log。');
    await pause(250);
  }
  throw new Error('网站启动超过 45 秒。请稍后重新双击启动；运行日志在 .local/runtime/server.log。');
}
async function stop() {
  const state = await readState();
  if (!state) return { action: 'already-stopped' };
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(state.origin) || !/^[a-f0-9]{64}$/.test(state.token) || !/^[a-f0-9-]{36}$/.test(state.instance)) throw new Error('启动记录格式异常，请检查 .local/runtime/desktop.json。');
  let info = await health(state.origin);
  if (!matching(info, state) && alive(state.pid)) {
    // A launcher may still be recovering from a slow start; never kill by PID.
    for (let attempt = 0; attempt < 20 && !info; attempt++) { await pause(500); info = await health(state.origin); }
  }
  if (!matching(info, state)) {
    if (!info && !alive(state.pid)) { await unlink(stateFile); return { action: 'already-stopped' }; }
    throw new Error('当前端口上的程序与启动记录不一致，停止入口没有关闭它。请先检查运行记录。');
  }
  const response = await fetch(state.origin + '/api/desktop/stop', {
    method: 'POST', headers: { Origin: state.origin, 'X-Study-Client': 'local-web', 'X-Study-Control': state.token }, signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('服务未接受停止请求，请稍后重试。');
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!alive(state.pid)) { await unlink(stateFile); return { action: 'stopped' }; }
    await pause(250);
  }
  throw new Error('服务正在完成关闭，请稍后再双击停止。');
}

let mutex;
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本。安装完成后再双击启动。');
  if (process.platform !== 'win32') throw new Error('此双击启动器适用于 Windows。其他系统请使用 README 中的启动命令。');
  if (!['start', 'stop'].includes(action)) throw new Error('请选择启动或停止入口。');
  await mkdir(runtime, { recursive: true });
  mutex = await acquireLock();
  console.log(JSON.stringify(await (action === 'start' ? start() : stop())));
} catch (error) {
  const message = error instanceof Error ? error.message : '操作失败，请检查运行环境。';
  if (resultFile && dirname(resolve(resultFile)) === runtime) await writeFile(resultFile, message, 'utf8').catch(() => {});
  console.error(message); process.exitCode = 1;
} finally {
  if (mutex) await new Promise(done => mutex.close(done));
}
