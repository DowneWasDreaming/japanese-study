import { Router } from 'express';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';

/** Safe metadata is exposed to the UI; token responses and raw tokens are never attached. */
export class IntegrationError extends Error {
  readonly publicMessage: string;
  constructor(readonly status: number, readonly code: string, message: string,
    readonly diagnostics: { requestId?: string; param?: string; bodyShape?: string; detail?: string } = {}) {
    super(message); this.name = 'IntegrationError'; this.publicMessage = message;
  }
}

export function upstreamError(status: number, body: unknown, requestId?: string): IntegrationError {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : {};
  const rawCode = typeof data.error === 'string' ? data.error : nested.code;
  const code = typeof rawCode === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(rawCode) ? rawCode : `OPENAI_HTTP_${status}`;
  const messages: Record<string, string> = {
    subscription_sharing_user_not_eligible: '当前账号、工作空间或政策不允许使用 ChatGPT 套餐。请检查官方接入资格，重新登录不会解除此限制。',
    subscription_sharing_usage_limit_exceeded: '此应用的 ChatGPT 套餐使用已达到限制。请在 ChatGPT 使用量设置中查看和管理额度。',
    subscription_sharing_usage_unavailable: 'ChatGPT 暂时无法查询套餐可用额度，请稍后重试。',
    subscription_sharing_unsupported_capability: '本次请求包含当前套餐接入不支持的能力。请检查接口参数。',
    subscription_sharing_route_not_supported: '当前 ChatGPT 套餐不支持此请求路径，请检查官方接入配置。',
    subscription_sharing_invalid_user: 'ChatGPT 身份上下文未通过验证，请检查连接状态。',
    subscription_sharing_user_unavailable: 'ChatGPT 暂时无法读取账号或工作空间信息，请稍后重试。',
    chatpass_v2_scope_not_authorized: '当前 ChatGPT 授权范围不足，请重新授权套餐使用。',
    chatpass_v2_invalid_authorization_context: 'ChatGPT 套餐授权上下文不正确，请检查账号与客户端的对应关系。',
    invalid_grant: 'ChatGPT 授权或续期凭据已失效，请重新登录授权。',
    invalid_client: 'ChatGPT 客户端身份无效，请检查客户端注册信息。',
  };
  let message = messages[code] || (status === 401 ? 'ChatGPT 未接受此身份或套餐权限，请检查连接状态。'
    : status === 403 ? 'ChatGPT 拒绝请求，可能存在账号、工作空间、区域或政策限制。'
    : status === 429 ? 'ChatGPT 请求受到限流，请稍后重试并查看使用量设置。'
    : status >= 500 ? 'ChatGPT 服务或套餐路由暂时不可用，请稍后重试。' : 'ChatGPT 请求失败，请检查连接与请求内容。');
  const detail = typeof data.detail === 'string' ? data.detail : typeof nested.message === 'string' ? nested.message : undefined;
  // Admission detail is diagnostic text, not a stable code. Reject token-like content.
  const safeDetail = detail && !/access_token|refresh_token|id_token|Bearer |eyJ[A-Za-z0-9_-]{15}/i.test(detail) ? detail.slice(0,600) : undefined;
  if (safeDetail) message += ` 官方提示：${safeDetail}`;
  return new IntegrationError(status, code, message, {
    requestId: requestId?.slice(0,160), param: typeof nested.param === 'string' ? nested.param.slice(0,80) : undefined,
    bodyShape: Object.keys(data).sort().join(','), detail: safeDetail,
  });
}

const TokensSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), id_token: z.string().min(1).optional(),
  token_type: z.string().refine(x => x.toLowerCase() === 'bearer'), expires_in: z.number().positive(),
  scope: z.string().optional(), earliest_refresh_at: z.union([z.number(),z.string()]).optional(),
});
const RegistrationSchema = z.object({
  id: z.string(), clientId: z.string().min(1).refine(x => x !== 'dynamic_agent_client'), subject: z.string().min(1),
  issuer: z.literal(ISSUER), email: z.string().nullable(), name: z.string().nullable(), scopes: z.array(z.string()),
  accessToken: z.string().optional(), refreshToken: z.string().optional(), idToken: z.string().optional(),
  expiresAt: z.number().optional(), earliestRefreshAt: z.number().optional(),
  welcomeAcknowledged: z.boolean().default(false),
});
const StoreSchema = z.object({version: z.literal(1), hostId: z.string().min(1), activeId: z.string().nullable(),
  registrations: z.array(RegistrationSchema), unverifiedClientId: z.string().optional()});
