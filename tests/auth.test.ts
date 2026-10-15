import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {AuthManager, IntegrationError} from '../server/auth.ts';

const issuer = 'https://auth.openai.com';
const clientId = 'oaiapp_mock_personal_japanese';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const signing = await generateKeyPair('ES256');
const publicKey = await exportJWK(signing.publicKey);
publicKey.kid = 'oauth-test-key'; publicKey.alg = 'ES256'; publicKey.use = 'sig';
type IdentityChanges = {issuer?:string;audience?:string;nonce?:string;subject?:string;expiresAt?:number;badSignature?:boolean};
type NetworkCall = {url:string;init:RequestInit;form:URLSearchParams};

async function fixture(t:TestContext) {
  const directory = await mkdtemp(join(tmpdir(),'japanese-oauth-'));
  t.after(async () => {
    // Only remove the named test directory generated inside the system temp root.
    const absolute = resolve(directory); const tempRoot = resolve(tmpdir());
    assert.ok(absolute.startsWith(tempRoot + (process.platform === 'win32' ? '\\' : '/')));
    assert.ok(absolute.slice(tempRoot.length+1).startsWith('japanese-oauth-'));
    await rm(absolute,{recursive:true,force:true});
  });
  let time = Date.now();
  let currentNonce = '';
  let identityChanges:IdentityChanges = {};
  let grantedScopes = scopes;
  let refreshResponse:() => Response|Promise<Response> = () => Response.json({access_token:'mock-access-rotated',refresh_token:'mock-refresh-rotated',token_type:'Bearer',expires_in:3600});
  let codeGate:Promise<void>|undefined;
  let revocationStatus = 200;
  const calls:NetworkCall[] = [];
  const sign = async () => {
    const seconds = Math.floor(time/1000);
    const privateKey = identityChanges.badSignature ? (await generateKeyPair('ES256')).privateKey : signing.privateKey;
    return new SignJWT({nonce:identityChanges.nonce ?? currentNonce,email:'student@example.invalid',name:'日语学习者'})
      .setProtectedHeader({alg:'ES256',kid:'oauth-test-key'})
      .setIssuer(identityChanges.issuer ?? issuer).setAudience(identityChanges.audience ?? clientId)
      .setSubject(identityChanges.subject ?? 'verified-subject').setIssuedAt(seconds)
      .setExpirationTime(identityChanges.expiresAt ?? seconds+3600).sign(privateKey);
  };
  const network:typeof fetch = async (input,init = {}) => {
    const url = String(input); const form = new URLSearchParams(String(init.body || ''));
    calls.push({url,init,form});
    if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({issuer,
      authorization_endpoint:`${issuer}/api/accounts/authorize`,token_endpoint:`${issuer}/api/accounts/oauth/token`,
      jwks_uri:`${issuer}/.well-known/jwks.json`,revocation_endpoint:`${issuer}/mock-revocation`});
    if (url === `${issuer}/.well-known/jwks.json`) return Response.json({keys:[publicKey]});
    if (url === `${issuer}/mock-revocation`) return new Response(null,{status:revocationStatus});
    assert.equal(url,`${issuer}/api/accounts/oauth/token`);
    if (form.get('grant_type') === 'refresh_token') return refreshResponse();
    assert.equal(form.get('grant_type'),'authorization_code');
    if (codeGate) await codeGate;
    return Response.json({access_token:'mock-access-original',refresh_token:'mock-refresh-original',id_token:await sign(),
      token_type:'Bearer',expires_in:3600,scope:grantedScopes});
  };
  const options = {credentialDir:directory,redirectUri:'http://127.0.0.1:43210/auth/callback',fetch:network,now:() => time};
  const manager = new AuthManager(options);
  const begin = async (settings:Parameters<AuthManager['start']>[0] = {}) => {
    const local = await manager.start(settings);
    const attempt = new URL(local.url,'http://127.0.0.1:43210').searchParams.get('attempt')!;
    const authorization = new URL(manager.authorizationUrl(attempt));
    currentNonce = authorization.searchParams.get('nonce')!;
    return {local,authorization,attempt};
  };
  const parameters = (authorization:URL,overrides:Record<string,string> = {}) => new URLSearchParams({
    state:authorization.searchParams.get('state')!,code:'mock-one-time-code',client_id:clientId,...overrides,
  });
  const connect = async () => {const attempt=await begin();await manager.callback(parameters(attempt.authorization));return attempt;};
  return {manager,begin,parameters,connect,calls,directory,options,
    tokenCalls:() => calls.filter(x => x.url.endsWith('/oauth/token')),
    refreshCalls:() => calls.filter(x => x.form.get('grant_type') === 'refresh_token'),
    advance:(milliseconds:number) => {time += milliseconds;},
    changeIdentity:(changes:IdentityChanges) => {identityChanges = changes;},
    grant:(value:string) => {grantedScopes = value;},
    changeRefresh:(handler:() => Response|Promise<Response>) => {refreshResponse = handler;},
    delayCode:(gate:Promise<void>) => {codeGate = gate;},
    changeRevocation:(status:number) => {revocationStatus = status;},
    persisted:async () => JSON.parse(await readFile(join(directory,'connections.json'),'utf8')),
  };
}

