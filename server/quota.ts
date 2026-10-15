import type { DatabaseSync } from 'node:sqlite';
export type ModelMessage = { role: 'user' | 'assistant' | 'developer'; content: string };
export interface Generator { generate(messages: ModelMessage[], model?: string): Promise<string> }
/** Local statistics only. Eligibility, allowance and rate limits are enforced by OpenAI. */
export class RequestCounter implements Generator {
  constructor(private db: DatabaseSync, private inner: Generator) {
    db.exec('CREATE TABLE IF NOT EXISTS local_ai_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL)');
  }
  usage() {
    const now = Date.now();
    const count = (since: number) => Number((this.db.prepare('SELECT count(*) AS count FROM local_ai_requests WHERE created_at >= ?').get(since) as { count: number }).count);
    return { hour: count(now - 3600000), day: count(now - 86400000), hourlyLimit: null, dailyLimit: null, limitEnabled: false, source: 'local_attempt_count' };
  }
  async generate(messages: ModelMessage[], model?: string) {
    this.db.prepare('INSERT INTO local_ai_requests (created_at) VALUES (?)').run(Date.now());
    return this.inner.generate(messages, model);
  }
}