type Registration = z.infer<typeof RegistrationSchema>;
type CredentialStore = z.infer<typeof StoreSchema>;
type Pending = { state: string; verifier: string; nonce: string; redirectUri: string; clientId: string;
  registrationId?: string; expiresAt: number; enablePlan: boolean; started: boolean };
type Discovery = {issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint?: string};
export type AuthOptions = {credentialDir: string; redirectUri?: string; fetch?: typeof fetch; now?: () => number};

/** Restrict the app-owned directory before writing any credentials. Failure is fatal. */
async function protectDirectory(directory: string) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return; }
  const script = "$ErrorActionPreference='Stop'; $p=$env:JAPANESE_STUDY_CREDENTIAL_DIR; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[System.IO.Directory]::GetAccessControl($p,[System.Security.AccessControl.AccessControlSections]::Access); $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($rule); }; $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'; $prop=[System.Security.AccessControl.PropagationFlags]::None; $allow=[System.Security.AccessControl.AccessControlType]::Allow; $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,$prop,$allow)); $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl',$inherit,$prop,$allow)); [System.IO.Directory]::SetAccessControl($p,$acl)";
  // Windows PowerShell must discover its own modules, rather than inherit a
  // PowerShell 7 module path from a development shell.
  const { PSModulePath: _modulePath, ...childEnvironment } = process.env;
  try { execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {
    windowsHide: true, stdio: 'pipe', env: {...childEnvironment,JAPANESE_STUDY_CREDENTIAL_DIR:directory}, timeout: 15000,
  }); } catch { throw new IntegrationError(500, 'CREDENTIAL_PROTECTION_FAILED', '无法限制本地凭据目录的访问权限。请检查目录权限后重新启动。'); }
}

export class AuthManager {
  readonly credentialDir: string;
  readonly redirectUri: string;
  private readonly network: typeof fetch;
  private readonly now: () => number;
  private store!: CredentialStore;
  private initialized?: Promise<void>;
  private discoveryPromise?: Promise<Discovery>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private pending = new Map<string, Pending>();
  private refreshing?: Promise<string>;
  private generation = 0;
  private saving: Promise<void> = Promise.resolve();
  private lastError: {code:string;message:string;status:number;requestId?:string} | null = null;

