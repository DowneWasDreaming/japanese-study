import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { ModelService } from '../server/model.js';
import { createApplication } from '../server/app.js';

test('desktop shutdown requires origin and private token, which health never exposes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-desktop-'));
  const dbPath = join(directory, 'data', 'study.sqlite');
  const db = openDatabase(dbPath);
  const auth = new AuthManager({ credentialDir: join(directory, 'credentials') });
  const holder = express(); const server = holder.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const { port } = server.address() as { port: number }; const origin = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString('hex'); const instance = randomUUID(); let stops = 0;
  const config = { port, origin, host: '127.0.0.1', dataDir: join(directory, 'data'), dbPath, credentialDir: join(directory, 'credentials') };
  holder.use(createApplication(config, db, auth, new ModelService(auth), { instance, token, stop: async () => { stops++; } }).app);
  try {
    const health = await (await fetch(origin + '/api/health')).json();
    assert.equal(health.desktopInstance, instance); assert.equal(health.app, 'komorebi-japanese-study');
    assert.equal(JSON.stringify(health).includes(token), false);
    const request = (headers: Record<string, string>) => fetch(origin + '/api/desktop/stop', { method: 'POST', headers });
    assert.equal((await request({ 'X-Study-Control': token })).status, 403);
    const boundary = { Origin: origin, 'X-Study-Client': 'local-web' };
    assert.equal((await request(boundary)).status, 403);
    assert.equal((await request({ ...boundary, 'X-Study-Control': token + '0' })).status, 403);
    assert.equal(stops, 0);
    assert.equal((await request({ ...boundary, 'X-Study-Control': token })).status, 200);
    await new Promise<void>(done => setImmediate(done)); assert.equal(stops, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
