import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager, IntegrationError } from '../server/auth.js';
import { ModelService, type ModelMessage } from '../server/model.js';

const catalog = { models: [
  { slug: 'recommended-model', display_name: '推荐模型', visibility: 'list' },
  { slug: 'hidden-model', display_name: '隐藏模型', visibility: 'hidden' },
  { slug: 'alternate-model', display_name: '另一模型', visibility: 'list' },
  { slug: 'recommended-model', display_name: '重复条目', visibility: 'list' },
] };
const messages: ModelMessage[] = [
  { role: 'developer', content: '为中文母语者解释日语。' },
  { role: 'user', content: '「は」表示什么？' },
  { role: 'assistant', content: '它可以标记主题。' },
  { role: 'user', content: '请给我一个例句。' },
];
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = (text = '尚未完成的文本') => ({ type: 'response.output_text.delta', delta: text });
const completed = (text = '私は学生です。表示“我是学生”。') => ({
  type: 'response.completed', response: { status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text }] },
  ] },
});
const itemDone = (index = 0, text = '完成文本') => ({ type: 'response.output_item.done', output_index: index,
  item: { id: 'fake-message-' + index, type: 'message', role: 'assistant', status: 'completed', content: [{type:'output_text',text}] } });
const terminalWithoutItems = () => ({type:'response.completed',response:{status:'completed',output:[]}});
function sse(events: unknown[], chunkSize = 19): Response {
  const bytes = new TextEncoder().encode(events.map(event).join(''));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
    },
  }), { headers: { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'test-request' } });
}

type AuthState = { account: string | null; connected: boolean; planAuthorized: boolean };
type Captured = { url: string; init: RequestInit };
function fixture(t: TestContext, response: (request: Captured) => Response | Promise<Response> = () => sse([completed()])) {
  const directory = mkdtempSync(join(tmpdir(), 'japanese-model-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state: AuthState = { account: 'first-account', connected: true, planAuthorized: true };
  // This seam exercises ModelService's authorization boundary without credentials,
  // live OAuth, JWT verification, or an external request.
  const auth = {
    credentialDir: directory,
    accountKey: () => state.account,
    status: () => ({ connected: state.connected, planAuthorized: state.planAuthorized }),
    async getAccessToken() {
      if (!state.connected) throw new IntegrationError(401, 'CHATGPT_NOT_CONNECTED', '请先连接。');
      if (!state.planAuthorized) throw new IntegrationError(403, 'CHATGPT_PLAN_NOT_AUTHORIZED', '请先授权套餐。');
      return 'fake-transport-token';
    },
  } as unknown as AuthManager;
  const requests: Captured[] = [];
  const transport: typeof fetch = async (input, init = {}) => {
    const request = { url: String(input), init }; requests.push(request);
    if (request.url === 'https://api.openai.com/v1/models') return Response.json(catalog);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    return response(request);
  };
  const settingsFile = join(directory, 'model-selection.json');
  const service = new ModelService(auth, { fetch: transport, settingsFile });
  return { service, state, requests, auth, transport, settingsFile,
    inferenceRequests: () => requests.filter(r => r.url.endsWith('/responses')) };
}

test('missing identity or plan permission prevents every outbound model request', async t => {
  const f = fixture(t);
  f.state.planAuthorized = false;
  await assert.rejects(f.service.listModels(), { code: 'CHATGPT_PLAN_NOT_AUTHORIZED' });
  await assert.rejects(f.service.generate(messages), { code: 'CHATGPT_PLAN_NOT_AUTHORIZED' });
  f.state.connected = false;
  await assert.rejects(f.service.generate(messages), { code: 'CHATGPT_NOT_CONNECTED' });
  assert.equal(f.requests.length, 0);
});

test('official catalog preserves visible order, deduplicates slugs, and persists selection per account', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.service.listModels(), {
    models: [
      { id: 'recommended-model', name: '推荐模型' },
      { id: 'alternate-model', name: '另一模型' },
    ], selected: 'recommended-model',
  });
  await f.service.setModel('alternate-model');
  const restarted = new ModelService(f.auth, { fetch: f.transport, settingsFile: f.settingsFile });
  assert.equal((await restarted.listModels()).selected, 'alternate-model');
  f.state.account = 'second-account';
  assert.equal((await restarted.listModels()).selected, 'recommended-model');
  f.state.account = 'first-account';
  assert.equal((await restarted.listModels()).selected, 'alternate-model');
  await assert.rejects(restarted.setModel('hidden-model'), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(restarted.generate(messages, 'unlisted-model'), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(f.inferenceRequests().length, 0);
});

test('Responses request uses explicit history and documented plan fields; completed output survives fragmented UTF-8', async t => {
  const text = '「は」は話題を表します。私は学生です。';
  const f = fixture(t, () => sse([delta('this partial draft must not be the result'), completed(text)], 3));
  await f.service.listModels(); await f.service.setModel('alternate-model');
  assert.equal(await f.service.generate(messages), text);
  const request = f.inferenceRequests()[0];
  assert.equal(f.inferenceRequests().length, 1);
  assert.equal(request.init.method, 'POST'); assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get('Authorization'), 'Bearer fake-transport-token');
  assert.equal(headers.get('Accept'), 'text/event-stream');
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    model: 'alternate-model', input: messages, store: false, stream: true,
  });
});

