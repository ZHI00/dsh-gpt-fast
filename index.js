import { createInterceptor } from './intercept.js';
import { createStatusHandler, createEnabledHandler } from './control.js';

export const name = 'dsh-gpt-fast-local';

export function apply(ctx, config = {}) {
  let active = false;
  let enabled = false;
  let injections = 0;
  let skipped = 0;
  let failure = '';

  const configured = config.provider && config.baseURL && Array.isArray(config.models) && config.models.length;
  if (!configured) failure = 'Fast 未配置：请设置供应商、HTTPS 地址和精确模型名。';

  if (configured) {
    ctx.inject?.(['llm'], (scope) => {
      scope.effect(() => {
        let interceptor;
        try {
          interceptor = createInterceptor({
            provider: config.provider,
            baseURL: config.baseURL,
            models: config.models,
            isEnabled: () => enabled,
            onInject: () => { injections++; },
            onSkip: ({ reason }) => { if (!['disabled', 'method', 'model-mismatch', 'already-priority'].includes(reason)) skipped++; }
          });
          interceptor.installFetch();
          const off = scope.on('llm/stream', interceptor.middleware, { global: true });
          failure = '';
          active = true;
          return () => {
            active = false;
            enabled = false;
            off();
            interceptor.dispose();
          };
        } catch {
          interceptor?.dispose();
          failure = 'Fast 初始化失败，请检查供应商、HTTPS 地址、模型和 DSH 兼容性。';
          return () => {};
        }
      }, 'gpt-fast: scoped request interceptor');
    });
  }

  function status() {
    const error = failure || (!active ? 'Fast 请求处理尚未就绪。' : '');
    return {
      ready: !error,
      enabled,
      injections,
      skipped,
      models: Array.isArray(config.models) ? config.models : [],
      error
    };
  }

  function setEnabled(value) {
    if (!status().ready) return false;
    enabled = value === true;
    return true;
  }

  ctx.inject?.(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'gpt-fast',
      description: '控制 GPT Fast 请求参数（默认关闭）',
      input: { hint: 'on | off | status' },
      handler: ({ rawInput = '' }) => {
        const action = rawInput.trim().toLowerCase() || 'status';
        if (!['on', 'off', 'status'].includes(action)) return { kind: 'error', text: '用法：/gpt-fast on、off 或 status' };
        const before = status();
        if (!before.ready) return { kind: 'error', text: `Fast 不可用：${before.error}` };
        if (action === 'on') setEnabled(true);
        if (action === 'off') setEnabled(false);
        const current = status();
        return { kind: 'success', text: `Fast ${current.enabled ? '已开启' : '已关闭'}；注入次数：${current.injections}；未处理次数：${current.skipped}。实际覆盖范围及上游服务等级需另行验证。` };
      }
    }), 'gpt-fast: command');
  });

  ctx.inject?.(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dsh-gpt-fast/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: createStatusHandler(status)
    }), 'gpt-fast: authenticated status');
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dsh-gpt-fast/enabled',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: createEnabledHandler(status, setEnabled)
    }), 'gpt-fast: authenticated control');
  });
}
