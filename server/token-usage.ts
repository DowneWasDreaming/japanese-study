import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export type TokenCounts = {
  inputTokens:number|null; outputTokens:number|null; totalTokens:number|null;
  cachedTokens:number|null; reasoningTokens:number|null;
};
export type TokenUsageEvent = TokenCounts & {
  id:string; occurredAt:string; model:string; responseId:string|null;
  status:'completed'|'failed'; usageState:'reported'|'unavailable';
};
const emptyCounts = ():TokenCounts => ({inputTokens:null,outputTokens:null,totalTokens:null,cachedTokens:null,reasoningTokens:null});
const safeCount = (value:unknown):value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const recordObject = (value:unknown):Record<string,unknown>|null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : null;

/** Only provider-reported counts are accepted; optional details are subsets. */
export function parseReportedTokenUsage(value:unknown):TokenCounts & {usageState:TokenUsageEvent['usageState']} {
  const usage = recordObject(value);
  if (!usage || !safeCount(usage.input_tokens) || !safeCount(usage.output_tokens) || !safeCount(usage.total_tokens) ||
    !Number.isSafeInteger(usage.input_tokens + usage.output_tokens) || usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    return {...emptyCounts(),usageState:'unavailable'};
  }
  const cached = recordObject(usage.input_tokens_details)?.cached_tokens;
  const reasoning = recordObject(usage.output_tokens_details)?.reasoning_tokens;
  return {usageState:'reported',inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,totalTokens:usage.total_tokens,
    cachedTokens:safeCount(cached) && cached <= usage.input_tokens ? cached : null,
    reasoningTokens:safeCount(reasoning) && reasoning <= usage.output_tokens ? reasoning : null};
}

const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const EventSchema = z.object({
  id:z.string().uuid(),occurredAt:z.string().datetime(),model:z.string().min(1).max(300),responseId:z.string().min(1).max(200).nullable(),
  status:z.enum(['completed','failed']),usageState:z.enum(['reported','unavailable']),
  inputTokens:CountSchema,outputTokens:CountSchema,totalTokens:CountSchema,cachedTokens:CountSchema,reasoningTokens:CountSchema,
}).strict().superRefine((event,ctx) => {
  if (event.usageState === 'unavailable') {
    if (Object.keys(emptyCounts()).some(key => event[key as keyof TokenCounts] !== null)) ctx.addIssue({code:'custom',message:'Unavailable usage cannot contain counts.'});
    return;
  }
  if (event.inputTokens === null || event.outputTokens === null || event.totalTokens === null ||
    !Number.isSafeInteger(event.inputTokens + event.outputTokens) || event.totalTokens !== event.inputTokens + event.outputTokens ||
    (event.cachedTokens !== null && event.cachedTokens > event.inputTokens) ||
    (event.reasoningTokens !== null && event.reasoningTokens > event.outputTokens)) ctx.addIssue({code:'custom',message:'Invalid reported usage.'});
});
const QuerySchema = z.object({period:z.enum(['day','week','all']).default('day'),page:z.coerce.number().int().min(1).max(1000000).default(1)}).strict();
type UsageRow = {id:string;created_at:string;model:string;response_id:string|null;status:TokenUsageEvent['status'];usage_state:TokenUsageEvent['usageState'];input_tokens:number|null;output_tokens:number|null;total_tokens:number|null;cached_tokens:number|null;reasoning_tokens:number|null};

/** Operational statistics live outside learning-data backups and deletion. */
export class TokenUsageService {
  constructor(private readonly db:DatabaseSync,private readonly options:{now?:()=>Date} = {}) {}

  /** Usage must never prevent a successful response or replace its original error. */
  record(value:TokenUsageEvent):boolean {
    try {
      const parsed = EventSchema.safeParse(value); if (!parsed.success) return false;
      const e = parsed.data;
      const result = this.db.prepare(`INSERT OR IGNORE INTO ai_token_usage
        (id,created_at,model,response_id,status,usage_state,input_tokens,output_tokens,total_tokens,cached_tokens,reasoning_tokens)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(e.id,new Date(e.occurredAt).toISOString(),e.model,e.responseId,e.status,e.usageState,e.inputTokens,e.outputTokens,e.totalTokens,e.cachedTokens,e.reasoningTokens);
      return Number(result.changes) > 0;
    } catch { return false; }
  }

  list(query:unknown = {}) {
    const {period,page} = QuerySchema.parse(query);
    const now = this.options.now?.() || new Date();
    // Asia/Shanghai uses UTC+8 throughout the supported study dates.
    const shifted = new Date(now.getTime() + 8*3600000);
    const midnight = Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate()) - 8*3600000;
    const start = period === 'all' ? null : new Date(midnight - (period === 'week' ? 6 : 0)*86400000).toISOString();
    const end = period === 'all' ? null : new Date(midnight + 86400000).toISOString();
    const where = start ? 'WHERE created_at >= ? AND created_at < ?' : '';
    const values = start ? [start,end!] : [];
    const row = this.db.prepare(`SELECT count(*) AS requests,
      count(CASE WHEN usage_state='reported' THEN 1 END) AS reported,
      count(CASE WHEN status='completed' THEN 1 END) AS completed,
      count(CASE WHEN status='failed' THEN 1 END) AS failed,
      sum(CAST(input_tokens AS REAL)) AS input_tokens,sum(CAST(output_tokens AS REAL)) AS output_tokens,sum(CAST(total_tokens AS REAL)) AS total_tokens,
      sum(CAST(cached_tokens AS REAL)) AS cached_tokens,sum(CAST(reasoning_tokens AS REAL)) AS reasoning_tokens FROM ai_token_usage ${where}`).get(...values) as Record<string,number|null>;
    const requests = Number(row.requests); const reportedRequests = Number(row.reported);
    const exactSum = (key:string) => row[key] !== null && Number.isSafeInteger(row[key]) ? row[key] : null;
    const summary = {requests,reportedRequests,unavailableRequests:requests-reportedRequests,completedRequests:Number(row.completed),failedRequests:Number(row.failed),
      inputTokens:exactSum('input_tokens'),outputTokens:exactSum('output_tokens'),totalTokens:exactSum('total_tokens'),cachedTokens:exactSum('cached_tokens'),reasoningTokens:exactSum('reasoning_tokens')};
    const rows = this.db.prepare(`SELECT * FROM ai_token_usage ${where} ORDER BY created_at DESC,rowid DESC LIMIT 20 OFFSET ?`).all(...values,(page-1)*20) as UsageRow[];
    const items = rows.map(row => ({id:row.id,createdAt:row.created_at,model:row.model,responseId:row.response_id,status:row.status,usageState:row.usage_state,
      inputTokens:row.input_tokens,outputTokens:row.output_tokens,totalTokens:row.total_tokens,cachedTokens:row.cached_tokens,reasoningTokens:row.reasoning_tokens}));
    const metadata = this.db.prepare("SELECT value FROM ai_token_usage_metadata WHERE key='collection_started_at'").get() as {value:string};
    return {period,timezone:'Asia/Shanghai',range:{start,end},collectionStartedAt:metadata.value,summary,items,page,pageSize:20,total:requests,pages:Math.max(1,Math.ceil(requests/20))};
  }
}