test('a missing Content-Type accepts verified SSE framing through completed, even in one-byte chunks', async t => {
  const text = '日本語の練習を続けます。';
  const encoded = new TextEncoder().encode(': keepalive\r\n\r\n' + event(delta('部分内容')) + event(completed(text)));
  let offset = 0;
  const f = fixture(t, () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === encoded.length) {controller.close();return;}
      controller.enqueue(encoded.slice(offset, ++offset));
    },
  })));
  assert.equal(await f.service.generate(messages), text);
  assert.equal(f.inferenceRequests().length, 1);
});

test('missing Content-Type does not turn JSON, HTML, failed or interrupted output into success', async t => {
  const cases = [
    {name:'JSON',body:JSON.stringify(completed().response),code:'MODEL_STREAM_INVALID'},
    {name:'HTML',body:'<html>temporary gateway page</html>',code:'MODEL_STREAM_INVALID'},
    {name:'failed SSE',body:event(delta()) + event({type:'response.failed',response:{error:{code:'server_error'}}}),code:'server_error'},
    {name:'incomplete SSE',body:event(delta()) + event({type:'response.incomplete',response:{status:'incomplete'}}),code:'MODEL_RESPONSE_INCOMPLETE'},
    {name:'interrupted SSE',body:event(delta()),code:'MODEL_STREAM_INTERRUPTED'},
  ];
  for (const example of cases) await t.test(example.name, async sub => {
    const f = fixture(sub, () => new Response(new TextEncoder().encode(example.body)));
    await assert.rejects(f.service.generate(messages), {code:example.code});
    assert.equal(f.inferenceRequests().length, 1);
  });
});

test('empty terminal output uses completed message items in order, after overall completion only', async t => {
  for (const missingMime of [false,true]) await t.test(missingMime ? 'missing MIME' : 'SSE MIME', async sub => {
    const events = [delta('不使用这个部分文本'),itemDone(1,'後半。'),itemDone(0,'前半。'),itemDone(0,'前半。'),terminalWithoutItems()];
    const f = fixture(sub, () => missingMime ? new Response(new TextEncoder().encode(events.map(event).join(''))) : sse(events,3));
    assert.equal(await f.service.generate(messages), '前半。後半。');
    assert.equal(f.inferenceRequests().length, 1);
  });
});

test('completed item fallback refuses unfinished, conflicting, revoked or terminal-failed streams', async t => {
  const cases = [
    {name:'done item without terminal completion',events:[itemDone()],code:'MODEL_STREAM_INTERRUPTED'},
    {name:'text done alone',events:[{type:'response.output_text.done',text:'不接受单独文本结束'},terminalWithoutItems()],code:'MODEL_OUTPUT_INVALID'},
    {name:'unfinished item',events:[{...itemDone(),item:{...itemDone().item,status:'in_progress'}},terminalWithoutItems()],code:'MODEL_STREAM_INVALID'},
    {name:'non-assistant item',events:[{...itemDone(),item:{...itemDone().item,role:'user'}},terminalWithoutItems()],code:'MODEL_STREAM_INVALID'},
    {name:'conflicting item',events:[itemDone(),itemDone(0,'冲突文本'),terminalWithoutItems()],code:'MODEL_STREAM_INVALID'},
    {name:'failed terminal',events:[itemDone(),{type:'response.failed',response:{error:{code:'server_error'}}}],code:'server_error'},
    {name:'incomplete terminal',events:[itemDone(),{type:'response.incomplete',response:{status:'incomplete'}}],code:'MODEL_RESPONSE_INCOMPLETE'},
  ];
  for (const example of cases) await t.test(example.name, async sub => {
    const f = fixture(sub, () => sse(example.events));
    await assert.rejects(f.service.generate(messages), {code:example.code});
    assert.equal(f.inferenceRequests().length, 1);
  });
  await t.test('authorization changed after item done', async sub => {
    let revoke = () => {};
    const f = fixture(sub, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {controller.enqueue(new TextEncoder().encode(event(itemDone())));},
      pull(controller) {revoke();controller.enqueue(new TextEncoder().encode(event(terminalWithoutItems())));controller.close();},
    })));
    revoke = () => {f.state.planAuthorized=false;};
    await assert.rejects(f.service.generate(messages), {code:'AUTH_CHANGED'});
  });
});

