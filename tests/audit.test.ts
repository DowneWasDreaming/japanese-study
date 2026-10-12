import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Git audit detects credentials in staged contents and retained commit history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-git-audit-'));
  const runner = resolve('node_modules/tsx/dist/cli.mjs');
  const script = resolve('scripts/audit-files.ts');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  const audit = () => spawnSync(process.execPath, [runner, script], { cwd: directory, encoding: 'utf8' });
  // Deliberately synthetic; never use a real credential in a fixture.
  const synthetic = 'sk-' + 'x'.repeat(30);
  try {
    git('init', '-b', 'main');
    writeFileSync(join(directory, 'example.txt'), synthetic);
    git('add', 'example.txt');
    writeFileSync(join(directory, 'example.txt'), 'working copy is safe');
    const staged = audit();
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, /暂存区/);
    assert.ok(!staged.stderr.includes(synthetic));
    git('-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic fixture');
    git('rm', '-f', 'example.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'remove fixture');
    const history = audit();
    assert.equal(history.status, 1);
    assert.match(history.stderr, /提交历史/);
    assert.ok(!history.stderr.includes(synthetic));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
