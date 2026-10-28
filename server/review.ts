import type { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from './db.js';
import type { AIProvider } from './learning.js';
import type { Question } from './seed.js';
import { validateAnnotationAnchor } from './annotations.js';
import { FailureDiagnostics,redactFailureText } from './diagnostics.js';
import { assessmentSchema,parseVerification,reviewFingerprint,selectExistingUsages,verificationInstructions,type Verification } from './review-verification.js';

const id=z.string().min(1).max(200),stamp=z.string().datetime(),level=z.enum(['KANA','N5','N4','N3','N2','N1']);
const kind=z.enum(['word','grammar','expression']),scope=z.enum(['broad','context']);
const text=(max:number)=>z.string().max(max);const required=(max:number)=>z.string().min(1).max(max).refine(value=>!!value.trim(),'内容不得为空');
const clean=(max:number)=>z.string().trim().min(1).max(max);
const editable={title:clean(200),kind,reading:text(200).default(''),meaning:text(2000).default(''),focus:clean(1200),note:text(4000).default('')};
export const reviewCandidateSchema=z.object({...editable,reading:text(200),meaning:required(2000),note:text(4000)}).strict();
export const checkedReviewCandidateSchema=reviewCandidateSchema.extend({usageKey:clean(200),assessment:assessmentSchema}).strict();
export const reviewPointRowSchema=z.object({
  id,title:required(200),kind,level,scope,focus:required(1200),reading:text(200),meaning:text(2000),note:text(4000),
  status:z.enum(['draft','active','mastered','paused']),stage:z.number().int().min(0).max(7),due_at:stamp.nullable(),last_reviewed_at:stamp.nullable(),
  repetitions:z.number().int().min(0).max(1_000_000),lapses:z.number().int().min(0).max(1_000_000),
  normalization_status:z.enum(['none','pending','completed','failed']),candidate_json:text(20_000).nullable(),error:required(2000).nullable(),canonical_key:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  created_at:stamp,updated_at:stamp,
  usage_key:text(200).default(''),verification_json:text(20_000).nullable().default(null),merged_into:id.nullable().default(null),
}).strict();
export const reviewSourceRowSchema=z.object({
  id,point_id:id,exam_id:id.nullable(),question_id:id.nullable(),source:z.enum(['prompt','passage','option','manual']),option_id:text(200),
  start_offset:z.number().int().min(0).max(30_000),end_offset:z.number().int().min(1).max(30_000),text:required(4000),context:required(30_000),question_prompt:text(20_000),created_at:stamp,
}).strict();
export const reviewEventRowSchema=z.object({
  id,point_id:id,exam_id:id.nullable(),rating:z.enum(['again','hard','good','mastered']),request_id:z.string().uuid(),reviewed_at:stamp,
  previous_stage:z.number().int().min(0).max(7),stage:z.number().int().min(0).max(7),previous_status:z.enum(['active','mastered']),status:z.enum(['active','mastered']),due_at:stamp.nullable(),
}).strict();
type PointRow=z.infer<typeof reviewPointRowSchema>;type SourceRow=z.infer<typeof reviewSourceRowSchema>;type EventRow=z.infer<typeof reviewEventRowSchema>;
const addSchema=z.object({examId:id.optional(),questionId:id.optional(),source:z.enum(['prompt','passage','option','manual']).optional(),optionId:id.optional(),start:z.number().int().min(0).optional(),end:z.number().int().min(1).optional(),text:required(500),scope:scope.default('broad'),intent:text(1200).optional(),level:level.optional()}).strict();
const confirmSchema=z.object({...editable,scope:scope.optional(),level:level.optional()}).strict();
const updateSchema=z.object({title:editable.title.optional(),kind:kind.optional(),reading:text(200).optional(),meaning:text(2000).optional(),focus:editable.focus.optional(),note:text(4000).optional(),scope:scope.optional(),level:level.optional(),status:z.enum(['active','paused','mastered']).optional()}).strict().refine(value=>Object.keys(value).length>0);
const ratingSchema=z.object({rating:z.enum(['again','hard','good','mastered']),requestId:z.string().uuid(),examId:id.optional()}).strict();
const keyFor=(point:Pick<PointRow,'title'|'kind'|'scope'|'usage_key'>)=>createHash('sha256').update(JSON.stringify([point.kind,point.title.normalize('NFC').trim(),point.scope,...(point.usage_key?[point.usage_key.normalize('NFC').trim()]:[])])).digest('hex');
const sourceKey=(row:SourceRow)=>JSON.stringify([row.exam_id,row.question_id,row.source,row.option_id,row.start_offset,row.end_offset,row.text,row.context]);
const sameDay=(a:string,b:string)=>new Date(Date.parse(a)+8*3600_000).toISOString().slice(0,10)===new Date(Date.parse(b)+8*3600_000).toISOString().slice(0,10);
class ReviewError extends Error {constructor(message:string,public code='REVIEW_ERROR',public status=400){super(message);}}
export interface ReviewBatchStatus {
  kind:'normalize'|'audit';uncertain:number;force?:boolean;
  id:string;status:'running'|'stopping'|'completed'|'stopped';startedAt:string;finishedAt:string|null;
  total:number;processed:number;succeeded:number;failed:number;current:{id:string;title:string}|null;
  items:{id:string;title:string;status:'queued'|'running'|'completed'|'uncertain'|'failed'|'skipped';error:string|null}[];
  stopReason:string|null;
}
function validPoint(input:unknown):PointRow {
  const point=reviewPointRowSchema.parse(input);
  if(point.title!==point.title.trim()||point.focus!==point.focus.trim()||point.lapses>point.repetitions)throw new ReviewError('复习知识点字段不一致。','INVALID_REVIEW_RECORD');
  if(point.status==='draft'){
    if(point.canonical_key!==null||point.stage!==0||point.due_at!==null||point.repetitions!==0||point.lapses!==0||point.last_reviewed_at!==null)throw new ReviewError('待整理知识点不应已有复习进度。','INVALID_REVIEW_RECORD');
  }else{
    if(point.canonical_key!==(point.merged_into?null:keyFor(point)))throw new ReviewError('复习知识点的规范标识不一致。','INVALID_REVIEW_RECORD');
    if(point.normalization_status==='completed'||point.candidate_json!==null)throw new ReviewError('已加入的知识点不应保留旧候选。','INVALID_REVIEW_RECORD');
    if(point.status==='active'&&(point.due_at===null||point.stage===7)||point.status!=='active'&&point.due_at!==null||point.status==='mastered'&&point.stage!==7)throw new ReviewError('复习状态与下次日期不一致。','INVALID_REVIEW_RECORD');
  }
  if((point.repetitions===0)!==(point.last_reviewed_at===null))throw new ReviewError('复习次数与上次日期不一致。','INVALID_REVIEW_RECORD');
  if(point.normalization_status==='completed'){
    if(point.candidate_json===null||point.error!==null)throw new ReviewError('知识点候选结果不完整。','INVALID_REVIEW_RECORD');
    reviewCandidateSchema.parse(JSON.parse(point.candidate_json));
  }else if(point.candidate_json!==null||point.normalization_status==='failed'&&point.error===null||point.normalization_status!=='failed'&&point.error!==null)throw new ReviewError('知识点整理状态不一致。','INVALID_REVIEW_RECORD');
  if(point.error!==null&&redactFailureText(point.error,2000)!==point.error)throw new ReviewError('复习错误原因含未脱敏内容。','INVALID_REVIEW_RECORD');
  if(point.verification_json!==null){const verification=parseVerification(point.verification_json)!;if(verification.outcome!=='uncertain'&&!point.usage_key)throw new ReviewError('已核查知识点缺少用法标识。','INVALID_REVIEW_RECORD');}
  if(point.merged_into&&(point.status==='draft'||point.merged_into===point.id))throw new ReviewError('复习合并引用不合法。','INVALID_REVIEW_RECORD');
  return point;
}
function validSource(input:unknown,questions?:Question[]):SourceRow {
  const row=reviewSourceRowSchema.parse(input);
  const wellFormed=(value:string)=>{for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code>=0xd800&&code<=0xdbff){const low=value.charCodeAt(++index);if(!(low>=0xdc00&&low<=0xdfff))return false;}else if(code>=0xdc00&&code<=0xdfff)return false;}return true;};
  if(row.end_offset<=row.start_offset||row.end_offset-row.start_offset!==row.text.length||row.context.slice(row.start_offset,row.end_offset)!==row.text||!wellFormed(row.text)||!wellFormed(row.context))throw new ReviewError('复习标记与原文位置不一致。','INVALID_REVIEW_SOURCE');
  if(row.source==='manual'){
    if(row.exam_id!==null||row.question_id!==null||row.option_id||row.start_offset!==0||row.end_offset!==row.text.length||row.context!==row.text||row.question_prompt!=='')throw new ReviewError('手动复习来源字段不一致。','INVALID_REVIEW_SOURCE');
  }else{
    if(!row.question_id||row.source!=='option'&&row.option_id!==''||row.source==='option'&&!row.option_id)throw new ReviewError('复习来源缺少题目或选项。','INVALID_REVIEW_SOURCE');
    if(questions){
      validateAnnotationAnchor({...row,question_id:row.question_id},questions);
      const q=questions.find(question=>question.id===row.question_id)!;
      const context=row.source==='prompt'?q.prompt:row.source==='passage'?q.passage:q.options?.find(option=>option.id===row.option_id)?.text;
      if(row.context!==context||row.question_prompt!==q.prompt)throw new ReviewError('复习原文快照与试卷不一致。','INVALID_REVIEW_SOURCE');
    }
  }
  return row;
}
function validEvent(input:unknown):EventRow {
  const event=reviewEventRowSchema.parse(input);
  if(event.status==='mastered'&&(event.stage!==7||event.due_at!==null)||event.status==='active'&&(event.stage===7||event.due_at===null)||event.previous_status==='mastered'&&event.previous_stage!==7||event.previous_status==='active'&&event.previous_stage===7)throw new ReviewError('复习事件状态与进度不一致。','INVALID_REVIEW_EVENT');
  return event;
}
/** Validate imported rows before destructive restoration begins. Orphaned paper
 * references are allowed only after ON DELETE SET NULL kept the original text. */
