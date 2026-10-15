import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { localBoundary, errorHandler } from '../server/security.js';
import { DatabaseSync } from 'node:sqlite';
import { RequestCounter } from '../server/quota.js';
import { request } from 'node:http';
import { getConfig } from '../server/config.js';
test('learning and credential directories cannot overlap, including Windows case aliases', () => {
  const previousData = process.env.STUDY_DATA_DIR;
  const previousCredentials = process.env.STUDY_CREDENTIAL_DIR;
  try {
    process.env.STUDY_DATA_DIR = '.local/path-test/data';
    for (const credentials of ['.local/path-test/data', '.local/path-test/data/nested', '.local/path-test']) {
      process.env.STUDY_CREDENTIAL_DIR = credentials;
      assert.throws(getConfig, /凭据目录/);
    }
    if (process.platform === 'win32') {
      process.env.STUDY_CREDENTIAL_DIR = '.local/path-test/DATA';
      assert.throws(getConfig, /凭据目录/);
    }
    process.env.STUDY_CREDENTIAL_DIR = '.local/path-test/credentials';
    assert.equal(getConfig().host, '127.0.0.1');
  } finally {
    if (previousData === undefined) delete process.env.STUDY_DATA_DIR; else process.env.STUDY_DATA_DIR = previousData;
    if (previousCredentials === undefined) delete process.env.STUDY_CREDENTIAL_DIR; else process.env.STUDY_CREDENTIAL_DIR = previousCredentials;
  }
});
test('local host, origin and mutation header block external requests', async () => {
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  app.use(localBoundary(origin)); app.post('/api/example', (_req, res) => res.json({ ok: true }));
  try {
    assert.equal((await fetch(origin + '/api/example', { method: 'POST' })).status, 403);
    assert.equal((await fetch(origin + '/api/example', { method: 'POST', headers: { Origin: 'https://external.invalid', 'X-Study-Client': 'local-web' } })).status, 403);
    assert.equal((await fetch(origin + '/api/example', { method: 'POST', headers: { Origin: origin, 'X-Study-Client': 'local-web' } })).status, 200);
    const reboundStatus = await new Promise<number>(resolve => {
      const req = request(origin + '/api/example', { method: 'POST', headers: { Host: 'external.invalid', Origin: origin, 'X-Study-Client': 'local-web' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
    });
    assert.equal(reboundStatus, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('error response suppresses credentials', () => {
  let response: unknown;
  const res = { status() { return this; }, json(data: unknown) { response = data; } };
  errorHandler(new Error('Bearer secret access_token=private'), {} as never, res as never, () => {});
  assert.ok(!JSON.stringify(response).includes('secret'));
});
test('local request statistics persist but never block requests, including failed attempts', async () => {
  const db = new DatabaseSync(':memory:'); let calls = 0;
  const inner = { async generate() { calls++; if(calls===2)throw Object.assign(new Error('upstream test failure'),{code:'UPSTREAM_TEST'});return 'done'; } };
  const a = new RequestCounter(db, inner);
  await a.generate([{ role: 'user', content: 'こんにちは' }]);
  const b = new RequestCounter(db, inner);
  await assert.rejects(b.generate([{ role: 'user', content: 'again' }]), { code: 'UPSTREAM_TEST' });
  for(let i=0;i<160;i++)await b.generate([{ role:'user',content:'count only' }]);
  assert.equal(calls,162);assert.equal(b.usage().hour,162);
  assert.equal(b.usage().day,162);assert.equal(b.usage().limitEnabled,false);
  assert.equal(b.usage().hourlyLimit,null);assert.equal(b.usage().dailyLimit,null);db.close();
});
