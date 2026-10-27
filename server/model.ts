import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthManager, IntegrationError, upstreamError, networkDiagnostics, responseDiagnostics, safeDiagnosticText, type IntegrationDiagnostics } from './auth.ts';
import { parseReportedTokenUsage,type TokenUsageEvent } from './token-usage.js';
import { ModelProgressTracker } from './model-progress.js';

export type ModelMessage = {role:'user'|'assistant'|'developer';content:string};
export type ModelChoice = {id:string;name:string};
export type ModelOptions = {settingsFile?:string;fetch?:typeof fetch;onUsage?:(event:TokenUsageEvent)=>void|Promise<void>;requestTimeoutMs?:number};
const CatalogSchema = z.object({models:z.array(z.object({slug:z.string().min(1),display_name:z.string().min(1),visibility:z.string()}))});
const MessageSchema = z.array(z.object({role:z.enum(['developer','user','assistant']),content:z.string().min(1).max(100000)}).strict()).min(1).max(100);

/** A single OAuth service for exam creation, explanations, parsing, and grading. */
export class ModelService {
  private readonly network:typeof fetch;
  private readonly settingsFile:string;
  private choices:ModelChoice[] = [];
  private catalogAccount:string|null = null;
  private selected:string|null = null;
  private loaded = false;
  private settings:Record<string,string> = {};
  private blockedAccount:string|null = null;
  private blockedError:IntegrationError|null = null;
  private readonly onUsage:ModelOptions['onUsage'];
  private readonly progress=new ModelProgressTracker();
  private readonly requestTimeoutMs:number;
  constructor(private readonly auth:AuthManager,options:ModelOptions = {}) {
    this.network = options.fetch || fetch; this.settingsFile = options.settingsFile || join(auth.credentialDir,'model-selection.json');
    this.onUsage = options.onUsage;
    this.requestTimeoutMs=options.requestTimeoutMs??180000;
    if(!Number.isSafeInteger(this.requestTimeoutMs)||this.requestTimeoutMs<1||this.requestTimeoutMs>2_147_483_647)throw new Error('Invalid model request timeout.');
  }
  get selectedModel() { return this.selected; }
  getRequestProgress() {return this.progress.list(this.auth.status().planAuthorized?this.auth.accountKey():null);}
  /** A new explicit user retry may probe the upstream quota again. */
  resetFailurePause() { this.blockedAccount = null; this.blockedError = null; }
  private async loadSettings() {
    if (this.loaded) return;
    try {
      const value = JSON.parse(await readFile(this.settingsFile,'utf8'));
      this.settings = z.object({version:z.literal(1),selectedByAccount:z.record(z.string())}).parse(value).selectedByAccount;
    } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IntegrationError(500,'MODEL_SETTINGS_INVALID','模型偏好文件格式无效，文件已保留。'); }
    this.loaded = true;
  }
  private async saveSelection() {
    const account = this.auth.accountKey();
    if (account && this.selected) this.settings[account] = this.selected;
    await mkdir(dirname(this.settingsFile),{recursive:true});
    const temporary = `${this.settingsFile}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify({version:1,selectedByAccount:this.settings}),{mode:0o600,flag:'wx'});
    await rename(temporary,this.settingsFile);
  }
  async listModels() {
    const token = await this.auth.getAccessToken(); const account = this.auth.accountKey();
    await this.loadSettings();
    const response = await this.request('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}},30000,'model-catalog');
    if (!response.ok) throw await this.responseError(response,'model-catalog');
    let payload:unknown;
    try { payload = await response.json(); } catch(error) { throw new IntegrationError(502,'MODEL_CATALOG_INVALID','OpenAI 模型目录响应不是有效 JSON。',{...responseDiagnostics(response,'model-catalog'),...(error instanceof SyntaxError ? {reason:'invalid_json'} : networkDiagnostics(error,'model-catalog'))}); }
    const parsed = CatalogSchema.safeParse(payload);
    if (!parsed.success) throw new IntegrationError(502,'MODEL_CATALOG_INVALID','OpenAI 模型目录格式无效，无法选择模型。',responseDiagnostics(response,'model-catalog'));
    if (account !== this.auth.accountKey()) throw new IntegrationError(409,'AUTH_CHANGED','ChatGPT 账号已切换，请重新读取模型列表。',responseDiagnostics(response,'model-catalog'));
    const seen = new Set<string>();
    this.choices = parsed.data.models.filter(x => x.visibility === 'list' && !seen.has(x.slug) && !!seen.add(x.slug)).map(x => ({id:x.slug,name:x.display_name}));
    this.catalogAccount = account;
    const saved = account ? this.settings[account] : undefined;
    this.selected = this.choices.find(x => x.id === saved)?.id || this.choices[0]?.id || null;
    // An explicit catalog refresh is the user's retry action after a usage pause.
    this.resetFailurePause();
    await this.saveSelection();
    return {models:this.choices.map(x => ({...x})),selected:this.selected};
  }
  async setModel(model:string) {
    if (typeof model !== 'string' || model.length > 300) throw new IntegrationError(400,'MODEL_INVALID','请选择有效模型。');
    if (this.catalogAccount !== this.auth.accountKey() || !this.choices.length) await this.listModels();
    if (!this.choices.some(x => x.id === model)) throw new IntegrationError(400,'MODEL_UNAVAILABLE','该模型不在当前账号的可用模型列表中，请刷新列表。');
    this.selected = model; await this.saveSelection();
  }
  async generate(messages:ModelMessage[],model?:string):Promise<string> {
    const input = MessageSchema.parse(messages);
    const token = await this.auth.getAccessToken(); const account = this.auth.accountKey();
    if (account === this.blockedAccount && this.blockedError) throw new IntegrationError(this.blockedError.status,this.blockedError.code,
      '本轮操作已收到 OpenAI 套餐额度限制，后续题目暂停请求。可在错误记录查看原始官方原因；主动重试会重新检查额度。',
      {...this.blockedError.diagnostics,stage:'cached-upstream-error'});
    if (this.catalogAccount !== account || !this.choices.length) await this.listModels();
    const selected = model || this.selected;
    if (!selected || !this.choices.some(x => x.id === selected)) throw new IntegrationError(400,'MODEL_UNAVAILABLE','没有选择当前账号可用的模型，请在设置中刷新并选择模型。');
    if (account !== this.auth.accountKey()) throw new IntegrationError(409,'AUTH_CHANGED','ChatGPT 账号已切换，请重新发起操作。');
    const attemptId = randomUUID(); const occurredAt = new Date().toISOString();
    const signal=AbortSignal.timeout(this.requestTimeoutMs);
    this.progress.start(attemptId,selected,account,this.requestTimeoutMs);
    let responseId:string|undefined;
    let usage = parseReportedTokenUsage(undefined); let succeeded = false;
    try {
    // Only documented plan-usage fields are sent. History is included explicitly.
    const response = await this.request('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'text/event-stream'},
      body:JSON.stringify({model:selected,input,store:false,stream:true})},this.requestTimeoutMs,'model-request',selected,signal);
    this.progress.headers(attemptId,response.status);
    if (!response.ok) throw await this.responseError(response,'model-request',selected);
    const metadata = ():IntegrationDiagnostics => ({...responseDiagnostics(response,'model-stream'),responseId,model:selected});
    const failure = (status:number,code:string,message:string,extra:IntegrationDiagnostics = {}) => new IntegrationError(status,code,message,{...metadata(),...extra});
    const mediaType = response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase();
    // The plan route can return valid SSE with no Content-Type header. Verify
    // that body's event framing instead of rejecting it before reading. A
    // declared JSON/HTML type still fails; no JSON fallback or extra request.
    if ((mediaType && mediaType !== 'text/event-stream') || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw failure(502,'MODEL_STREAM_INVALID','OpenAI 已返回 HTTP 响应，但未返回预期的事件流，结果未保存为完成。',{reason:mediaType ? `unexpected_content_type:${mediaType}` : 'missing_response_body'});
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let buffer = ''; let accumulated = ''; let totalBytes = 0; let result:string|null = null;
    const completedItems = new Map<number,{id:string;text:string}>();
    let completedTextLength = 0;
    let framingVerified = mediaType === 'text/event-stream';
    const verifyFraming = () => {
      if (framingVerified) return;
      const beginning = buffer.trimStart();
      const prefixes = ['data:','event:',':','id:','retry:'];
      if (prefixes.some(prefix => beginning.startsWith(prefix))) {framingVerified=true;return;}
      if (buffer.length <= 1024 && prefixes.some(prefix => prefix.startsWith(beginning))) return;
      throw failure(502,'MODEL_STREAM_INVALID','OpenAI 未返回可识别的事件流，结果未保存为完成。',{reason:'invalid_event_framing'});
    };
    const processEvent = (block:string) => {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      let event:Record<string,unknown>;
      try { event = JSON.parse(data) as Record<string,unknown>; } catch { throw failure(502,'MODEL_STREAM_INVALID','模型事件流包含无效 JSON，结果未保存为完成。',{reason:'invalid_json'}); }
      if(!event || typeof event !== 'object' || Array.isArray(event)) throw failure(502,'MODEL_STREAM_INVALID','模型事件流事件结构无效，结果未保存为完成。',{reason:'invalid_event_object'});
      const responseData = event.response && typeof event.response === 'object' ? event.response as Record<string,unknown> : undefined;
      const eventResponseId = responseData?.id || event.response_id;
      if(typeof eventResponseId === 'string') responseId = safeDiagnosticText(eventResponseId,200);
      const eventType = event.type;
      this.progress.event(attemptId,eventType);
      const outputIndex=typeof event.output_index==='number'&&Number.isInteger(event.output_index)?event.output_index:0;
      const contentIndex=typeof event.content_index==='number'&&Number.isInteger(event.content_index)?event.content_index:0;
      if (eventType === 'response.completed' || eventType === 'response.failed' || eventType === 'response.incomplete' || eventType === 'error') {
        usage = parseReportedTokenUsage(responseData?.usage ?? event.usage);
      }
      if (eventType === 'response.output_text.delta') {
        if (typeof event.delta !== 'string') throw failure(502,'MODEL_STREAM_INVALID','模型文本片段格式无效。');
        accumulated += event.delta;
        this.progress.text(attemptId,outputIndex,contentIndex,event.delta.length,true);
        if (accumulated.length > 500000) throw failure(502,'MODEL_OUTPUT_TOO_LARGE','模型输出超过本地允许长度，结果未保存。');
      } else if (eventType === 'response.output_text.done') {
        if(typeof event.text==='string')this.progress.text(attemptId,outputIndex,contentIndex,event.text.length,false);
      } else if (eventType === 'response.output_item.done') {
        const item = event.item as {id?:unknown;type?:unknown;status?:unknown;role?:unknown;content?:unknown} | undefined;
        if (!item || item.type !== 'message') return;
        const index = event.output_index;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 1000 ||
          typeof item.id !== 'string' || !item.id || item.id.length > 200 || item.status !== 'completed' || item.role !== 'assistant' || !Array.isArray(item.content)) {
          throw failure(502,'MODEL_STREAM_INVALID','模型最终消息格式无效，结果未保存为完成。');
        }
        const parts:string[] = [];
        for (const [partIndex,part] of item.content.entries()) {
          if (part && typeof part === 'object' && part.type === 'output_text') {
            if (typeof part.text !== 'string') throw failure(502,'MODEL_STREAM_INVALID','模型最终文本格式无效。');
            parts.push(part.text);
            this.progress.text(attemptId,index,partIndex,part.text.length,false);
          }
        }
        const text = parts.join(''); const previous = completedItems.get(index);
        if (previous) {
          if (previous.id !== item.id || previous.text !== text) throw failure(502,'MODEL_STREAM_INVALID','模型最终消息发生冲突，结果未保存为完成。');
        } else {
          completedTextLength += text.length;
          if (completedTextLength > 500000) throw failure(502,'MODEL_OUTPUT_TOO_LARGE','模型输出超过本地允许长度，结果未保存。');
          completedItems.set(index,{id:item.id,text});
        }
      } else if (eventType === 'response.failed' || eventType === 'error') {
        const responseBody = event.response && typeof event.response === 'object' ? event.response as Record<string,unknown> : event;
        const errBody = responseBody.error || event.error || {code:event.code,message:event.message};
        const code = errBody && typeof errBody === 'object' ? (errBody as Record<string,unknown>).code : null;
        const status = code === 'subscription_sharing_usage_limit_exceeded' ? 429 : code === 'subscription_sharing_user_not_eligible' ? 403 : 503;
        const upstreamFailure = upstreamError(status,{error:errBody},metadata().requestId,metadata());
        if (upstreamFailure.code === 'subscription_sharing_usage_limit_exceeded') {this.blockedAccount = account;this.blockedError = upstreamFailure;}
        throw upstreamFailure;
      } else if (eventType === 'response.incomplete') {
        const details = responseData?.incomplete_details || event.incomplete_details;
        const reason = details && typeof details === 'object' ? safeDiagnosticText((details as Record<string,unknown>).reason,6000) : undefined;
        throw failure(502,'MODEL_RESPONSE_INCOMPLETE','OpenAI 明确返回响应未完成，已收到的部分文本不会作为完整结果保存。',{reason});
      } else if (eventType === 'response.completed') {
        const completed = event.response as {status?:string;output?:unknown} | undefined;
        if (!completed || completed.status !== 'completed' || !Array.isArray(completed.output)) throw failure(502,'MODEL_COMPLETION_INVALID','模型完成事件格式无效，结果未保存为完成。');
        const texts:string[] = [];
        for (const [outputIndex,output] of completed.output.entries()) {
          if (!output || typeof output !== 'object') continue;
          const item = output as {type?:string;content?:unknown};
          if (item.type !== 'message' || !Array.isArray(item.content)) continue;
          for (const [partIndex,part] of item.content.entries()) if (part && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string') {texts.push(part.text);this.progress.text(attemptId,outputIndex,partIndex,part.text.length,false);}
        }
        // Some plan streams omit repeated items from the terminal response.
        // Use only completed output_item.done messages, never partial deltas,
        // and still require the successful response.completed event above.
        result = completed.output.length === 0
          ? [...completedItems].sort(([a],[b]) => a-b).map(([,item]) => item.text).join('')
          : texts.join('');
        if (!result.trim() || result.length > 500000) throw failure(502,'MODEL_OUTPUT_INVALID','模型没有返回有效的完整文本。');
      }
    };
    try {
      while (result === null) {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          verifyFraming();
          if (buffer.trim()) processEvent(buffer.replace(/\r\n/g,'\n'));
          if (result === null) throw failure(502,'MODEL_STREAM_INTERRUPTED','模型事件流在完成事件前结束，未收到 response.completed；部分文本不会作为成功结果保存。',{reason:'stream_ended_without_completion'});
          break;
        }
        totalBytes += chunk.value.byteLength;
        this.progress.bytes(attemptId,chunk.value.byteLength);
        if (totalBytes > 8*1024*1024) throw failure(502,'MODEL_OUTPUT_TOO_LARGE','模型事件流超过本地允许大小。');
        buffer += decoder.decode(chunk.value,{stream:true}); buffer = buffer.replace(/\r\n/g,'\n');
        verifyFraming();
        let boundary:number;
        while (result === null && (boundary=buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2); processEvent(event);
        }
      }
      if (account !== this.auth.accountKey() || !this.auth.status().planAuthorized) throw failure(409,'AUTH_CHANGED','ChatGPT 连接在请求期间已更改，结果未保存为完成。');
      succeeded = true;
      this.progress.finish(attemptId,'completed');
      return result!;
    } catch(error) {
      if (error instanceof IntegrationError) throw error;
      throw failure(502,'MODEL_STREAM_INTERRUPTED','读取 OpenAI 模型事件流时连接中断，未完成的内容不会保存为成功结果。',networkDiagnostics(error,'model-stream-read'));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch(error) {
      const original=error instanceof IntegrationError?error:new IntegrationError(502,'MODEL_STREAM_INTERRUPTED','读取 OpenAI 模型事件流时连接中断，未完成的内容不会保存为成功结果。',networkDiagnostics(error,'model-stream-read'));
      const before=this.progress.snapshot(attemptId);
      const timeoutTransport=['OPENAI_NETWORK_ERROR','MODEL_STREAM_INTERRUPTED','OPENAI_RESPONSE_INTERRUPTED'].includes(original.code)&&['TimeoutError','AbortError'].includes(original.diagnostics.networkCode||'');
      const timedOut=signal.aborted&&signal.reason?.name==='TimeoutError'&&timeoutTransport;
      const code=timedOut?'MODEL_REQUEST_TIMEOUT':original.code;
      const reason=timedOut?'total_timeout':original.diagnostics.reason;
      this.progress.finish(attemptId,'failed',code,reason);
      const progress=this.progress.snapshot(attemptId);
      const seconds=Math.round(this.requestTimeoutMs/1000);
      const observed=!before?.headersAt?'尚未收到 HTTP 响应':!before.eventCount?'已收到 HTTP 响应，但未收到模型事件':!before.textCharacters?'已收到模型事件，但未收到答案正文':'已收到部分答案正文，但未收到完成事件';
      throw new IntegrationError(timedOut?504:original.status,code,timedOut?`模型请求达到 ${seconds} 秒总等待上限；${observed}。未完成内容不会保存为成功结果。`:original.publicMessage,
        {...original.diagnostics,...(before?.httpStatus?{upstreamStatus:before.httpStatus}:{}),...(timedOut?{reason,stage:before?.headersAt?'model-stream-read':'model-request'}:{}),...(progress?{progress}:{})});
    } finally {
      // Counts are optional telemetry. A broken observer cannot alter inference.
      try {
        const pending = this.onUsage?.({id:attemptId,occurredAt,model:selected,responseId:responseId || null,status:succeeded ? 'completed' : 'failed',...usage});
        if (pending) void Promise.resolve(pending).catch(() => {});
      } catch { /* Preserve the model result or original failure. */ }
    }
  }
  private async request(url:string,init:RequestInit,timeout:number,stage:string,model?:string,signal=AbortSignal.timeout(timeout)) {
    try {return await this.network(url,{...init,redirect:'error',signal});}
    catch(error) {throw new IntegrationError(503,'OPENAI_NETWORK_ERROR','连接 OpenAI 模型服务失败，尚未收到 HTTP 响应。请查看网络错误详情。',{...networkDiagnostics(error,stage),model});}
  }
  private async responseError(response:Response,stage:string,model?:string) {
    let text:string;
    try {text = await response.text();}
    catch(error) {return new IntegrationError(502,'OPENAI_RESPONSE_INTERRUPTED','OpenAI 返回失败状态，但读取其错误响应时连接中断。',{...responseDiagnostics(response,stage),...networkDiagnostics(error,stage),model});}
    let body:unknown; try {body = JSON.parse(text);} catch {body = {detail:safeDiagnosticText(text)};}
    const error = upstreamError(response.status,body,responseDiagnostics(response,stage).requestId,{...responseDiagnostics(response,stage),model});
    if (error.code === 'subscription_sharing_usage_limit_exceeded') {this.blockedAccount = this.auth.accountKey();this.blockedError = error;}
    return error;
  }
}
