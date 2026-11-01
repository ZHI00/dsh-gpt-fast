import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from './index.js';

const modules = process.env.DSH_ASAR_NODE_MODULES;

test('已安装 DSH Responses 适配器与 Fast 拦截集成', { skip: !modules && 'Set DSH_ASAR_NODE_MODULES and run under Electron Node' }, async (t) => {
  const load = (path) => import(pathToFileURL(join(modules, path)).href);
  const { PiAiAdapter } = await load('@deepseek-ai/dsh-llm-pi-ai/lib/index.js');
  const { Context } = await load('@deepseek-ai/cordis/lib/index.js');
  const { LlmRuntime } = await load('@deepseek-ai/dsh-llm/lib/index.js');
  const { CommandRuntime } = await load('@deepseek-ai/dsh-commands/lib/index.js');
  const { openAIResponsesApi } = await load('@earendil-works/pi-ai/dist/api/openai-responses.lazy.js');
  const api = openAIResponsesApi();
  const model = { id: 'test-model', name: 'Test', api: 'openai-responses', provider: 'test-provider', baseUrl: 'https://test.invalid/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 512 };
  const piProvider = { id: model.provider, name: 'Test', auth: { apiKey: { resolve: async ({ credential }) => ({ auth: { apiKey: credential.key } }) } }, getModels: () => [model], stream: (...x) => api.stream(...x), streamSimple: (...x) => api.streamSimple(...x) };
  const profile = { piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 10000 };
  const profiles = new Map([[model.provider, profile]]);
  const originalFetch = globalThis.fetch;
  const tiers = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://test.invalid/v1/responses');
    assert.equal(init.method, 'POST');
    tiers.push(JSON.parse(init.body).service_tier ?? null);
    const item = { id: 'item_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'resp_test' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'item_test', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'item_test', delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const fakeFetch = globalThis.fetch;
  const ctx = new Context();
  new LlmRuntime(ctx);
  new CommandRuntime(ctx);
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-only', auth: {} });
  ctx.llm.registerAdapter([model.provider], adapter);
  const fiber = ctx.plugin(plugin, { provider: model.provider, models: [model.id], baseURL: model.baseUrl });
  await fiber;
  t.after(async () => { await fiber.dispose(); globalThis.fetch = originalFetch; });
  const agent = { session: { append() {} } };
  const command = async (action) => {
    const result = await ctx.commands.execute(agent, `/gpt-fast ${action}`, [], new AbortController().signal);
    assert.equal(result?.result.kind, 'success');
  };
  const options = { provider: model.provider, model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] };
  async function run() {
    const chunks = [];
    for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk);
    assert.equal(chunks.find((chunk) => chunk.type === 'text-delta')?.text, 'ok');
    assert.equal(chunks.find((chunk) => chunk.type === 'finish')?.reason?.kind, 'stop');
  }
  await run();
  await command('on');
  await run();
  await command('off');
  await run();
  assert.deepEqual(tiers, [null, 'priority', null]);
  await fiber.dispose();
  assert.equal(globalThis.fetch, fakeFetch);
});
