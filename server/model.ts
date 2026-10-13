import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthManager, IntegrationError, upstreamError } from './auth.ts';

export type ModelMessage = {role:'user'|'assistant'|'developer';content:string};
export type ModelChoice = {id:string;name:string};
export type ModelOptions = {settingsFile?:string;fetch?:typeof fetch};
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
  constructor(private readonly auth:AuthManager,options:ModelOptions = {}) {
    this.network = options.fetch || fetch; this.settingsFile = options.settingsFile || join(auth.credentialDir,'model-selection.json');
  }
  get selectedModel() { return this.selected; }
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
    const response = await this.request('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}},30000);
    if (!response.ok) throw await this.responseError(response);
    let payload:unknown;
    try { payload = await response.json(); } catch { throw new IntegrationError(502,'MODEL_CATALOG_INVALID','OpenAI 模型目录响应不是有效 JSON。'); }
    const parsed = CatalogSchema.safeParse(payload);
    if (!parsed.success) throw new IntegrationError(502,'MODEL_CATALOG_INVALID','OpenAI 模型目录格式无效，无法选择模型。');
    if (account !== this.auth.accountKey()) throw new IntegrationError(409,'AUTH_CHANGED','ChatGPT 账号已切换，请重新读取模型列表。');
    const seen = new Set<string>();
    this.choices = parsed.data.models.filter(x => x.visibility === 'list' && !seen.has(x.slug) && !!seen.add(x.slug)).map(x => ({id:x.slug,name:x.display_name}));
    this.catalogAccount = account;
    const saved = account ? this.settings[account] : undefined;
    this.selected = this.choices.find(x => x.id === saved)?.id || this.choices[0]?.id || null;
    // An explicit catalog refresh is the user's retry action after a usage pause.
    this.blockedAccount = null; this.blockedError = null;
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
    if (account === this.blockedAccount && this.blockedError) throw this.blockedError;
    if (this.catalogAccount !== account || !this.choices.length) await this.listModels();
    const selected = model || this.selected;
    if (!selected || !this.choices.some(x => x.id === selected)) throw new IntegrationError(400,'MODEL_UNAVAILABLE','没有选择当前账号可用的模型，请在设置中刷新并选择模型。');
    if (account !== this.auth.accountKey()) throw new IntegrationError(409,'AUTH_CHANGED','ChatGPT 账号已切换，请重新发起操作。');
    // Only documented plan-usage fields are sent. History is included explicitly.
    const response = await this.request('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'text/event-stream'},
      body:JSON.stringify({model:selected,input,store:false,stream:true})},180000);
    if (!response.ok) throw await this.responseError(response);
    const mediaType = response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase();
    // The plan route can return valid SSE with no Content-Type header. Verify
    // that body's event framing instead of rejecting it before reading. A
    // declared JSON/HTML type still fails; no JSON fallback or extra request.
    if ((mediaType && mediaType !== 'text/event-stream') || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new IntegrationError(502,'MODEL_STREAM_INVALID','OpenAI 未返回预期的事件流，结果未保存为完成。');
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
      throw new IntegrationError(502,'MODEL_STREAM_INVALID','OpenAI 未返回可识别的事件流，结果未保存为完成。');
    };
    const processEvent = (block:string) => {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      let event:Record<string,unknown>;
      try { event = JSON.parse(data) as Record<string,unknown>; } catch { throw new IntegrationError(502,'MODEL_STREAM_INVALID','模型事件流包含无效 JSON，结果未保存为完成。'); }
      const eventType = event.type;
      if (eventType === 'response.output_text.delta') {
        if (typeof event.delta !== 'string') throw new IntegrationError(502,'MODEL_STREAM_INVALID','模型文本片段格式无效。');
        accumulated += event.delta;
        if (accumulated.length > 500000) throw new IntegrationError(502,'MODEL_OUTPUT_TOO_LARGE','模型输出超过本地允许长度，结果未保存。');
      } else if (eventType === 'response.output_item.done') {
        const item = event.item as {id?:unknown;type?:unknown;status?:unknown;role?:unknown;content?:unknown} | undefined;
        if (!item || item.type !== 'message') return;
        const index = event.output_index;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 1000 ||
          typeof item.id !== 'string' || !item.id || item.id.length > 200 || item.status !== 'completed' || item.role !== 'assistant' || !Array.isArray(item.content)) {
          throw new IntegrationError(502,'MODEL_STREAM_INVALID','模型最终消息格式无效，结果未保存为完成。');
        }
        const parts:string[] = [];
        for (const part of item.content) {
          if (part && typeof part === 'object' && part.type === 'output_text') {
            if (typeof part.text !== 'string') throw new IntegrationError(502,'MODEL_STREAM_INVALID','模型最终文本格式无效。');
            parts.push(part.text);
          }
        }
        const text = parts.join(''); const previous = completedItems.get(index);
        if (previous) {
          if (previous.id !== item.id || previous.text !== text) throw new IntegrationError(502,'MODEL_STREAM_INVALID','模型最终消息发生冲突，结果未保存为完成。');
        } else {
          completedTextLength += text.length;
          if (completedTextLength > 500000) throw new IntegrationError(502,'MODEL_OUTPUT_TOO_LARGE','模型输出超过本地允许长度，结果未保存。');
          completedItems.set(index,{id:item.id,text});
        }
      } else if (eventType === 'response.failed' || eventType === 'error') {
        const responseBody = event.response && typeof event.response === 'object' ? event.response as Record<string,unknown> : event;
        const errBody = responseBody.error || event.error || {code:event.code,message:event.message};
        const code = errBody && typeof errBody === 'object' ? (errBody as Record<string,unknown>).code : null;
        const status = code === 'subscription_sharing_usage_limit_exceeded' ? 429 : code === 'subscription_sharing_user_not_eligible' ? 403 : 503;
        const failure = upstreamError(status,{error:errBody},response.headers.get('x-request-id') || undefined);
        if (failure.code === 'subscription_sharing_usage_limit_exceeded') {this.blockedAccount = account;this.blockedError = failure;}
        throw failure;
      } else if (eventType === 'response.incomplete') {
        throw new IntegrationError(502,'MODEL_RESPONSE_INCOMPLETE','模型响应未完成，已收到的部分文本不会作为完整结果保存。');
      } else if (eventType === 'response.completed') {
        const completed = event.response as {status?:string;output?:unknown} | undefined;
        if (!completed || completed.status !== 'completed' || !Array.isArray(completed.output)) throw new IntegrationError(502,'MODEL_COMPLETION_INVALID','模型完成事件格式无效，结果未保存为完成。');
        const texts:string[] = [];
        for (const output of completed.output) {
          if (!output || typeof output !== 'object') continue;
          const item = output as {type?:string;content?:unknown};
          if (item.type !== 'message' || !Array.isArray(item.content)) continue;
          for (const part of item.content) if (part && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
        }
        // Some plan streams omit repeated items from the terminal response.
        // Use only completed output_item.done messages, never partial deltas,
        // and still require the successful response.completed event above.
        result = completed.output.length === 0
          ? [...completedItems].sort(([a],[b]) => a-b).map(([,item]) => item.text).join('')
          : texts.join('');
        if (!result.trim() || result.length > 500000) throw new IntegrationError(502,'MODEL_OUTPUT_INVALID','模型没有返回有效的完整文本。');
      }
    };
    try {
      while (result === null) {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          verifyFraming();
          if (buffer.trim()) processEvent(buffer.replace(/\r\n/g,'\n'));
          if (result === null) throw new IntegrationError(502,'MODEL_STREAM_INTERRUPTED','模型事件流已中断，未收到 response.completed；部分文本不会作为成功结果保存。');
          break;
        }
        totalBytes += chunk.value.byteLength;
        if (totalBytes > 8*1024*1024) throw new IntegrationError(502,'MODEL_OUTPUT_TOO_LARGE','模型事件流超过本地允许大小。');
        buffer += decoder.decode(chunk.value,{stream:true}); buffer = buffer.replace(/\r\n/g,'\n');
        verifyFraming();
        let boundary:number;
        while (result === null && (boundary=buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2); processEvent(event);
        }
      }
      if (account !== this.auth.accountKey() || !this.auth.status().planAuthorized) throw new IntegrationError(409,'AUTH_CHANGED','ChatGPT 连接在请求期间已更改，结果未保存为完成。');
      return result!;
    } catch(error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(502,'MODEL_STREAM_INTERRUPTED','读取模型事件流失败，未完成的内容不会保存为成功结果。');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private async request(url:string,init:RequestInit,timeout:number) {
    try {return await this.network(url,{...init,redirect:'error',signal:AbortSignal.timeout(timeout)});}
    catch {throw new IntegrationError(503,'OPENAI_NETWORK_ERROR','无法连接 OpenAI 模型服务，请检查网络后重试。');}
  }
  private async responseError(response:Response) {
    let body:unknown; try {body = await response.json();} catch {body = {};}
    const error = upstreamError(response.status,body,response.headers.get('openai-request-id') || response.headers.get('x-request-id') || undefined);
    if (error.code === 'subscription_sharing_usage_limit_exceeded') {this.blockedAccount = this.auth.accountKey();this.blockedError = error;}
    return error;
  }
}