test('first registration uses official scopes, fresh PKCE and exact loopback URI with the issued client at exchange',async t => {
  const f=await fixture(t);const first=await f.begin();const p=first.authorization.searchParams;
  assert.equal(first.authorization.origin,issuer);assert.equal(first.authorization.pathname,'/api/accounts/authorize');
  assert.equal(p.get('client_id'),'dynamic_agent_client');assert.ok(p.get('agent_name_hint'));
  assert.equal(p.get('redirect_uri'),f.options.redirectUri);assert.equal(p.get('resource'),resource);
  assert.equal(p.get('scope'),scopes);assert.equal(p.get('code_challenge_method'),'S256');
  assert.equal(p.get('response_type'),'code');assert.match(p.get('ext_agent_host_id')!,/^urn:uuid:/);
  assert.ok(!/id_token|access_token|refresh_token/.test(first.local.url));
  await f.manager.callback(f.parameters(first.authorization));
  const exchange=f.tokenCalls()[0];assert.equal(exchange.init.method,'POST');
  assert.equal(new Headers(exchange.init.headers).get('Content-Type'),'application/x-www-form-urlencoded');
  assert.equal(exchange.form.get('client_id'),clientId);assert.equal(exchange.form.get('redirect_uri'),p.get('redirect_uri'));
  assert.equal(exchange.form.get('resource'),resource);assert.equal(exchange.form.has('client_secret'),false);
  assert.equal(createHash('sha256').update(exchange.form.get('code_verifier')!).digest('base64url'),p.get('code_challenge'));
  assert.equal(f.manager.status().connected,true);assert.equal(f.manager.status().planAuthorized,true);
  assert.equal(f.manager.status().account?.sub,'verified-subject');
  const returning=await f.begin();
  assert.notEqual(returning.authorization.searchParams.get('state'),p.get('state'));
  assert.notEqual(returning.authorization.searchParams.get('nonce'),p.get('nonce'));
  assert.notEqual(returning.authorization.searchParams.get('code_challenge'),p.get('code_challenge'));
});

test('missing, mismatched, multibyte, duplicate and expired states never exchange an authorization code',async t => {
  const f=await fixture(t);const attempt=await f.begin();
  for(const state of ['', 'wrong-state', 'é'.repeat(attempt.authorization.searchParams.get('state')!.length)]) {
    await assert.rejects(f.manager.callback(f.parameters(attempt.authorization,{state})),{code:'OAUTH_STATE_INVALID'});
  }
  const duplicate=f.parameters(attempt.authorization);duplicate.append('state',attempt.authorization.searchParams.get('state')!);
  await assert.rejects(f.manager.callback(duplicate),{code:'OAUTH_CALLBACK_INVALID'});
  const expired=await f.begin();f.advance(10*60*1000+1);
  await assert.rejects(f.manager.callback(f.parameters(expired.authorization)),{code:'OAUTH_STATE_INVALID'});
  assert.equal(f.tokenCalls().length,0);
});