export function validateReviewBackup(tables:{review_points:unknown[];review_sources:unknown[];review_events:unknown[]},exams?:Map<string,Question[]>) {
  const points=tables.review_points.map(validPoint),sources=tables.review_sources.map(row=>{
    const source=reviewSourceRowSchema.parse(row);if(source.exam_id&&exams&&!exams.has(source.exam_id))throw new ReviewError('复习来源的试卷不存在。','INVALID_REVIEW_SOURCE');
    return validSource(source,source.exam_id?exams?.get(source.exam_id):undefined);
  }),events=tables.review_events.map(validEvent);
  const ids=new Set(points.map(point=>point.id));const keys=points.filter(point=>point.canonical_key!==null).map(point=>point.canonical_key);
  if(new Set(keys).size!==keys.length)throw new ReviewError('复习知识点规范标识重复。','INVALID_REVIEW_RECORD');
  const resolveId=(id:string)=>{const seen=new Set<string>();let value=points.find(point=>point.id===id);while(value?.merged_into){if(seen.has(value.id)||!ids.has(value.merged_into))throw new ReviewError('复习合并引用不存在或形成循环。','INVALID_REVIEW_RECORD');seen.add(value.id);value=points.find(point=>point.id===value!.merged_into);}return value?.id;};
  for(const point of points)resolveId(point.id);
  for(const point of points){
    const report=parseVerification(point.verification_json);if(!report)continue;
    const related=sources.filter(source=>resolveId(source.point_id)===resolveId(point.id));
    const evidencePool=[point.note,...related.flatMap(source=>{const q=source.exam_id?exams?.get(source.exam_id)?.find(q=>q.id===source.question_id):undefined;return [source.context,source.question_prompt,q?.passage||'',q?.prompt||'',...(q?.options?.map(option=>option.text)||[])];})];
    if(report.evidence.some(quote=>!evidencePool.some(value=>value.includes(quote))))throw new ReviewError('知识点核查依据与保留原文不一致。','INVALID_REVIEW_RECORD');
  }
  for(const source of sources)if(!ids.has(source.point_id))throw new ReviewError('复习来源的知识点不存在。','INVALID_REVIEW_SOURCE');
  for(const point of points)if(!sources.some(source=>source.point_id===point.id))throw new ReviewError('复习知识点缺少原始来源。','INVALID_REVIEW_RECORD');
  const requests=new Set<string>();
  for(const event of events){
    const point=points.find(point=>point.id===event.point_id);if(!point||point.status==='draft')throw new ReviewError('复习事件的知识点不存在或尚未确认。','INVALID_REVIEW_EVENT');
    if(event.exam_id&&exams){const qs=exams.get(event.exam_id);if(!qs||!qs.some(q=>(q as Question&{reviewPointIds?:string[]}).reviewPointIds?.some(id=>resolveId(id)===resolveId(event.point_id))))throw new ReviewError('复习事件与试卷知识点不一致。','INVALID_REVIEW_EVENT');}
    const request=JSON.stringify([event.point_id,event.request_id]);if(requests.has(request))throw new ReviewError('重复的复习自评请求。','INVALID_REVIEW_EVENT');requests.add(request);
  }
  for(const point of points){
    const history=events.filter(event=>event.point_id===point.id);
    const latest=history.map(event=>event.reviewed_at).sort().at(-1)||null;
    if(point.repetitions!==history.length||point.lapses!==history.filter(event=>event.rating==='again').length||point.last_reviewed_at!==latest)throw new ReviewError('复习次数、遗忘次数或上次时间与事件记录不一致。','INVALID_REVIEW_EVENT');
  }
  return {review_points:points,review_sources:sources,review_events:events};
}