test('failed, incomplete, interrupted, malformed and empty streams never return a partial draft or retry automatically', async t => {
  const cases: { name: string; response: () => Response; code: string }[] = [
    { name: 'failed after text', response: () => sse([delta(), { type: 'response.failed', response: { error: { code: 'server_error', message: 'Temporary failure' } } }]), code: 'server_error' },
    { name: 'incomplete after text', response: () => sse([delta(), { type: 'response.incomplete', response: { status: 'incomplete' } }]), code: 'MODEL_RESPONSE_INCOMPLETE' },
    { name: 'EOF after text', response: () => sse([delta()]), code: 'MODEL_STREAM_INTERRUPTED' },
    { name: 'invalid completion status', response: () => sse([delta(), { type: 'response.completed', response: { status: 'in_progress', output: [] } }]), code: 'MODEL_COMPLETION_INVALID' },
    { name: 'empty completed output', response: () => sse([delta(), { type: 'response.completed', response: { status: 'completed', output: [] } }]), code: 'MODEL_OUTPUT_INVALID' },
    { name: 'malformed event JSON', response: () => new Response(event(delta()) + 'data: {broken-json}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), code: 'MODEL_STREAM_INVALID' },
    { name: 'JSON instead of SSE', response: () => Response.json({ output_text: 'not a validated stream' }), code: 'MODEL_STREAM_INVALID' },
  ];
  for (const example of cases) await t.test(example.name, async sub => {
    const f = fixture(sub, example.response);
    await assert.rejects(f.service.generate(messages), { code: example.code });
    assert.equal(f.inferenceRequests().length, 1);
  });
});

test('transport disconnect after text rejects the response and preserves a safe diagnostic', async t => {
  const f = fixture(t, () => {
    let reads = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(event(delta())));
        else controller.error(new Error('transport disconnected with a private internal diagnostic'));
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await assert.rejects(f.service.generate(messages), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    assert.equal(error.code, 'MODEL_STREAM_INTERRUPTED');
    assert.ok(!error.publicMessage.includes('private internal diagnostic'));
    return true;
  });
  assert.equal(f.inferenceRequests().length, 1);
});

test('a connection change during streaming prevents completed text from being accepted', async t => {
  let revoke = () => {};
  const f = fixture(t, () => {
    let reads = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(event(delta())));
        else if (reads === 2) { revoke(); controller.enqueue(new TextEncoder().encode(event(completed()))); }
        else controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  revoke = () => { f.state.planAuthorized = false; };
  await assert.rejects(f.service.generate(messages), { code: 'AUTH_CHANGED' });
  assert.equal(f.inferenceRequests().length, 1);
});

test('usage failure after a text delta pauses inference until an explicit catalog refresh', async t => {
  let calls = 0;
  const f = fixture(t, () => ++calls === 1 ? sse([delta(), {
    type: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached',
  }]) : sse([completed('手动重试成功。')]));
  await assert.rejects(f.service.generate(messages), { code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
  await assert.rejects(f.service.generate(messages), { code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
  assert.equal(calls, 1, 'usage-paused requests must not repeatedly call the provider');
  await f.service.listModels();
  assert.equal(await f.service.generate(messages), '手动重试成功。');
  assert.equal(calls, 2);
});

test('HTTP usage failure uses the same pause rule and does not automatically retry', async t => {
  const f = fixture(t, () => Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 }));
  await assert.rejects(f.service.generate(messages), { code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
  await assert.rejects(f.service.generate(messages), { code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
  assert.equal(f.inferenceRequests().length, 1);
});
