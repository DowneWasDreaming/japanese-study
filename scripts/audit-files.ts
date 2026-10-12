import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const git = (args: string[], input?: string) => execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 20 * 1024 * 1024 });
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
const forbidden = /(?:^|\/)(?:\.local|node_modules|dist|data|credentials|backups|exports|logs|cache)(?:\/|$)|\.(?:sqlite|db)(?:-|$)|\.(?:token|pem|key)$|(?:^|\/)\.env(?:$|\.(?!example$))|(?:^|\/)(?:auth(?:-[^/]*)?|profile[^/]*|token[^/]*|connections|model-selection|model-settings|host-id)\.json$/i;
const tokenPattern = /(?:sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{20,}|"(?:access_token|refresh_token|id_token|accessToken|refreshToken|idToken)"\s*:\s*"[A-Za-z0-9_.-]{24,}")/;
const errors: string[] = [];
const scanned = new Set<string>();
function inspect(path: string, source: string, contents: string) {
  if (forbidden.test(path)) errors.push(`${path} (${source}): 不应跟踪的本地文件`);
  if (tokenPattern.test(contents)) errors.push(`${path} (${source}): 疑似真实凭据，必须停止推送并处理 Git 历史`);
}
for (const file of files) {
  try { inspect(file, '工作目录', readFileSync(file, 'utf8')); } catch { /* deleted working file: still inspect its staged blob below */ }
}
// Check the index itself: editing a working file after staging does not remove a staged secret.
for (const record of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
  const entry = record.match(/^\d+ ([a-f0-9]+) \d+\t([\s\S]+)$/);
  if (!entry) continue;
  const [, hash, path] = entry;
  inspect(path, '暂存区', git(['cat-file', 'blob', hash]));
  scanned.add(hash);
}
// Inspect reachable committed blobs as well; an ignore rule cannot erase Git history.
const history = git(['rev-list', '--objects', '--all']).trim().split('\n').filter(Boolean)
  .map(line => line.match(/^([a-f0-9]+) (.+)$/)).filter((entry): entry is RegExpMatchArray => !!entry);
if (history.length) {
  const types = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], history.map(entry => entry[1]).join('\n') + '\n')
    .trim().split('\n');
  for (let i = 0; i < history.length; i++) {
    const [, hash, path] = history[i];
    if (!types[i]?.endsWith(' blob')) continue;
    if (forbidden.test(path)) errors.push(`${path} (提交历史): 不应跟踪的本地文件`);
    if (!scanned.has(hash)) {
      inspect(path, '提交历史', git(['cat-file', 'blob', hash]));
      scanned.add(hash);
    }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`检查通过：${files.length} 个已跟踪文件；工作目录、暂存区与 ${scanned.size} 个唯一 Git 内容均未发现被禁用的本地数据或疑似令牌。`);