  constructor(options: AuthOptions) {
    this.credentialDir = resolve(options.credentialDir);
    this.redirectUri = options.redirectUri || 'http://127.0.0.1:3210/auth/callback';
    const callback = new URL(this.redirectUri);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/auth/callback' || callback.search || callback.hash || callback.username) {
      throw new Error('OAuth 回调必须为 http://127.0.0.1:端口/auth/callback');
    }
    this.network = options.fetch || fetch; this.now = options.now || Date.now;
  }

  init(): Promise<void> {
    return this.initialized ||= (async () => {
      await protectDirectory(this.credentialDir);
      try { this.store = StoreSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IntegrationError(500,'CREDENTIAL_STORE_INVALID','本地凭据文件格式无效；文件已保留，请修复或另选凭据目录。');
        this.store = {version:1,hostId:`urn:uuid:${randomUUID()}`,activeId:null,registrations:[]}; await this.save();
      }
    })();
  }
  private get path() { return join(this.credentialDir,'connections.json'); }
  private active() { return this.store?.registrations.find(x => x.id === this.store.activeId); }
  accountKey(): string | null { return this.active()?.id || null; }
  status() {
    const active = this.active();
    const safeAccount = (x:Registration) => ({id:x.id,sub:x.subject,email:x.email,name:x.name, label:`${x.name || x.email || 'ChatGPT 账号'} · ${x.id.slice(0,8)}`});
    const planAuthorized = !!active?.accessToken && active.scopes.includes('chatgpt.tokens.use.direct') && active.scopes.includes('resource.invoke');
    return {connected:!!active?.accessToken,planAuthorized,welcomeNeeded:planAuthorized && !active?.welcomeAcknowledged,
      account:active ? safeAccount(active) : null,registrations:(this.store?.registrations || []).map(safeAccount),
      usageUrl:USAGE_URL,lastError:this.lastError};
  }
  private async save() {
    const contents = JSON.stringify(this.store);
    // Serialize snapshots so an earlier callback write cannot finish after a
    // later sign-out and restore credentials that have already been cleared.
    this.saving = this.saving.catch(() => {}).then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = await open(temporary,'wx',0o600);
      try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
      try { await rename(temporary,this.path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    });
    return this.saving;
  }
  private async discovery(): Promise<Discovery> {
    return this.discoveryPromise ||= (async () => {
      const response = await this.request(`${ISSUER}/.well-known/openid-configuration`);
      if (!response.ok) throw upstreamError(response.status, await this.readBody(response), this.requestId(response));
      const value = await response.json() as Discovery;
      const endpoint = (url:string) => new URL(url).origin === ISSUER && new URL(url).protocol === 'https:';
      if (value.issuer !== ISSUER || ![value.authorization_endpoint,value.token_endpoint,value.jwks_uri].every(x => typeof x === 'string' && endpoint(x)) || (value.revocation_endpoint && !endpoint(value.revocation_endpoint))) {
        throw new IntegrationError(502,'INVALID_DISCOVERY','OpenAI 身份服务发现信息未通过安全校验。');
      }
      this.jwks = createRemoteJWKSet(new URL(value.jwks_uri), {[customFetch]:this.network});
      return value;
    })().catch(error => { this.discoveryPromise = undefined; throw error; });
  }
  private requestId(response:Response) { return response.headers.get('openai-request-id') || response.headers.get('x-request-id') || undefined; }
  private async readBody(response:Response):Promise<unknown> { try { return await response.json(); } catch { return {}; } }
  private async request(url:string,init:RequestInit = {}) {
    try { return await this.network(url,{...init,redirect:'error',signal:AbortSignal.timeout(30000)}); }
    catch { throw new IntegrationError(503,'OPENAI_NETWORK_ERROR','无法连接 OpenAI 身份服务，请检查网络后重试。'); }
  }

  async start(options: {registrationId?:string;newAccount?:boolean;enablePlan?:boolean} = {}) {
    await this.init(); await this.discovery();
    for (const [id,pending] of this.pending) if (pending.expiresAt <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 8) throw new IntegrationError(429,'AUTH_ATTEMPT_LIMIT','登录请求过多，请完成或等待已有登录请求过期。');
    const registration = options.newAccount ? undefined : options.registrationId ? this.store.registrations.find(x => x.id === options.registrationId) : this.active();
    if (options.registrationId && !registration) throw new IntegrationError(400,'ACCOUNT_NOT_FOUND','未找到所选 ChatGPT 账号。');
    const id = randomBytes(32).toString('base64url');
    this.pending.set(id,{state:randomBytes(32).toString('base64url'),verifier:randomBytes(64).toString('base64url'),nonce:randomBytes(32).toString('base64url'),
      redirectUri:this.redirectUri,clientId:registration?.clientId || (!options.newAccount && this.store.unverifiedClientId) || 'dynamic_agent_client',
      registrationId:registration?.id,expiresAt:this.now()+10*60*1000,enablePlan:!!options.enablePlan,started:false});
    // The frontend receives only a local one-time redirect, never an ID token hint.
    return {url:`/api/auth/authorize?attempt=${id}`};
  }

  authorizationUrl(attemptId:string) {
    const pending = this.pending.get(attemptId);
    if (!pending || pending.expiresAt <= this.now() || pending.started) throw new IntegrationError(400,'AUTH_ATTEMPT_INVALID','登录入口已使用或过期，请重新开始登录。');
    pending.started = true;
    const registration = this.store.registrations.find(x => x.id === pending.registrationId);
    const parameters = new URLSearchParams({client_id:pending.clientId,ext_agent_host_id:this.store.hostId,response_type:'code',redirect_uri:pending.redirectUri,
      scope:SCOPES,resource:RESOURCE,state:pending.state,nonce:pending.nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(pending.verifier).digest('base64url')});
    if (pending.clientId === 'dynamic_agent_client') parameters.set('agent_name_hint','木漏れ日 · 个人日语学习');
    if (registration?.idToken) parameters.set('id_token_hint',registration.idToken);
    if (registration?.email) parameters.set('login_hint',registration.email);
    if (pending.enablePlan) parameters.set('prompt','consent');
    return `${ISSUER}/api/accounts/authorize?${parameters}`;
  }

  async callback(parameters:URLSearchParams) {
    await this.init();
    const epoch = this.generation;
    const returnedState = parameters.get('state');
    const returnedBytes = Buffer.from(returnedState || '');
    const entry = [...this.pending].find(([,pending]) => {
      const expectedBytes = Buffer.from(pending.state);
      return returnedState && returnedBytes.length === expectedBytes.length && timingSafeEqual(returnedBytes,expectedBytes);
    });
    if (!entry || entry[1].expiresAt <= this.now() || !entry[1].started) throw this.remember(new IntegrationError(400,'OAUTH_STATE_INVALID','登录回调校验失败或已过期，请重新开始登录。'));
    const [attemptId,pending] = entry; this.pending.delete(attemptId);
    if (['state','code','client_id','error'].some(key => parameters.getAll(key).length > 1)) throw this.remember(new IntegrationError(400,'OAUTH_CALLBACK_INVALID','登录回调参数重复，无法验证。'));
    if (parameters.has('error')) throw this.remember(new IntegrationError(400,parameters.get('error') === 'access_denied' ? 'access_denied' : 'OAUTH_DENIED','ChatGPT 登录或套餐授权未完成。请在设置中主动重新授权。'));
    const returnedClient = parameters.get('client_id');
    if (pending.clientId !== 'dynamic_agent_client' && returnedClient && returnedClient !== pending.clientId) throw this.remember(new IntegrationError(400,'OAUTH_CLIENT_MISMATCH','登录回调的客户端身份与所选账号不一致。'));
    const clientId = pending.clientId === 'dynamic_agent_client' ? returnedClient : pending.clientId;
    if (!clientId || clientId === 'dynamic_agent_client' || clientId.length > 300) throw this.remember(new IntegrationError(400,'OAUTH_CLIENT_MISSING','注册回调缺少实际客户端 ID，注册尚未完成。'));
    const code = parameters.get('code');
    if (!code) throw this.remember(new IntegrationError(400,'OAUTH_CODE_MISSING','登录回调缺少授权码。'));
    if (pending.clientId === 'dynamic_agent_client') { this.store.unverifiedClientId = clientId; await this.save(); }
    try {
      if (epoch !== this.generation) throw new IntegrationError(409,'AUTH_CHANGED','连接已更改，请重新开始登录。');
      const discovery = await this.discovery();
      const response = await this.request(discovery.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
        body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:pending.verifier,redirect_uri:pending.redirectUri,resource:RESOURCE})});
      if (!response.ok) throw upstreamError(response.status,await this.readBody(response),this.requestId(response));
      const parsed = TokensSchema.safeParse(await response.json());
      if (!parsed.success || !parsed.data.id_token || typeof parsed.data.scope !== 'string') throw new IntegrationError(502,'OAUTH_TOKENS_INVALID','OpenAI 授权响应缺少身份令牌或授权范围。');
      const tokens = parsed.data;
      const identity = await this.verifyIdentity(tokens.id_token!,clientId,pending.nonce);
      if (epoch !== this.generation) throw new IntegrationError(409,'AUTH_CHANGED','连接已更改，请重新开始登录。');
      const existing = this.store.registrations.find(x => x.id === pending.registrationId);
      if (existing && identity.sub !== existing.subject) throw new IntegrationError(400,'OAUTH_ACCOUNT_MISMATCH','新登录身份与所选 ChatGPT 账号不一致，原连接已保留。');
      const scopes = tokens.scope!.split(/\s+/).filter(Boolean);
      if (scopes.includes('offline_access') && !tokens.refresh_token) throw new IntegrationError(502,'OAUTH_REFRESH_MISSING','授权包含离线访问权限，但响应缺少续期凭据。');
      const registration:Registration = {id:existing?.id || randomUUID(),clientId,subject:identity.sub!,issuer:ISSUER,
        email:typeof identity.email === 'string' ? identity.email : null,name:typeof identity.name === 'string' ? identity.name : null,
        scopes,accessToken:tokens.access_token,refreshToken:tokens.refresh_token,idToken:tokens.id_token,expiresAt:this.now()+tokens.expires_in*1000,
        earliestRefreshAt:this.refreshTime(tokens.earliest_refresh_at),welcomeAcknowledged:existing?.welcomeAcknowledged || false};
      const index = this.store.registrations.findIndex(x => x.id === registration.id);
      if (index >= 0) this.store.registrations[index] = registration; else this.store.registrations.push(registration);
      this.store.activeId = registration.id; delete this.store.unverifiedClientId; this.generation++; this.lastError = null; await this.save();
      return this.status();
    } catch (error) { throw this.remember(error instanceof IntegrationError ? error : new IntegrationError(502,'OAUTH_VALIDATION_FAILED','OpenAI 登录身份或令牌响应未通过验证。')); }
  }

  private async verifyIdentity(token:string,clientId:string,nonce?:string):Promise<JWTPayload> {
    await this.discovery();
    try {
      const {payload} = await jwtVerify(token,this.jwks!,{issuer:ISSUER,audience:clientId,requiredClaims:['sub','exp','iat'],clockTolerance:5,currentDate:new Date(this.now()),algorithms:['RS256','ES256']});
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw new Error('invalid identity');
      return payload;
    } catch { throw new IntegrationError(400,'OAUTH_ID_TOKEN_INVALID','OpenAI 身份令牌签名、身份、有效期或 nonce 校验失败。'); }
  }
  private refreshTime(value:number|string|undefined) {
    if (value === undefined) return undefined;
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric*1000 : Number.isFinite(Date.parse(String(value))) ? Date.parse(String(value)) : undefined;
  }
  private remember(error:IntegrationError) {
    this.lastError = {code:error.code,message:error.publicMessage,status:error.status,requestId:error.diagnostics.requestId}; return error;
  }

  async getAccessToken():Promise<string> {
    await this.init();
    const active = this.active();
    if (!active?.accessToken) throw new IntegrationError(401,'CHATGPT_NOT_CONNECTED','请先使用 Continue with ChatGPT 连接账号。');
    if (!active.scopes.includes('chatgpt.tokens.use.direct') || !active.scopes.includes('resource.invoke')) throw new IntegrationError(403,'CHATGPT_PLAN_NOT_AUTHORIZED','已登录 ChatGPT，但尚未获准使用套餐。请主动启用套餐授权。');
    if ((active.expiresAt || 0) > this.now()+60000 || (active.earliestRefreshAt || 0) > this.now() && (active.expiresAt || 0) > this.now()) return active.accessToken;
    return this.refreshing ||= this.refresh().finally(() => {this.refreshing = undefined;});
  }
  private async refresh():Promise<string> {
    const release = await this.lock();
    try {
      // Reload after acquiring an interprocess lock: another process may have rotated the token.
      this.store = StoreSchema.parse(JSON.parse(await readFile(this.path,'utf8')));
      const active = this.active(); const epoch = this.generation;
      if (!active?.accessToken) throw new IntegrationError(401,'CHATGPT_NOT_CONNECTED','ChatGPT 已退出连接，请重新登录。');
      if ((active.expiresAt || 0) > this.now()+60000) return active.accessToken;
      if (!active.refreshToken) throw new IntegrationError(401,'CHATGPT_REAUTHORIZE','ChatGPT 凭据已到期且无法续期，请重新登录授权。');
      const discovery = await this.discovery();
      const response = await this.request(discovery.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
        body:new URLSearchParams({grant_type:'refresh_token',client_id:active.clientId,refresh_token:active.refreshToken,resource:RESOURCE})});
      if (!response.ok) {
        const error = upstreamError(response.status,await this.readBody(response),this.requestId(response));
        if (['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused'].includes(error.code)) {
          this.clearTokens(active); await this.save();
        }
        throw this.remember(error);
      }
      const tokens = TokensSchema.safeParse(await response.json());
      if (!tokens.success || !tokens.data.refresh_token) throw new IntegrationError(502,'REFRESH_RESPONSE_INVALID','ChatGPT 续期响应缺少轮换凭据，原凭据已保留。');
      if (epoch !== this.generation) throw new IntegrationError(409,'AUTH_CHANGED','连接已更改，请重新发起操作。');
      if (tokens.data.id_token) {
        const identity = await this.verifyIdentity(tokens.data.id_token,active.clientId);
        if (identity.sub !== active.subject) throw new IntegrationError(400,'OAUTH_ACCOUNT_MISMATCH','续期身份与当前 ChatGPT 账号不一致。');
      }
      active.accessToken = tokens.data.access_token; active.refreshToken = tokens.data.refresh_token;
      if (tokens.data.id_token) active.idToken = tokens.data.id_token;
      if (tokens.data.scope !== undefined) active.scopes = tokens.data.scope.split(/\s+/).filter(Boolean);
      active.expiresAt = this.now()+tokens.data.expires_in*1000; active.earliestRefreshAt = this.refreshTime(tokens.data.earliest_refresh_at);
      await this.save();
      if (!this.status().planAuthorized) throw new IntegrationError(403,'CHATGPT_PLAN_NOT_AUTHORIZED','续期后的授权不包含 ChatGPT 套餐权限，请重新授权。');
      return active.accessToken;
    } finally { await release(); }
  }
  private async lock():Promise<() => Promise<void>> {
    const path = join(this.credentialDir,'refresh.lock'); const expires = Date.now()+15000;
    while (true) {
      try { const handle = await open(path,'wx',0o600); await handle.writeFile(String(process.pid)); await handle.close(); return () => unlink(path).catch(() => {}); }
      catch(error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number(await readFile(path,'utf8').catch(() => '0'));
        if (owner > 0) {
          try { process.kill(owner,0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(path).catch(() => {}); continue; } }
        }
        if (Date.now() >= expires) throw new IntegrationError(409,'REFRESH_BUSY','另一进程正在续期 ChatGPT 凭据，请稍后重试。');
        await new Promise(resolve => setTimeout(resolve,100));
      }
    }
  }
  private clearTokens(active:Registration) { delete active.accessToken; delete active.refreshToken; delete active.idToken; delete active.expiresAt; delete active.earliestRefreshAt; active.scopes = []; }
  async acknowledgeWelcome() {
    await this.init();
    if (!this.status().planAuthorized) throw new IntegrationError(403,'CHATGPT_PLAN_NOT_AUTHORIZED','请先连接 ChatGPT 并授权使用套餐。');
    this.active()!.welcomeAcknowledged = true;
    await this.save();
    return {acknowledged:true};
  }
  async disconnect() {
    await this.init(); this.generation++; this.pending.clear();
    // Wait for a possibly rotating session, then revoke its latest refresh token.
    await this.refreshing?.catch(() => {});
    const release = await this.lock(); let remoteRevoked = true;
    try {
      this.store = StoreSchema.parse(JSON.parse(await readFile(this.path,'utf8')));
      const active = this.active();
      if (active?.refreshToken) {
        remoteRevoked = false;
        try {
          const discovery = await this.discovery();
          if (discovery.revocation_endpoint) {
            for (let attempt=0;attempt<2;attempt++) {
              const response = await this.request(discovery.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
                body:new URLSearchParams({token:active.refreshToken,token_type_hint:'refresh_token',client_id:active.clientId})});
              if (response.status === 200) { remoteRevoked = true; break; }
              if (response.status < 500) break;
              if (attempt===0) await new Promise(resolve => setTimeout(resolve,300));
            }
          }
        } catch { /* Local sign-out still completes; caller receives remoteRevoked=false. */ }
      }
      if (active) this.clearTokens(active);
      delete this.store.unverifiedClientId; this.lastError = null; await this.save();
      return {remoteRevoked,message:remoteRevoked ? '已退出 ChatGPT 连接，学习记录已保留。' : '已退出本地连接；未确认远端撤销，请在 ChatGPT 设置中断开此应用。'};
    } finally { await release(); }
  }
}

export function createAuthRouter(manager:AuthManager) {
  const router = Router();
  router.get('/status',async (_req,res) => {await manager.init();res.json(manager.status());});
  router.post('/start',async (req,res) => {
    const options = z.object({registrationId:z.string().optional(),newAccount:z.boolean().optional(),enablePlan:z.boolean().optional()}).strict().parse(req.body || {});
    res.json(await manager.start(options));
  });
  router.get('/authorize',(req,res) => res.redirect(302,manager.authorizationUrl(z.string().parse(req.query.attempt))));
  router.post('/disconnect',async (_req,res) => res.json(await manager.disconnect()));
  router.post('/acknowledge-welcome',async (_req,res) => res.json(await manager.acknowledgeWelcome()));
  return router;
}
