import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function openDatabase(path: string = resolve('data', 'learning.sqlite')): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const [version, filename] of [[1, '001.sql'], [2, '002.sql'], [3, '003.sql'], [4, '004.sql'], [5, '005.sql'], [6, '006.sql'], [7, '007.sql']] as const) {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version)) continue;
    const migration = readFileSync(fileURLToPath(new URL(`../migrations/${filename}`, import.meta.url)), 'utf8');
    transaction(db, () => {
      db.exec(migration);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)').run(version, new Date().toISOString());
    });
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