test('callback and local authorization redirects are consumed once and consent denial does not exchange a code',async t => {
  const f=await fixture(t);const a=await f.begin();
  assert.throws(() => f.manager.authorizationUrl(a.attempt),{code:'AUTH_ATTEMPT_INVALID'});
  const denied=f.parameters(a.authorization,{error:'access_denied'});
  await assert.rejects(f.manager.callback(denied),{code:'access_denied'});
  await assert.rejects(f.manager.callback(denied),{code:'OAUTH_STATE_INVALID'});
  assert.equal(f.tokenCalls().length,0);
  const connected=await f.connect();
  await assert.rejects(f.manager.callback(f.parameters(connected.authorization)),{code:'OAUTH_STATE_INVALID'});
  assert.equal(f.tokenCalls().length,1);
});

test('new registration requires a real client ID and returning callbacks cannot change that ID',async t => {
  const f=await fixture(t);const a=await f.begin();
  const missing=f.parameters(a.authorization);missing.delete('client_id');
  await assert.rejects(f.manager.callback(missing),{code:'OAUTH_CLIENT_MISSING'});
  await f.connect();const returning=await f.begin();
  await assert.rejects(f.manager.callback(f.parameters(returning.authorization,{client_id:'another-client'})),{code:'OAUTH_CLIENT_MISMATCH'});
  assert.equal(f.manager.status().connected,true);assert.equal(f.tokenCalls().length,1);
});

test('ID token signature, nonce, audience, issuer and expiry are independently verified',async t => {
  const examples:Record<string,IdentityChanges>={
    signature:{badSignature:true},nonce:{nonce:'not-the-original-nonce'},audience:{audience:'other-client'},
    issuer:{issuer:'https://untrusted.example.invalid'},expired:{expiresAt:1},
  };
  for(const [name,changes] of Object.entries(examples)) await t.test(name,async sub => {
    const f=await fixture(sub);f.changeIdentity(changes);const a=await f.begin();
    await assert.rejects(f.manager.callback(f.parameters(a.authorization)),{code:'OAUTH_ID_TOKEN_INVALID'});
    assert.equal(f.manager.status().connected,false);assert.equal(f.manager.status().account,null);
    assert.equal((await f.persisted()).registrations.length,0);
  });
});

test('verified identity without plan permission remains signed in and cannot provide an inference credential',async t => {
  const f=await fixture(t);f.grant('openid profile email offline_access');await f.connect();
  assert.equal(f.manager.status().connected,true);assert.equal(f.manager.status().planAuthorized,false);
  const count=f.calls.length;
  await assert.rejects(f.manager.getAccessToken(),{code:'CHATGPT_PLAN_NOT_AUTHORIZED',status:403});
  assert.equal(f.calls.length,count);
  const a=await f.begin({enablePlan:true});assert.equal(a.authorization.searchParams.get('client_id'),clientId);
  assert.equal(a.authorization.searchParams.get('prompt'),'consent');assert.equal(a.authorization.searchParams.get('scope'),scopes);
});

test('host, issued client and identity survive restart and signed-out reauthorization reuses mapping without token hints',async t => {
  const f=await fixture(t);const initial=await f.connect();const host=initial.authorization.searchParams.get('ext_agent_host_id');
  const restart=new AuthManager(f.options);await restart.init();assert.equal(restart.status().connected,true);
  const local=await restart.start();assert.ok(!local.url.includes('mock-access-original'));
  const attempt=new URL(local.url,'http://127.0.0.1').searchParams.get('attempt')!;
  const authorization=new URL(restart.authorizationUrl(attempt));
  assert.equal(authorization.searchParams.get('client_id'),clientId);assert.equal(authorization.searchParams.get('ext_agent_host_id'),host);
  assert.equal(authorization.searchParams.has('agent_name_hint'),false);assert.ok(authorization.searchParams.get('id_token_hint'));
  await restart.disconnect();assert.equal(restart.status().connected,false);
  const after=await restart.start();const afterId=new URL(after.url,'http://127.0.0.1').searchParams.get('attempt')!;
  const afterUrl=new URL(restart.authorizationUrl(afterId));
  assert.equal(afterUrl.searchParams.get('client_id'),clientId);assert.equal(afterUrl.searchParams.get('ext_agent_host_id'),host);
  assert.equal(afterUrl.searchParams.has('id_token_hint'),false);assert.equal((await f.persisted()).registrations.length,1);
});

