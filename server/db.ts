import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function openDatabase(path: string = resolve('data', 'learning.sqlite')): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const migration = readFileSync(fileURLToPath(new URL('../migrations/001.sql', import.meta.url)), 'utf8');
  db.exec(migration);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?,?)').run(1, new Date().toISOString());
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