export class ReviewService {
  private flights=new Map<string,Promise<{item:ReturnType<ReviewService['get']>;merged?:boolean;stopBatchReason?:string}>>();
  private batch:ReviewBatchStatus|null=null;
  constructor(private readonly db:DatabaseSync,private readonly ai:AIProvider|undefined,private readonly options:{diagnostics:FailureDiagnostics;isBusy?:()=>boolean;now?:()=>Date}){this.recoverPending('上次知识点整理因应用退出中断，原始标记已保留，可重新整理。');}
  private now(){return(this.options.now?.()||new Date()).toISOString();}
  private batchRunning(){return this.batch?.status==='running'||this.batch?.status==='stopping';}
  isBusy(){return this.flights.size>0||this.batchRunning();}
  private guard(){if(this.isBusy()||this.options.isBusy?.())throw new ReviewError('有出题、评分、解析或知识点整理正在进行，请完成后再操作复习记录。','REVIEW_BUSY',409);}
  private row(pointId:string){const row=this.db.prepare('SELECT * FROM review_points WHERE id=?').get(pointId) as PointRow|undefined;if(!row)throw new ReviewError('找不到这个复习知识点。','NOT_FOUND',404);return row;}
  private sources(pointId:string){return this.db.prepare('SELECT * FROM review_sources WHERE point_id=? ORDER BY created_at,rowid').all(pointId) as SourceRow[];}
  private resolvePoint(pointId:string){let point=this.row(pointId);const seen=new Set<string>();while(point.merged_into){if(seen.has(point.id))throw new ReviewError('知识点合并引用形成循环。','INVALID_REVIEW_RECORD');seen.add(point.id);point=this.row(point.merged_into);}return point;}
  private members(pointId:string){return this.db.prepare('WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT p.id FROM review_points p JOIN family f ON p.merged_into=f.id) SELECT p.* FROM review_points p JOIN family f ON p.id=f.id').all(pointId) as PointRow[];}
  private allSources(pointId:string){return this.db.prepare('WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT p.id FROM review_points p JOIN family f ON p.merged_into=f.id) SELECT s.* FROM review_sources s JOIN family f ON s.point_id=f.id ORDER BY s.created_at,s.id').all(pointId) as SourceRow[];}
  private fingerprint(point:PointRow){return reviewFingerprint(point,this.allSources(point.id).map(({point_id,id,created_at,...source})=>source));}
  private uncertain(point:PointRow){return parseVerification(point.verification_json)?.outcome==='uncertain';}
  private canAuditPoint(point:PointRow){return !point.merged_into&&point.normalization_status!=='pending'&&!this.allSources(point.id).some(source=>source.exam_id&&!this.db.prepare('SELECT submitted_at FROM exams WHERE id=?').get(source.exam_id)?.submitted_at);}
  private auditCurrent(point:PointRow){const report=parseVerification(point.verification_json);return !!report&&report.fingerprint===this.fingerprint(point)&&point.normalization_status==='none';}
  private canNormalize(point:PointRow,sources:SourceRow[]){return point.status==='draft'&&point.normalization_status!=='pending'&&!sources.some(source=>source.exam_id&&!this.db.prepare('SELECT submitted_at FROM exams WHERE id=?').get(source.exam_id)?.submitted_at);}
  private weight(point:PointRow){if(point.status!=='active'||point.merged_into||this.uncertain(point))return 0;const overdue=Math.max(0,(Date.parse(this.now())-Date.parse(point.due_at!))/86400_000);return Math.round((100/(point.stage+1)+Math.min(overdue,30)*8+Math.min(point.lapses,100)*4)*100)/100;}
  get(pointId:string){const requested=this.row(pointId),point=this.resolvePoint(pointId),members=this.members(point.id),sources=this.allSources(point.id),verification=parseVerification(point.verification_json);return {id:point.id,title:point.title,kind:point.kind,level:point.level,scope:point.scope,focus:point.focus,reading:point.reading,meaning:point.meaning,note:point.note,status:point.status,stage:point.stage,dueAt:point.due_at,lastReviewedAt:members.map(item=>item.last_reviewed_at).filter((value):value is string=>value!==null).sort().at(-1)||null,repetitions:members.reduce((sum,item)=>sum+item.repetitions,0),lapses:members.reduce((sum,item)=>sum+item.lapses,0),normalizationStatus:point.normalization_status,candidate:point.candidate_json?reviewCandidateSchema.parse(JSON.parse(point.candidate_json)):null,error:point.error,createdAt:point.created_at,updatedAt:point.updated_at,weight:this.weight(point),canNormalize:this.canNormalize(point,sources),canAudit:this.canAuditPoint(point),usageKey:point.usage_key,verification,verificationCurrent:this.auditCurrent(point),mergedInto:requested.merged_into,sources:sources.map(source=>({id:source.id,examId:source.exam_id,questionId:source.question_id,source:source.source,optionId:source.option_id,start:source.start_offset,end:source.end_offset,text:source.text,context:source.context,questionPrompt:source.question_prompt}))};}
  list(input:unknown={}){
    const query=z.object({status:z.enum(['due','draft','active','mastered','paused','uncertain','all']).default('due'),level:level.optional(),q:text(200).optional(),page:z.coerce.number().int().min(1).max(100_000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(input);
    let rows=this.db.prepare('SELECT * FROM review_points WHERE merged_into IS NULL ORDER BY created_at DESC,rowid DESC').all() as PointRow[];
    if(query.level)rows=rows.filter(point=>point.level===query.level);
    if(query.q?.trim()){const needle=query.q.normalize('NFC').trim().toLowerCase();rows=rows.filter(point=>[point.title,point.focus,point.meaning,point.reading,point.note].some(value=>value.normalize('NFC').toLowerCase().includes(needle)));}
    const due=(point:PointRow)=>point.status==='active'&&!this.uncertain(point)&&point.due_at!<=this.now();
    const summary={total:rows.length,uncertain:rows.filter(point=>this.uncertain(point)).length,draft:rows.filter(point=>point.status==='draft'&&!this.uncertain(point)).length,active:rows.filter(point=>point.status==='active'&&!this.uncertain(point)).length,mastered:rows.filter(point=>point.status==='mastered'&&!this.uncertain(point)).length,paused:rows.filter(point=>point.status==='paused'&&!this.uncertain(point)).length,due:rows.filter(due).length};
    const filtered=rows.filter(point=>query.status==='all'||(query.status==='uncertain'?this.uncertain(point):!this.uncertain(point)&&(query.status==='due'?due(point):point.status===query.status)));
    filtered.sort((a,b)=>this.weight(b)-this.weight(a)||a.created_at.localeCompare(b.created_at));
    const total=filtered.length;return {items:filtered.slice((query.page-1)*query.pageSize,query.page*query.pageSize).map(point=>this.get(point.id)),summary,total,page:query.page,pageSize:query.pageSize,pages:Math.max(1,Math.ceil(total/query.pageSize))};
  }
  private batchDrafts(){return (this.db.prepare("SELECT * FROM review_points WHERE status='draft' AND merged_into IS NULL ORDER BY created_at,rowid").all() as PointRow[]).filter(point=>!this.uncertain(point));}
  private batchEligible(point:PointRow){return this.canNormalize(point,this.sources(point.id));}
  batchOverview(){
    const drafts=this.batchDrafts();return {batch:this.batch?structuredClone(this.batch):null,totalDraftCount:drafts.length,
      eligibleCount:drafts.filter(point=>this.batchEligible(point)).length,
      completedCount:drafts.filter(point=>point.normalization_status==='completed'&&this.batchEligible(point)).length,
      blockedCount:drafts.filter(point=>point.normalization_status!=='pending'&&!this.canNormalize(point,this.sources(point.id))).length};
  }
  auditOverview(){const points=this.db.prepare('SELECT * FROM review_points WHERE merged_into IS NULL ORDER BY created_at,rowid').all() as PointRow[];return {batch:this.batch?structuredClone(this.batch):null,totalCount:points.length,eligibleCount:points.filter(point=>this.canAuditPoint(point)&&!this.auditCurrent(point)).length,checkedCount:points.filter(point=>this.auditCurrent(point)).length,blockedCount:points.filter(point=>!this.canAuditPoint(point)).length};}
  startAuditBatch(input:unknown){const data=z.object({force:z.boolean().optional()}).strict().parse(input);if(this.batchRunning())return {batch:structuredClone(this.batch!)};this.guard();const points=(this.db.prepare('SELECT * FROM review_points WHERE merged_into IS NULL ORDER BY created_at,rowid').all() as PointRow[]).filter(point=>this.canAuditPoint(point)&&(data.force||!this.auditCurrent(point)));if(!points.length)throw new ReviewError('没有需要核查的新内容；已核查且未修改的知识点会跳过。','NO_REVIEW_AUDIT_PENDING');return this.launchBatch(points,'audit',Boolean(data.force));}
  startBatch(input:unknown){
    const data=z.object({cachedOnly:z.boolean().optional()}).strict().parse(input);
    if(this.batchRunning())return {batch:structuredClone(this.batch!)};
    this.guard();const points=this.batchDrafts().filter(point=>this.batchEligible(point)&&(!data.cachedOnly||point.normalization_status==='completed'));
    if(!points.length)throw new ReviewError('没有可整理并加入复习的项目。已加入的知识点会保留；来自未交卷题目的标记，请先交卷。','NO_REVIEW_NORMALIZATION_PENDING');
    return this.launchBatch(points,'normalize');
  }
  private launchBatch(points:PointRow[],kind:'normalize'|'audit',force=false){
    const batch:ReviewBatchStatus={id:randomUUID(),kind,force,uncertain:0,status:'running',startedAt:this.now(),finishedAt:null,total:points.length,processed:0,succeeded:0,failed:0,current:null,items:points.map(point=>({id:point.id,title:point.title,status:'queued',error:null})),stopReason:null};
    this.batch=batch;
    // The job belongs to the server, so a refreshed/disconnected page does not
    // cancel it. Each point is saved before the next model request begins.
    void Promise.resolve().then(()=>this.runBatch(batch)).catch(error=>{
      const reason=redactFailureText((error as {message?:unknown})?.message,1750)||'批量整理因本机错误停止，已完成的建议已保留。';
      this.options.diagnostics.record(error,{operation:'review',stage:'review-batch'});
      this.finishBatch(batch,reason);
    });
    return {batch:structuredClone(batch)};
  }
  stopBatch(jobId:string,input:unknown){
    z.object({}).strict().parse(input);
    if(!this.batch||this.batch.id!==jobId)throw new ReviewError('找不到这个批量整理任务，请刷新进度。','REVIEW_BATCH_NOT_FOUND',404);
    if(this.batch.status==='running'){this.batch.status='stopping';this.batch.stopReason='已停止后续整理，当前知识点完成后保留结果。';}
    return {batch:structuredClone(this.batch)};
  }
  private finishBatch(batch:ReviewBatchStatus,reason:string|null){
    for(const item of batch.items){
      if(item.status==='queued'){item.status='skipped';item.error=reason;}
      else if(item.status==='running'){item.status='failed';item.error=reason||'本次整理未完成，请查看失败记录。';batch.failed++;batch.processed++;}
    }
    batch.status=reason?'stopped':'completed';batch.stopReason=reason;batch.current=null;batch.finishedAt=this.now();
  }
  private async runBatch(batch:ReviewBatchStatus){
    for(const item of batch.items){
      if(batch.status==='stopping'){this.finishBatch(batch,batch.stopReason||'已停止后续整理。');return;}
      item.status='running';batch.current={id:item.id,title:item.title};
      const point=this.row(item.id);if(point.merged_into||batch.kind==='audit'&&!batch.force&&this.auditCurrent(point)){item.status='skipped';item.error='已合并或内容已核查，无需重复请求。';batch.processed++;batch.current=null;continue;}
      const result=await this.normalizePoint(item.id,batch.id,batch.kind==='audit');
      if(result.item.normalizationStatus==='failed'){item.status='failed';item.error=result.item.error;batch.failed++;}
      else if(result.item.verification?.outcome==='uncertain'){item.status='uncertain';item.title=result.item.title;item.error=result.item.verification.reason;batch.uncertain++;}
      else if(result.item.status!=='draft'){item.status='completed';item.title=result.item.title;batch.succeeded++;}
      else{item.status='failed';item.error=result.item.error||'本次整理未完成，请查看失败记录。';batch.failed++;}
      batch.processed++;batch.current=null;
      if(result.stopBatchReason){this.finishBatch(batch,'后续整理已暂停：'+result.stopBatchReason);return;}
    }
    this.finishBatch(batch,batch.status==='stopping'?batch.stopReason:null);
  }
  add(input:unknown){
    this.guard();const data=addSchema.parse(input),now=this.now();
    let source:SourceRow;let pointLevel=data.level||'N5';
    if(data.examId){
      const exam=this.db.prepare('SELECT questions_json,level FROM exams WHERE id=?').get(data.examId);if(!exam)throw new ReviewError('找不到来源试卷。','NOT_FOUND',404);
      if(!data.questionId||!data.source||data.source==='manual'||data.start===undefined||data.end===undefined)throw new ReviewError('请提供完整的题目原文标记。','INVALID_REVIEW_SOURCE');
      const questions=JSON.parse(String(exam.questions_json)) as Question[];const anchor=validateAnnotationAnchor({question_id:data.questionId,source:data.source,option_id:data.optionId||'',start_offset:data.start,end_offset:data.end,text:data.text},questions);
      const q=questions.find(q=>q.id===data.questionId)!;pointLevel=level.parse(exam.level);
      const context=anchor.source==='prompt'?q.prompt:anchor.source==='passage'?q.passage!:q.options!.find(option=>option.id===anchor.option_id)!.text;
      source={id:randomUUID(),point_id:'new',exam_id:data.examId,question_id:data.questionId,source:data.source,option_id:data.optionId||'',start_offset:data.start,end_offset:data.end,text:data.text,context,question_prompt:q.prompt,created_at:now};
    }else{
      if(data.questionId||data.source&&data.source!=='manual'||data.optionId||data.start!==undefined||data.end!==undefined)throw new ReviewError('手动知识点不应携带题目位置。','INVALID_REVIEW_SOURCE');
      const raw=data.text.trim();source={id:randomUUID(),point_id:'new',exam_id:null,question_id:null,source:'manual',option_id:'',start_offset:0,end_offset:raw.length,text:raw,context:raw,question_prompt:'',created_at:now};
    }
    validSource(source);
    const existing=(this.db.prepare('SELECT s.*,p.scope AS point_scope FROM review_sources s JOIN review_points p ON p.id=s.point_id').all() as (SourceRow&{point_scope:string})[]).find(row=>row.point_scope===data.scope&&sourceKey(row)===sourceKey(source));
    if(existing)return {item:this.get(existing.point_id),created:false};
    const pointId=randomUUID();let title=source.text.trim().slice(0,200);if(/[\uD800-\uDBFF]$/.test(title))title=title.slice(0,-1);
    const point:PointRow={id:pointId,title,kind:'word',level:pointLevel,scope:data.scope,focus:data.intent?.trim()||(data.scope==='broad'?'整体用法、常用搭配与易错点':'结合原句理解具体用法'),reading:'',meaning:'',note:'',status:'draft',stage:0,due_at:null,last_reviewed_at:null,repetitions:0,lapses:0,normalization_status:'none',candidate_json:null,error:null,canonical_key:null,created_at:now,updated_at:now,usage_key:'',verification_json:null,merged_into:null};
    validPoint(point);source.point_id=pointId;
    transaction(this.db,()=>{this.insert('review_points',point,reviewPointRowSchema);this.insert('review_sources',source,reviewSourceRowSchema);});
    return {item:this.get(pointId),created:true};
  }
  private insert(table:'review_points'|'review_sources'|'review_events',row:PointRow|SourceRow|EventRow,schema:z.AnyZodObject){const columns=Object.keys(schema.shape);this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(column=>(row as Record<string,unknown>)[column] as string|number|null));}
  private save(point:PointRow){validPoint(point);const columns=Object.keys(reviewPointRowSchema.shape).filter(column=>column!=='id');this.db.prepare(`UPDATE review_points SET ${columns.map(column=>column+'=?').join(',')} WHERE id=?`).run(...columns.map(column=>(point as Record<string,unknown>)[column] as string|number|null),point.id);}
  async normalize(pointId:string){
    if(this.batchRunning())throw new ReviewError('正在批量整理或核查，请等待完成或停止后再操作。','REVIEW_BUSY',409);
    return this.normalizePoint(pointId);
  }
  async audit(pointId:string,input:unknown={}){
    const data=z.object({force:z.boolean().optional()}).strict().parse(input);
    if(this.batchRunning())throw new ReviewError('正在批量整理或核查，请等待完成或停止后再操作。','REVIEW_BUSY',409);
    const point=this.resolvePoint(pointId);if(!data.force&&this.auditCurrent(point))return {item:this.get(point.id),merged:false,cached:true};
    return this.normalizePoint(point.id,undefined,true);
  }
  clarify(pointId:string,input:unknown){
    this.guard();const data=z.object({text:clean(3000)}).strict().parse(input),point=this.resolvePoint(pointId);
    const note=(point.note?point.note+'\n\n':'')+'补充原文或疑问：'+data.text;if(note.length>4000)throw new ReviewError('补充后笔记超过4000字，请先精简已有笔记。','REVIEW_NOTE_LIMIT');
    const source:SourceRow={id:randomUUID(),point_id:point.id,exam_id:null,question_id:null,source:'manual',option_id:'',start_offset:0,end_offset:data.text.length,text:data.text,context:data.text,question_prompt:'',created_at:this.now()};validSource(source);
    point.note=note;point.updated_at=this.now();transaction(this.db,()=>{this.save(point);this.insert('review_sources',source,reviewSourceRowSchema);});return {item:this.get(point.id)};
  }
  private sourcePayload(source:SourceRow){
    const exam=source.exam_id?this.db.prepare('SELECT questions_json,submitted_at FROM exams WHERE id=?').get(source.exam_id):undefined;
    const q=exam?.submitted_at?(JSON.parse(String(exam.questions_json)) as Question[]).find(q=>q.id===source.question_id):undefined;
    return {selectedText:source.text,source:source.source,context:source.context,questionPrompt:source.question_prompt,...(q?{question:{prompt:q.prompt,passage:q.passage,options:q.options,answer:q.answer,explanation:q.explanation,selectedOptionId:source.option_id||undefined,isCorrectOption:source.source==='option'?q.answer===source.option_id:undefined}}:{})};
  }
  private async normalizePoint(pointId:string,batchId?:string,audit=false):Promise<{item:ReturnType<ReviewService['get']>;merged?:boolean;stopBatchReason?:string}>{
    const original=this.resolvePoint(pointId);pointId=original.id;const previous=this.flights.get(pointId);if(previous)return previous;
    if(!batchId)this.guard();else if(this.batch?.id!==batchId||!this.batchRunning())throw new ReviewError('批量任务已停止，请重新开始。','REVIEW_BATCH_NOT_FOUND',409);
    if(original.status!=='draft'&&!audit)return {item:this.get(pointId),merged:false};
    if(!this.canAuditPoint(original))throw new ReviewError('原始标记已保存，请先交卷，再请 AI 整理或核查。','REVIEW_NOT_SUBMITTED',403);
    const sources=this.allSources(pointId),point={...original};
    const task=Promise.resolve().then(async()=>{
      let stopBatchReason:string|undefined;
      try{
        point.normalization_status='pending';point.candidate_json=null;point.error=null;point.updated_at=this.now();this.save(point);
        if(!this.ai)throw new ReviewError('请先连接 ChatGPT 并授权套餐后整理知识点。','PLAN_PERMISSION_REQUIRED',403);
        const source=sources.at(-1)!,examSource=sources.findLast(source=>source.exam_id);const model=examSource?.exam_id?JSON.parse(String(this.db.prepare('SELECT config_json FROM exams WHERE id=?').get(examSource.exam_id)!.config_json)).model:undefined;
        const contexts=sources.slice(-4).map(source=>this.sourcePayload(source));
        const neighbours=(this.db.prepare("SELECT * FROM review_points WHERE merged_into IS NULL AND usage_key<>'' AND id!=? ORDER BY updated_at DESC").all(pointId) as PointRow[]).filter(item=>!this.uncertain(item));
        const existingUsages=selectExistingUsages(neighbours,[point.title,...sources.slice(-4).map(source=>source.text)]);
        const payload={...this.sourcePayload(source),level:point.level,scope:point.scope,intent:point.focus,notes:point.note,sources:contexts,existingKnowledge:point.status==='draft'?null:{title:point.title,kind:point.kind,reading:point.reading,meaning:point.meaning,focus:point.focus,usageKey:point.usage_key},existingUsages};
        const output=await this.ai.generate([{role:'developer',content:verificationInstructions},{role:'user',content:JSON.stringify(payload)}],model);
        let raw:unknown;try{raw=JSON.parse(output.trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,''));}catch{throw new ReviewError('GPT 核查结果不是有效 JSON，原始内容已保留。','INVALID_REVIEW_OUTPUT',502);}
        const candidate=checkedReviewCandidateSchema.parse(raw);
        for(const field of [candidate.title,candidate.reading,candidate.meaning,candidate.focus,candidate.note,candidate.usageKey])if(field!==''&&redactFailureText(field,4000)!==field.trim())throw new ReviewError('GPT 核查结果含不安全内容，未更新知识点。','INVALID_REVIEW_OUTPUT',502);
        const evidencePool=[point.note,...contexts.flatMap(context=>[context.context,context.questionPrompt,context.question?.passage||'',context.question?.prompt||'',...(context.question?.options?.map(option=>option.text)||[])])];
        candidate.assessment.evidence=candidate.assessment.evidence.map(quote=>{if(evidencePool.some(value=>value.includes(quote)))return quote;const unquoted=quote.replace(/^[「『“\"]([\s\S]*)[」』”\"]$/,'$1');if(evidencePool.some(value=>value.includes(unquoted)))return unquoted;throw new ReviewError('AI 核查引用的证据不在原文中，未更新知识点。','INVALID_REVIEW_EVIDENCE',502);});
        if(candidate.assessment.outcome!=='uncertain'&&!candidate.assessment.evidence.length)throw new ReviewError('AI 未给出可核对的原文依据，未更新知识点。','INVALID_REVIEW_EVIDENCE',502);
        return this.applyChecked(original,candidate);
      }catch(error){
        const source=sources.at(-1)!;const failure=this.options.diagnostics.record(error,{operation:'review',examId:source.exam_id,questionId:source.question_id,stage:audit?'review-audit':'review-normalize'});
        const value=error&&typeof error==='object'?error as {publicMessage?:unknown;message?:unknown;code?:unknown;status?:unknown;diagnostics?:{upstreamStatus?:unknown}}:{};
        const reason=error instanceof z.ZodError?'GPT 核查字段、类型、长度或安全校验未通过，请查看失败记录。':redactFailureText(value.publicMessage??value.message,1750)||'AI 核查没有完成，请查看失败记录。';
        const code=typeof value.code==='string'&&/^[A-Za-z0-9_.:/-]{1,200}$/.test(value.code)?value.code:'';
        Object.assign(point,original);point.normalization_status='failed';point.candidate_json=null;point.error=reason+(code?'（'+code+'）':'');
        if(failure?.category==='quota'||failure?.category==='permission'||value.status===401||value.status===403||value.status===429||[401,403,429].includes(Number(value.diagnostics?.upstreamStatus))||/QUOTA|LIMIT_EXCEEDED|REQUEST_LIMIT|RATE_LIMIT|usage_limit|insufficient_quota|AUTH|PERMISSION|DENIED|eligible|TOKEN|OAUTH|invalid_grant|invalid_client|CHATGPT_NOT_CONNECTED|NOT_CONNECTED|subscription_sharing_user_unavailable|MODEL_UNAVAILABLE|MODEL_SETTINGS_INVALID/i.test(code))stopBatchReason=point.error;
      }
      point.updated_at=this.now();this.save(point);return {item:this.get(pointId),...(stopBatchReason?{stopBatchReason}:{})};
    });
    this.flights.set(pointId,task);try{return await task;}finally{if(this.flights.get(pointId)===task)this.flights.delete(pointId);}
  }
  private applyChecked(original:PointRow,candidate:z.infer<typeof checkedReviewCandidateSchema>){
    const {assessment,usageKey,...fields}=candidate,point={...original};
    const changedConcept=assessment.outcome!=='uncertain'&&original.status!=='draft'&&(original.kind!==candidate.kind||original.title!==candidate.title&&assessment.outcome==='corrected'||!!original.usage_key&&original.usage_key!==usageKey||!original.usage_key&&assessment.outcome==='corrected');
    const report:Verification={...assessment,checkedAt:this.now(),fingerprint:'0'.repeat(64),...(changedConcept?{progressReset:true}:{})};
    if(assessment.outcome==='uncertain'){
      point.normalization_status='none';point.candidate_json=null;point.error=null;point.updated_at=this.now();
      report.fingerprint=this.fingerprint(point);point.verification_json=JSON.stringify(report);this.save(point);return {item:this.get(point.id),merged:false};
    }
    Object.assign(point,fields);point.usage_key=usageKey;point.normalization_status='none';point.candidate_json=null;point.error=null;point.updated_at=this.now();
    if(original.status==='draft'){point.status='active';point.due_at=this.now();}
    else if(changedConcept){point.stage=0;point.status=original.status==='paused'?'paused':'active';point.due_at=point.status==='active'?this.now():null;}
    point.canonical_key=keyFor(point);
    const previous=this.db.prepare('SELECT * FROM review_points WHERE canonical_key=? AND id!=? AND merged_into IS NULL').get(point.canonical_key,point.id) as PointRow|undefined;
    if(previous){
      const targetUncertain=this.uncertain(previous);
      const target={...previous,...(targetUncertain?{}:fields),usage_key:usageKey,normalization_status:'none' as const,candidate_json:null,error:null,updated_at:this.now()};
      if(!targetUncertain&&!changedConcept&&point.stage>target.stage){target.stage=point.stage;target.status=point.status;target.due_at=point.due_at;}
      transaction(this.db,()=>{
        if(original.status==='draft'){
          const keys=new Set(this.allSources(target.id).map(sourceKey));for(const source of this.sources(point.id)){if(keys.has(sourceKey(source)))this.db.prepare('DELETE FROM review_sources WHERE id=?').run(source.id);else{this.db.prepare('UPDATE review_sources SET point_id=? WHERE id=?').run(target.id,source.id);keys.add(sourceKey(source));}}
          this.db.prepare('DELETE FROM review_points WHERE id=?').run(point.id);
        }else{point.merged_into=target.id;point.canonical_key=null;point.verification_json=JSON.stringify({...report,fingerprint:this.fingerprint(point)});this.save(point);}
        if(!targetUncertain){report.fingerprint=this.fingerprint(target);target.verification_json=JSON.stringify(report);}this.save(target);
      });return {item:this.get(target.id),merged:true};
    }
    report.fingerprint=this.fingerprint(point);point.verification_json=JSON.stringify(report);this.save(point);return {item:this.get(point.id),merged:false};
  }
  recoverPending(message:string){
    const reason=redactFailureText(message,2000)||'上次知识点整理中断，可重新整理。';
    for(const row of this.db.prepare("SELECT id FROM review_points WHERE normalization_status='pending'").all()){
      const source=this.sources(String(row.id)).at(-1);this.options.diagnostics.record({code:'REVIEW_INTERRUPTED',publicMessage:reason},{operation:'review',examId:source?.exam_id,questionId:source?.question_id,source:'recovery',stage:'review-pending-recovery'});
    }
    this.db.prepare("UPDATE review_points SET normalization_status='failed',candidate_json=NULL,error=?,updated_at=? WHERE normalization_status='pending'").run(reason,this.now());
  }
  confirm(pointId:string,input:unknown){
    this.guard();const data=confirmSchema.parse(input),point=this.row(pointId);if(point.status!=='draft')throw new ReviewError('这条知识点已经确认，请通过编辑修改。','REVIEW_ALREADY_CONFIRMED',409);
    if(this.uncertain(point))throw new ReviewError('这条知识点仍待核实，请补充原文后 AI 核查；不会仅凭手动确认加入出题。','REVIEW_UNCERTAIN',409);
    return this.activatePoint(point,data);
  }
  private activatePoint(original:PointRow,data:z.output<typeof confirmSchema>){
    // Do not mutate the captured draft until the complete result can be saved.
    const point={...original},pointId=point.id;
    Object.assign(point,data);point.canonical_key=keyFor(point);
    const previous=this.db.prepare('SELECT * FROM review_points WHERE canonical_key=? AND id!=?').get(point.canonical_key,pointId) as PointRow|undefined;
    if(previous){
      transaction(this.db,()=>{const keys=new Set(this.sources(previous.id).map(sourceKey));for(const source of this.sources(pointId)){if(keys.has(sourceKey(source)))this.db.prepare('DELETE FROM review_sources WHERE id=?').run(source.id);else{this.db.prepare('UPDATE review_sources SET point_id=? WHERE id=?').run(previous.id,source.id);keys.add(sourceKey(source));}}this.db.prepare('DELETE FROM review_points WHERE id=?').run(pointId);});
      return {item:this.get(previous.id),merged:true};
    }
    point.status='active';point.due_at=this.now();point.normalization_status='none';point.candidate_json=null;point.error=null;point.updated_at=this.now();this.save(point);return {item:this.get(pointId),merged:false};
  }
  update(pointId:string,input:unknown){
    this.guard();const data=updateSchema.parse(input),point=this.resolvePoint(pointId);if(point.status==='draft')throw new ReviewError('待整理或待核实内容请先补充原文，再 AI 核查。','REVIEW_NOT_CONFIRMED',409);
    if(this.uncertain(point)&&data.status&&data.status!=='paused')throw new ReviewError('待核实内容不能直接恢复复习或标为掌握，请先 AI 核查。','REVIEW_UNCERTAIN',409);
    const previousStatus=point.status;Object.assign(point,data);point.canonical_key=keyFor(point);
    if(this.db.prepare('SELECT id FROM review_points WHERE canonical_key=? AND id!=?').get(point.canonical_key,point.id))throw new ReviewError('已存在同名、同范围的知识点，请编辑已有记录。','REVIEW_DUPLICATE',409);
    if(data.status==='mastered'){point.stage=7;point.due_at=null;}else if(data.status==='paused'){point.due_at=null;}else if(data.status==='active'&&previousStatus!=='active'){point.stage=0;point.due_at=this.now();}
    point.updated_at=this.now();this.save(point);return {item:this.get(pointId)};
  }
  remove(pointId:string){this.guard();const point=this.resolvePoint(pointId);this.db.prepare('DELETE FROM review_points WHERE id=?').run(point.id);return {removed:true as const};}
  rate(pointId:string,input:unknown){
    this.guard();const data=ratingSchema.parse(input),point=this.resolvePoint(pointId);pointId=point.id;
    if(this.uncertain(point))throw new ReviewError('这条知识点仍待核实，暂不用于复习评分。','REVIEW_UNCERTAIN',409);
    const memberIds=this.members(point.id).map(point=>point.id);
    const previous=(this.db.prepare('SELECT * FROM review_events WHERE request_id=?').all(data.requestId) as EventRow[]).find(event=>memberIds.includes(event.point_id));
    if(previous){if(previous.rating!==data.rating||previous.exam_id!==(data.examId||null))throw new ReviewError('同一自评编号不能用于不同反馈。','REVIEW_IDEMPOTENCY_CONFLICT',409);return {item:this.get(pointId),event:previous,created:false};}
    if(point.status==='draft'||point.status==='paused')throw new ReviewError('请先整理或恢复这个知识点，再记录自评。','REVIEW_NOT_ACTIVE',409);
    if(data.examId){const exam=this.db.prepare('SELECT submitted_at,questions_json FROM exams WHERE id=?').get(data.examId);if(!exam||!exam.submitted_at||!(JSON.parse(String(exam.questions_json)) as (Question&{reviewPointIds?:string[]})[]).some(q=>q.reviewPointIds?.some(id=>memberIds.includes(id))))throw new ReviewError('请在关联的复习卷交卷后评价本知识点。','REVIEW_EXAM_NOT_SUBMITTED',403);}
    const now=this.now(),previousStage=point.stage,previousStatus=point.status;
    if(data.rating==='again'){point.stage=0;point.status='active';point.due_at=new Date(Date.parse(now)+10*60_000).toISOString();point.lapses++;}
    else if(data.rating==='hard'){point.stage=Math.max(0,point.stage-1);point.status='active';point.due_at=new Date(Date.parse(now)+86400_000).toISOString();}
    else if(data.rating==='mastered'){point.stage=7;point.status='mastered';point.due_at=null;}
    else{
      const lastGood=(this.db.prepare("SELECT point_id,reviewed_at FROM review_events WHERE rating='good' ORDER BY reviewed_at DESC,rowid DESC").all() as {point_id:string;reviewed_at:string}[]).find(event=>memberIds.includes(event.point_id));
      if(!lastGood||!sameDay(String(lastGood.reviewed_at),now)){point.stage=Math.min(7,point.stage+1);point.status=point.stage===7?'mastered':'active';point.due_at=point.stage===7?null:new Date(Date.parse(now)+[1,3,7,14,30,60][point.stage-1]*86400_000).toISOString();}
    }
    point.repetitions++;point.last_reviewed_at=now;point.updated_at=now;
    const event:EventRow={id:randomUUID(),point_id:pointId,exam_id:data.examId||null,rating:data.rating,request_id:data.requestId,reviewed_at:now,previous_stage:previousStage,stage:point.stage,previous_status:previousStatus,status:point.status,due_at:point.due_at};
    validEvent(event);transaction(this.db,()=>{this.save(point);this.insert('review_events',event,reviewEventRowSchema);});return {item:this.get(pointId),event,created:true};
  }
  choose(input:unknown){
    const data=z.object({level,count:z.number().int().min(1).max(40),ids:z.array(id).min(1).max(40).optional(),readingOnly:z.boolean().default(false)}).strict().parse(input);
    const hasKanjiReading=(point:Pick<PointRow,'title'|'kind'>)=>point.kind!=='grammar'&&/\p{Script=Han}/u.test(point.title);
    if(data.ids){if(new Set(data.ids).size!==data.ids.length||data.ids.length>data.count)throw new ReviewError('知识点不能重复，且数量不能超过题数。','INVALID_REVIEW_SELECTION');const points=data.ids.map(pointId=>this.get(pointId));if(new Set(points.map(point=>point.id)).size!==points.length)throw new ReviewError('所选知识点已合并，请只选择一次。','INVALID_REVIEW_SELECTION');if(points.some(point=>point.level!==data.level||!['active','mastered'].includes(point.status)||point.verification?.outcome==='uncertain'))throw new ReviewError('请选择同一等级中已加入复习的知识点；暂停、待整理和待核实项目不能出卷。','INVALID_REVIEW_SELECTION');if(data.readingOnly&&points.some(point=>!hasKanjiReading(point)))throw new ReviewError('汉字读音专练只支持名称含汉字的单词或表达，请取消语法和纯假名知识点，或改用综合复习。','INVALID_READING_REVIEW_SELECTION');return points;}
    const points=(this.db.prepare("SELECT * FROM review_points WHERE status='active' AND merged_into IS NULL AND level=? AND due_at<=?").all(data.level,this.now()) as PointRow[]).filter(point=>!this.uncertain(point)&&(!data.readingOnly||hasKanjiReading(point))).sort((a,b)=>this.weight(b)-this.weight(a)||a.due_at!.localeCompare(b.due_at!)||a.created_at.localeCompare(b.created_at));
    if(!points.length)throw new ReviewError(data.readingOnly?'这个等级暂时没有到期的含汉字单词或表达；可以手动选择这类知识点练读音，或改用综合复习。':'这个等级暂时没有到期知识点；可以手动选择已确认项目复习。','NO_DUE_REVIEW_POINTS');return points.slice(0,data.count).map(point=>this.get(point.id));
  }
}
