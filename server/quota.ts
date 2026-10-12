import type { DatabaseSync } from 'node:sqlite';
export type ModelMessage = { role: 'user' | 'assistant' | 'developer'; content: string };
export interface Generator { generate(messages: ModelMessage[], model?: string): Promise<string> }
export class LimitedGenerator implements Generator {
  constructor(private db: DatabaseSync, private inner: Generator, readonly hourlyLimit = 30, readonly dailyLimit = 150) {
    if (![hourlyLimit, dailyLimit].every(x => Number.isInteger(x) && x >= 1)) throw new Error('模型请求限制必须为正整数');
    db.exec('CREATE TABLE IF NOT EXISTS local_ai_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL)');
  }
  usage() {
    const now = Date.now();
    const count = (since: number) => Number((this.db.prepare('SELECT count(*) AS count FROM local_ai_requests WHERE created_at >= ?').get(since) as { count: number }).count);
    return { hour: count(now - 3600000), day: count(now - 86400000), hourlyLimit: this.hourlyLimit, dailyLimit: this.dailyLimit, source: 'local_request_count' };
  }
  async generate(messages: ModelMessage[], model?: string) {
    const usage = this.usage();
    if (usage.hour >= this.hourlyLimit || usage.day >= this.dailyLimit) {
      throw Object.assign(new Error('已达到本地请求次数限制，请稍后再试。此限制不代表 ChatGPT 套餐剩余额度。'), { code: 'LOCAL_REQUEST_LIMIT', status: 429 });
    }
    this.db.prepare('INSERT INTO local_ai_requests (created_at) VALUES (?)').run(Date.now());
    return this.inner.generate(messages, model);
  }
}