test('safe connection status and errors never contain access, refresh, retained ID tokens or host/client credentials',async t => {
  const f=await fixture(t);await f.connect();const stored=await f.persisted();const reg=stored.registrations[0];
  const serialized=JSON.stringify(f.manager.status());
  for(const secret of [reg.accessToken,reg.refreshToken,reg.idToken,reg.clientId,stored.hostId]) assert.ok(!serialized.includes(secret));
  assert.ok(!/accessToken|refreshToken|idToken|access_token|refresh_token|id_token/.test(serialized));
  f.advance(3600000);f.changeRefresh(() => Response.json({error:{code:'invalid_grant',message:'refresh_token mock-refresh-original'}},{status:400,headers:{'x-request-id':'test-invalid-grant'}}));
  await assert.rejects(f.manager.getAccessToken(),(error:unknown) => {
    assert.ok(error instanceof IntegrationError);assert.equal(error.code,'invalid_grant');
    assert.equal(error.diagnostics.requestId,'test-invalid-grant');assert.ok(!JSON.stringify(error).includes('mock-refresh-original'));return true;
  });
  assert.ok(!JSON.stringify(f.manager.status()).includes('mock-refresh-original'));
});

test('concurrent expiry checks perform one refresh, rotate atomically and persist the latest credentials',async t => {
  const f=await fixture(t);await f.connect();f.advance(3600000);
  const values=await Promise.all(Array.from({length:12},() => f.manager.getAccessToken()));
  assert.deepEqual(new Set(values),new Set(['mock-access-rotated']));assert.equal(f.refreshCalls().length,1);
  const exchange=f.refreshCalls()[0];assert.equal(exchange.form.get('client_id'),clientId);
  assert.equal(exchange.form.get('refresh_token'),'mock-refresh-original');assert.equal(exchange.form.get('resource'),resource);
  assert.equal(exchange.form.has('scope'),false);const stored=await f.persisted();
  assert.equal(stored.registrations[0].accessToken,'mock-access-rotated');assert.equal(stored.registrations[0].refreshToken,'mock-refresh-rotated');
  const restart=new AuthManager(f.options);await restart.init();assert.equal(await restart.getAccessToken(),'mock-access-rotated');
  assert.equal(f.refreshCalls().length,1);
});

test('terminal invalid_grant clears unusable tokens while retaining real client and host for reauthorization',async t => {
  const f=await fixture(t);const initial=await f.connect();f.advance(3600000);
  f.changeRefresh(() => Response.json({error:'invalid_grant'},{status:400}));
  await assert.rejects(f.manager.getAccessToken(),{code:'invalid_grant'});
  assert.equal(f.manager.status().connected,false);const stored=await f.persisted();
  assert.equal(stored.registrations[0].clientId,clientId);
  assert.equal(stored.registrations[0].accessToken,undefined);assert.equal(stored.registrations[0].refreshToken,undefined);assert.equal(stored.registrations[0].idToken,undefined);
  const returning=await f.begin();assert.equal(returning.authorization.searchParams.get('client_id'),clientId);
  assert.equal(returning.authorization.searchParams.get('ext_agent_host_id'),initial.authorization.searchParams.get('ext_agent_host_id'));
});

test('temporary refresh failure preserves credentials and does not endlessly retry',async t => {
  const f=await fixture(t);await f.connect();f.advance(3600000);
  f.changeRefresh(() => Response.json({detail:'Temporary authentication service outage'},{status:503}));
  await assert.rejects(f.manager.getAccessToken(),{code:'OPENAI_HTTP_503',status:503});assert.equal(f.refreshCalls().length,1);
  assert.equal(f.manager.status().connected,true);assert.equal((await f.persisted()).registrations[0].refreshToken,'mock-refresh-original');
});

