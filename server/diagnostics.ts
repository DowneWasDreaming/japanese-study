import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const failureOperations=['generate','grade','annotation','review','explain','followup','models','connection','auth'] as const;
export const failureCategories=['network','upstream','validation','permission','quota','interrupted','local'] as const;
type Operation=typeof failureOperations[number];
type Category=typeof failureCategories[number];
const stamp=z.string().datetime();const identifier=z.string().min(1).max(200);
const optionalText=(max:number)=>z.string().max(max).nullable();
const status=z.number().int().min(100).max(599).nullable();
export const failureRowSchema=z.object({
  id:identifier,created_at:stamp,operation:z.enum(failureOperations),category:z.enum(failureCategories),
  code:z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/),message:z.string().min(1).max(3000),
  http_status:status,upstream_status:status,request_id:optionalText(300),upstream_message:optionalText(5000),detail:optionalText(8000),
  exam_id:identifier.nullable(),question_id:identifier.nullable(),conversation_id:identifier.nullable(),annotation_ids_json:z.string().max(20_000),model:optionalText(200),
  source:z.enum(['live','legacy','recovery']),stage:optionalText(200),network_code:optionalText(200),response_id:optionalText(300),
}).strict();
export type FailureRow=z.infer<typeof failureRowSchema>;
export interface FailureContext {operation:Operation;examId?:string|null;questionId?:string|null;conversationId?:string|null;annotationIds?:string[];model?:string|null;source?:FailureRow['source'];createdAt?:string;stage?:string;id?:string}

// Diagnostics contain structured errors only. Never serialize Error/cause/request/
// response objects: those can contain credentials, prompts and student answers.
export function redactFailureText(value:unknown,max:number):string|null {
  if(typeof value!=='string'||!value.trim())return null;
  return value.replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{15,}(?:\.[A-Za-z0-9_-]+){0,2})\b/g,'[凭据已隐藏]')
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|api[_-]?key|password|cookie|set-cookie)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}"']+)/gi,'$1[已隐藏]')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi,'$1?[已隐藏参数]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[邮箱已隐藏]')
    .slice(0,max);
}
const token=(value:unknown,max=200)=>typeof value==='string'&&/^[A-Za-z0-9_.:/-]+$/.test(value)?value.slice(0,max):null;
const numberStatus=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=100&&value<=599?value:null;
export function classifyFailure(code:string,upstreamStatus:number|null,networkCode:string|null):Category {
  if(networkCode||/NETWORK|TIMEOUT|FETCH_FAILED|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR/i.test(code))return 'network';
  if(/INCOMPLETE|INTERRUPTED|ABORTED|RECOVERY/i.test(code))return 'interrupted';
  if(/QUOTA|LIMIT_EXCEEDED|REQUEST_LIMIT|RATE_LIMIT|usage_limit|insufficient_quota/i.test(code)||upstreamStatus===429)return 'quota';
  if(/AUTH|PERMISSION|DENIED|eligible|TOKEN|OAUTH|invalid_grant|invalid_client|CHATGPT_NOT_CONNECTED/i.test(code)||upstreamStatus===401||upstreamStatus===403)return 'permission';
  if(/INVALID.*(?:OUTPUT|MODEL|ANNOTATION)|MODEL_(?:OUTPUT|STREAM|COMPLETION|CATALOG)_INVALID|MODEL_OUTPUT_TOO_LARGE|DUPLICATE_AI_QUESTION|ZOD|VALIDATION/i.test(code))return 'validation';
  return upstreamStatus?'upstream':'local';
}
export function validateFailureRecord(input:unknown):FailureRow {
  const row=failureRowSchema.parse(input);
  const ids=z.array(identifier).max(40).parse(JSON.parse(row.annotation_ids_json));
  if(new Set(ids).size!==ids.length)throw new Error('重复标记引用');
  if(row.question_id&&!row.exam_id)throw new Error('题目诊断缺少试卷');
  for(const key of ['message','upstream_message','detail'] as const)if(row[key]!==null&&redactFailureText(row[key],key==='message'?3000:key==='upstream_message'?5000:8000)!==row[key])throw new Error('诊断含未脱敏内容');
  for(const key of ['request_id','model','stage','network_code','response_id'] as const)if(row[key]!==null&&token(row[key],key==='request_id'||key==='response_id'?300:200)!==row[key])throw new Error('诊断标识字段无效');
  return row;
}
export function failureDto(row:FailureRow) {return {id:row.id,createdAt:row.created_at,operation:row.operation,category:row.category,code:row.code,message:row.message,httpStatus:row.http_status,upstreamStatus:row.upstream_status,requestId:row.request_id,upstreamMessage:row.upstream_message,detail:row.detail,examId:row.exam_id,questionId:row.question_id,conversationId:row.conversation_id,annotationIds:JSON.parse(row.annotation_ids_json) as string[],model:row.model,source:row.source,stage:row.stage,networkCode:row.network_code,responseId:row.response_id};}

