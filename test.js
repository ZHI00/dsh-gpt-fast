import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.js';

test('插件命令、认证路由和请求处理中间件共享全局状态', async (t) => {
  let command;
  let middleware;
  const routes = new Map();
  const cleanups = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); return new Response('synthetic'); };
  const scope = {
    commands: { register(value) { command = value; return () => {}; } },
    connection: { fetch: { register(value) { routes.set(value.path, value); return () => {}; } } },
    on(event, fn, options) { assert.equal(event, 'llm/stream'); assert.deepEqual(options, { global: true }); middleware = fn; return () => {}; },
    effect(fn) { cleanups.push(fn()); }
  };
  const ctx = { inject(_names, fn) { fn(scope); } };
  apply(ctx, { provider: 'provider-test', baseURL: 'https://example.invalid/v1', models: ['gpt-test'] });
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup?.(); globalThis.fetch = originalFetch; });
  const get = routes.get('/api/dsh-gpt-fast/status');
  const set = routes.get('/api/dsh-gpt-fast/enabled');
  assert.deepEqual(get.methods, ['GET']);
  assert.deepEqual(set.methods, ['POST']);
  assert.equal(set.requestBody, 'streaming');
  const request = (body, type = 'application/json') => new Request('http://localhost/api/dsh-gpt-fast/enabled', { method: 'POST', headers: { 'content-type': type }, body });
  const makeCall = async () => {
    const options = { provider: 'provider-test', model: 'gpt-test' };
    const stream = middleware(options, () => (async function* () {
      yield await fetch('https://example.invalid/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-test' }) });
    })());
    for await (const _ of stream) { /* consume synthetic response */ }
  };
  assert.match(command.handler({ rawInput: 'status' }).text, /已关闭/);
  assert.equal((await (await get.fetch()).json()).enabled, false);
  await makeCall();
  assert.equal(JSON.parse(calls.at(-1)[1].body).service_tier, undefined);
  assert.equal((await set.fetch(request('{"enabled":true}'))).status, 200);
  assert.match(command.handler({ rawInput: 'status' }).text, /已开启/);
  await makeCall();
  assert.equal(JSON.parse(calls.at(-1)[1].body).service_tier, 'priority');
  assert.equal((await (await get.fetch()).json()).injections, 1);
  assert.match(command.handler({ rawInput: 'off' }).text, /已关闭/);
  assert.equal((await (await get.fetch()).json()).enabled, false);
  assert.equal((await set.fetch(request('{"enabled":"true"}'))).status, 400);
  assert.equal((await set.fetch(request('{"enabled":true,"extra":1}'))).status, 400);
  assert.equal((await set.fetch(request('broken'))).status, 400);
  assert.equal((await set.fetch(request('x'.repeat(1025)))).status, 413);
  assert.equal((await set.fetch(request('{"enabled":true}', 'text/plain'))).status, 415);
  assert.equal(command.handler({ rawInput: 'other' }).kind, 'error');
});

test('配置缺失时无法启用 Fast', async () => {
  const routes = new Map();
  const scope = { effect(fn) { fn(); }, commands: { register() { return () => {}; } }, connection: { fetch: { register(value) { routes.set(value.path, value); return () => {}; } } } };
  apply({ inject(_names, fn) { fn(scope); } }, {});
  const result = await routes.get('/api/dsh-gpt-fast/enabled').fetch(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' }));
  assert.equal(result.status, 503);
  assert.equal((await result.json()).ready, false);
});
