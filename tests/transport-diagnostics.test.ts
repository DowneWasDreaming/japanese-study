import test from 'node:test';
import assert from 'node:assert/strict';
import {networkDiagnostics,safeDiagnosticText,upstreamError} from '../server/auth.ts';

test('official error messages preserve useful details while removing credentials and query parameters',() => {
  const error=upstreamError(400,{error:{code:'invalid_grant',message:'Token refresh failed: refresh_token mock-refresh-original. Bearer mock-bearer-secret. See https://auth.openai.com/error?code=private-code&state=private-state',detail:'Please authorize this application again.'}},'request-safe');
  const serialized=JSON.stringify(error);
  assert.equal(error.diagnostics.upstreamStatus,400);assert.equal(error.diagnostics.requestId,'request-safe');
  assert.ok(error.diagnostics.upstreamMessage!.includes('Please authorize this application again.'));
  for(const secret of ['mock-refresh-original','mock-bearer-secret','private-code','private-state']) assert.ok(!serialized.includes(secret),secret);
  assert.match(error.publicMessage,/官方提示/);
});

test('diagnostic sanitization limits text and ignores arbitrary object payloads',() => {
  assert.equal(safeDiagnosticText({access_token:'private-value'}),undefined);
  assert.equal(safeDiagnosticText('a'.repeat(9000))!.length,6000);
  const failure=new TypeError('fetch failed',{cause:Object.assign(new Error('connect timeout'),{code:'UND_ERR_CONNECT_TIMEOUT'})});
  const diagnostic=networkDiagnostics(failure,'oauth-token-refresh');
  assert.equal(diagnostic.networkCode,'UND_ERR_CONNECT_TIMEOUT');assert.equal(diagnostic.stage,'oauth-token-refresh');
  assert.equal(diagnostic.detail,'fetch failed → connect timeout');
  const cyclic:Record<string,unknown>={message:'aborted'};cyclic.cause=cyclic;
  assert.equal(networkDiagnostics(cyclic,'model-request').detail,'aborted');
});