export class FailureDiagnostics {
  constructor(private readonly db:DatabaseSync){this.importLegacy();}
  record(error:unknown,context:FailureContext) {
    try { return this.persist(error,context); }
    catch {
      // Reporting must never replace the original failure or leave grading pending.
      console.error('AI 失败诊断未能写入数据库；学习流程仍保留原始失败状态。');
      return null;
    }
  }
  private persist(error:unknown,context:FailureContext) {
    const value=(error&&typeof error==='object'?error:{}) as Record<string,unknown>;
    const diagnostics=(value.diagnostics&&typeof value.diagnostics==='object'?value.diagnostics:{}) as Record<string,unknown>;
    const isZod=error instanceof z.ZodError;
    const code=token(value.code)|| (isZod?'MODEL_OUTPUT_VALIDATION_FAILED':'REQUEST_FAILED');
    const upstreamStatus=numberStatus(diagnostics.upstreamStatus??value.upstreamStatus);
    const networkCode=token(diagnostics.networkCode??value.networkCode);
    const message=redactFailureText(value.publicMessage??(!isZod?value.message:undefined),3000)
      ||(isZod?'GPT 返回内容未通过结构校验，具体字段见诊断详情。':upstreamStatus?'GPT 服务返回错误，详见官方错误信息。':networkCode?'连接 GPT 服务失败，详见网络错误码。':'请求未完成，服务未提供可公开的进一步错误信息。');
    const validation=isZod?error.issues.map(issue=>`${issue.path.join('.')||'(根)'}: ${issue.code}${issue.code==='invalid_type'?`; expected ${String(issue.expected)}; received type ${String(issue.received)}`:issue.code==='too_small'?`; minimum ${String(issue.minimum)}; inclusive ${String(issue.inclusive)}; type ${issue.type}`:issue.code==='too_big'?`; maximum ${String(issue.maximum)}; inclusive ${String(issue.inclusive)}; type ${issue.type}`:issue.code==='unrecognized_keys'?'; 返回了约定之外的字段':issue.code==='invalid_enum_value'?'; 值不在允许的枚举中':issue.code==='custom'?'; 字段未通过约束检查':''}`).join('\n'):null;
    const extra=[validation,redactFailureText(diagnostics.detail??value.detail,6000),token(diagnostics.reason??value.reason)?`reason: ${token(diagnostics.reason??value.reason)}`:null,token(diagnostics.param??value.param)?`param: ${token(diagnostics.param??value.param)}`:null,redactFailureText(diagnostics.bodyShape??value.bodyShape,1000)].filter(Boolean).join('\n')||null;
    const row:FailureRow={id:context.id||randomUUID(),created_at:context.createdAt||new Date().toISOString(),operation:context.operation,category:classifyFailure(code,upstreamStatus,networkCode),code,message,http_status:numberStatus(value.status??value.statusCode),upstream_status:upstreamStatus,request_id:token(diagnostics.requestId??value.requestId,300),upstream_message:redactFailureText(diagnostics.upstreamMessage??value.upstreamMessage,5000),detail:redactFailureText(extra,8000),exam_id:context.examId||null,question_id:context.questionId||null,conversation_id:context.conversationId||null,annotation_ids_json:JSON.stringify(context.annotationIds||[]),model:token(context.model||diagnostics.model||value.model),source:context.source||'live',stage:token(context.stage??diagnostics.stage??value.stage),network_code:networkCode,response_id:token(diagnostics.responseId??value.responseId,300)};
    // A stale link must not hide the original error behind a foreign-key error.
    const exam=row.exam_id?this.db.prepare('SELECT questions_json FROM exams WHERE id=?').get(row.exam_id):null;
    if(!exam){row.exam_id=null;row.question_id=null;row.annotation_ids_json='[]';}
    else if(row.question_id&&!(JSON.parse(String(exam.questions_json)) as {id:string}[]).some(question=>question.id===row.question_id)){row.question_id=null;row.annotation_ids_json='[]';}
    if(row.conversation_id&&!this.db.prepare('SELECT id FROM conversations WHERE id=?').get(row.conversation_id))row.conversation_id=null;
    validateFailureRecord(row);
    const columns=Object.keys(failureRowSchema.shape) as (keyof FailureRow)[];
    this.db.prepare(`INSERT OR IGNORE INTO ai_failures(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>row[key]));
    return failureDto(row);
  }
  list(input:unknown={}) {
    const query=z.object({examId:identifier.optional(),operation:z.enum(failureOperations).optional(),category:z.enum(failureCategories).optional(),page:z.coerce.number().int().min(1).max(100_000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).strict().parse(input);
    const clauses:string[]=[];const params:string[]=[];
    for(const [key,column] of [['examId','exam_id'],['operation','operation'],['category','category']] as const)if(query[key]){clauses.push(`${column}=?`);params.push(query[key]);}
    const where=clauses.length?` WHERE ${clauses.join(' AND ')}`:'';
    const total=Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ai_failures${where}`).get(...params)!.count);
    const rows=this.db.prepare(`SELECT * FROM ai_failures${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params,query.pageSize,(query.page-1)*query.pageSize) as FailureRow[];
    return {items:rows.map(failureDto),total,page:query.page,pageSize:query.pageSize,pages:Math.max(1,Math.ceil(total/query.pageSize)),legacyNotice:'启用失败历史之前的逐次错误无法恢复；旧记录仅补录升级时仍保存的最后一次失败，未保存的 GPT 原始错误无法补造。'};
  }
  /** Deterministic IDs make import repeatable across startup and old-backup restore. */
  importLegacy() {
    for(const row of this.db.prepare("SELECT exam_id,question_id,error,updated_at FROM grades WHERE status='failed'").all()){
      this.legacy('grade',String(row.exam_id),String(row.question_id),String(row.error||'历史评分失败，原记录未保存原因。'),String(row.updated_at));
    }
    for(const row of this.db.prepare("SELECT id,exam_id,question_id,error,updated_at FROM exam_annotations WHERE status='failed'").all()){
      this.legacy('annotation',String(row.exam_id),String(row.question_id),String(row.error||'历史标记解析失败，原记录未保存原因。'),String(row.updated_at),[String(row.id)]);
    }
  }
  private legacy(operation:Operation,examId:string,questionId:string,message:string,createdAt:string,annotationIds:string[]=[]) {
    // A live/recovery record already represents this operation. It must not be
    // relabelled as an older failure every time the app starts.
    const prior=this.db.prepare('SELECT annotation_ids_json FROM ai_failures WHERE operation=? AND exam_id=? AND question_id=?').all(operation,examId,questionId);
    if(annotationIds.length?prior.some(row=>annotationIds.every(id=>(JSON.parse(String(row.annotation_ids_json)) as string[]).includes(id))):prior.length>0)return;
    const oldCode=message.match(/（([A-Za-z0-9_]{1,200})）\s*$/)?.[1]||(/达到本地请求次数限制/.test(message)?'LOCAL_REQUEST_LIMIT':'LEGACY_FAILURE');
    const id='legacy-'+createHash('sha256').update(JSON.stringify([operation,examId,questionId,annotationIds,createdAt])).digest('hex');
    this.record({code:oldCode,publicMessage:message,detail:'旧版最后失败快照；不是完整重试历史。GPT 原始错误、HTTP 状态及请求 ID 当时未保存。'},{id,operation,examId,questionId,annotationIds,source:'legacy',createdAt,stage:'legacy-import'});
  }
}
