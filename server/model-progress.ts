import { z } from 'zod';

const instant = z.string().datetime();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/);
export const modelProgressEventTypes = [
  'response.created','response.queued','response.in_progress','response.output_item.added','response.output_item.done',
  'response.content_part.added','response.content_part.done','response.output_text.delta','response.output_text.done',
  'response.reasoning_summary_part.added','response.reasoning_summary_part.done','response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done','response.reasoning_text.delta','response.reasoning_text.done',
  'response.completed','response.failed','response.incomplete','error','keepalive',
] as const;
export const modelRequestProgressSchema = z.object({
  id:z.string().uuid(),model:safeId,state:z.enum(['waiting_headers','waiting_events','processing','receiving_text','completed','failed']),
  startedAt:instant,headersAt:instant.nullable(),firstByteAt:instant.nullable(),lastByteAt:instant.nullable(),
  firstEventAt:instant.nullable(),lastEventAt:instant.nullable(),firstTextAt:instant.nullable(),lastTextAt:instant.nullable(),endedAt:instant.nullable(),
  elapsedMs:count,sinceLastByteMs:count.nullable(),sinceLastEventMs:count.nullable(),sinceLastTextMs:count.nullable(),timeoutMs:count.positive(),
  responseTimeoutMs:count.positive().optional(),streamIdleTimeoutMs:count.positive().optional(),
  timeoutKind:z.enum(['response_timeout','stream_idle_timeout','total_timeout']).nullable().optional(),
  receivedBytes:count,eventCount:count,textCharacters:count,lastEventType:z.enum(modelProgressEventTypes).nullable(),
  httpStatus:z.number().int().min(100).max(599).nullable(),errorCode:safeId.nullable(),reason:safeId.nullable(),
}).strict();
export type ModelRequestProgress = z.infer<typeof modelRequestProgressSchema>;

const safeToken = (value:unknown) => typeof value==='string'&&/^[A-Za-z0-9_.:/-]{1,200}$/.test(value)?value:null;
/** Stores counters and timestamps only. No prompt, response text or reasoning is retained. */
export class ModelProgressTracker {
  private readonly records=new Map<string,{account:string|null,value:ModelRequestProgress,parts:Map<string,number>}>();
  start(id:string,model:string,account:string|null,timeoutMs:number,policy?:{responseTimeoutMs:number;streamIdleTimeoutMs:number}) {
    const value:ModelRequestProgress={id,model:safeToken(model)||'unknown-model',state:'waiting_headers',startedAt:new Date().toISOString(),
      headersAt:null,firstByteAt:null,lastByteAt:null,firstEventAt:null,lastEventAt:null,firstTextAt:null,lastTextAt:null,endedAt:null,
      elapsedMs:0,sinceLastByteMs:null,sinceLastEventMs:null,sinceLastTextMs:null,timeoutMs,receivedBytes:0,eventCount:0,textCharacters:0,
      lastEventType:null,httpStatus:null,errorCode:null,reason:null,...(policy?{...policy,timeoutKind:null}: {})};
    this.records.set(id,{account,value,parts:new Map()});this.prune();
  }
  headers(id:string,status:number) {const item=this.records.get(id);if(!item)return;item.value.headersAt=new Date().toISOString();item.value.httpStatus=status;item.value.state='waiting_events';}
  bytes(id:string,length:number) {const item=this.records.get(id);if(!item||length<=0)return;const now=new Date().toISOString();item.value.firstByteAt??=now;item.value.lastByteAt=now;item.value.receivedBytes+=length;}
  event(id:string,type:unknown) {
    const item=this.records.get(id);if(!item||typeof type!=='string')return;
    const known=(modelProgressEventTypes as readonly string[]).includes(type);
    const now=new Date().toISOString();item.value.firstEventAt??=now;item.value.lastEventAt=now;item.value.eventCount++;
    item.value.lastEventType=known?type as ModelRequestProgress['lastEventType']:null;
    if(type!=='keepalive'&&!item.value.textCharacters)item.value.state='processing';
  }
  text(id:string,outputIndex:number,contentIndex:number,length:number,delta:boolean) {
    const item=this.records.get(id);if(!item||length<=0)return;
    const key=outputIndex+':'+contentIndex,previous=item.parts.get(key)||0,next=delta?previous+length:Math.max(previous,length);
    if(next===previous)return;item.parts.set(key,next);item.value.textCharacters+=next-previous;
    const now=new Date().toISOString();item.value.firstTextAt??=now;item.value.lastTextAt=now;item.value.state='receiving_text';
  }
  finish(id:string,state:'completed'|'failed',errorCode?:unknown,reason?:unknown) {
    const item=this.records.get(id);if(!item)return;item.value.state=state;item.value.endedAt=new Date().toISOString();
    if(item.value.timeoutKind!==undefined)item.value.timeoutKind=['response_timeout','stream_idle_timeout','total_timeout'].includes(String(reason))?reason as NonNullable<ModelRequestProgress['timeoutKind']>:null;
    item.value.errorCode=safeToken(errorCode);item.value.reason=safeToken(reason);item.parts.clear();this.prune();
  }
  snapshot(id:string):ModelRequestProgress|undefined {
    const value=this.records.get(id)?.value;if(!value)return;
    const now=value.endedAt?Date.parse(value.endedAt):Date.now(),age=(time:string|null)=>time===null?null:Math.max(0,now-Date.parse(time));
    return {...value,elapsedMs:age(value.startedAt)!,sinceLastByteMs:age(value.lastByteAt),sinceLastEventMs:age(value.lastEventAt),sinceLastTextMs:age(value.lastTextAt)};
  }
  list(account:string|null) {
    this.prune();if(!account)return {items:[] as ModelRequestProgress[]};
    return {items:[...this.records.entries()].filter(([,item])=>item.account===account).map(([id])=>this.snapshot(id)!).reverse()};
  }
  private prune() {
    const cutoff=Date.now()-10*60_000;
    for(const [id,item] of this.records)if(item.value.endedAt&&Date.parse(item.value.endedAt)<cutoff)this.records.delete(id);
    for(const [id,item] of this.records){if(this.records.size<=20)break;if(item.value.endedAt)this.records.delete(id);}
  }
}