test('refresh network and invalid JSON failures retain safe stage metadata and preserve the existing credential',async t => {
  const f=await fixture(t);await f.connect();f.advance(3600000);
  f.changeRefresh(() => {throw new TypeError('fetch failed',{cause:Object.assign(new Error('connect ETIMEDOUT auth.openai.com'),{code:'ETIMEDOUT'})});});
  await assert.rejects(f.manager.getAccessToken(),(error:unknown) => {
    assert.ok(error instanceof IntegrationError);assert.equal(error.code,'OPENAI_NETWORK_ERROR');
    assert.equal(error.diagnostics.stage,'oauth-token-refresh');assert.equal(error.diagnostics.networkCode,'ETIMEDOUT');
    assert.equal(error.diagnostics.upstreamStatus,undefined);return true;
  });
  f.changeRefresh(() => new Response(JSON.stringify({access_token:'mock-sensitive-invalid-json'}).slice(0,-1)+',',{
    headers:{'Content-Type':'application/json','x-request-id':'refresh-invalid-json-request'},
  }));
  await assert.rejects(f.manager.getAccessToken(),(error:unknown) => {
    assert.ok(error instanceof IntegrationError);assert.equal(error.code,'REFRESH_RESPONSE_INVALID');
    assert.equal(error.diagnostics.upstreamStatus,200);assert.equal(error.diagnostics.stage,'oauth-token-refresh');
    assert.equal(error.diagnostics.requestId,'refresh-invalid-json-request');assert.equal(error.diagnostics.reason,'invalid_json');
    assert.ok(!JSON.stringify(error).includes('mock-sensitive-invalid-json'));return true;
  });
  assert.equal(f.manager.status().connected,true);
  assert.equal((await f.persisted()).registrations[0].refreshToken,'mock-refresh-original');
  assert.equal(f.manager.status().lastError?.requestId,'refresh-invalid-json-request');
});

test('returning authorization refuses another identity and preserves the original connection',async t => {
  const f=await fixture(t);await f.connect();f.changeIdentity({subject:'different-subject'});const a=await f.begin();
  await assert.rejects(f.manager.callback(f.parameters(a.authorization)),{code:'OAUTH_ACCOUNT_MISMATCH'});
  assert.equal(f.manager.status().account?.sub,'verified-subject');assert.equal(f.manager.status().connected,true);
});

test('disconnect revokes latest refresh credentials, keeps mapping, and reports unconfirmed remote revocation',async t => {
  const f=await fixture(t);await f.connect();f.advance(3600000);await f.manager.getAccessToken();
  const outcome=await f.manager.disconnect();assert.equal(outcome.remoteRevoked,true);assert.equal(f.manager.status().connected,false);
  const request=f.calls.find(x => x.url.endsWith('/mock-revocation'))!;
  assert.equal(request.form.get('token'),'mock-refresh-rotated');assert.equal(request.form.get('token_type_hint'),'refresh_token');assert.equal(request.form.get('client_id'),clientId);
  assert.equal((await f.persisted()).registrations.length,1);
  await f.connect();f.changeRevocation(503);const unconfirmed=await f.manager.disconnect();
  assert.equal(unconfirmed.remoteRevoked,false);assert.equal(f.manager.status().connected,false);assert.match(unconfirmed.message,/未确认/);
});

test('disconnect during a delayed callback prevents credentials being restored by that obsolete attempt',async t => {
  const f=await fixture(t);let release!:() => void;f.delayCode(new Promise<void>(resolve => {release=resolve;}));
  const a=await f.begin();const callback=f.manager.callback(f.parameters(a.authorization));
  // Wait for the token exchange to start without relying on a large sleep.
  for(let i=0;i<100 && !f.tokenCalls().length;i++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(f.tokenCalls().length,1);await f.manager.disconnect();release();
  await assert.rejects(callback,{code:'AUTH_CHANGED'});assert.equal(f.manager.status().connected,false);
  const restart=new AuthManager(f.options);await restart.init();assert.equal(restart.status().connected,false);
});

test('welcome acknowledgment is persisted for each validated account and survives reauthorization',async t => {
  const f=await fixture(t);await f.connect();assert.equal(f.manager.status().welcomeNeeded,true);
  await f.manager.acknowledgeWelcome();assert.equal(f.manager.status().welcomeNeeded,false);
  const restart=new AuthManager(f.options);await restart.init();assert.equal(restart.status().welcomeNeeded,false);
  await f.connect();assert.equal(f.manager.status().welcomeNeeded,false);
  const newAccount=await f.begin({newAccount:true});assert.equal(newAccount.authorization.searchParams.get('client_id'),'dynamic_agent_client');
  await f.manager.callback(f.parameters(newAccount.authorization));assert.equal(f.manager.status().welcomeNeeded,true);
});
