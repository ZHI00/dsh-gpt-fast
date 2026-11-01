import { AsyncLocalStorage } from 'node:async_hooks';

// Notifications deliberately contain no request data, URLs, or error messages.
function notify(callback, reason) {
  try { callback?.({ reason }); } catch { /* Observers must not affect requests. */ }
}

function hasLossyNumbers(json) {
  // JSON.parse has already validated the input; strings must be skipped as whole tokens.
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const [token] of json.matchAll(tokens)) {
    if (token[0] !== '"' && JSON.stringify(Number(token)) !== token) return true;
  }
  return false;
}

export function createInterceptor({ provider, models, baseURL, isEnabled, onInject, onSkip }) {
  if (typeof provider !== 'string' || !provider || !Array.isArray(models) ||
      !models.length || models.some((model) => typeof model !== 'string' || !model) ||
      typeof isEnabled !== 'function') {
    throw new TypeError('Invalid interceptor configuration');
  }
  let base;
  try { base = new URL(baseURL); } catch { throw new TypeError('Invalid baseURL'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new TypeError('Invalid baseURL');
  }
  const root = base.pathname.replace(/\/+$/, '');
  const paths = new Set([`${root}/responses`, `${root}/chat/completions`]);
  const allowedModels = new Set(models);
  const storage = new AsyncLocalStorage();
  let wrapper;
  let previousFetch;
  let disposed = false;

  function middleware(options, next) {
    const model = options?.provider === provider && allowedModels.has(options?.model) ? options.model : null;
    const makeScope = () => model === null ? null : { active: true, model };
    const initialScope = makeScope();
    let iterable;
    try {
      iterable = storage.run(initialScope, () => next(options));
    } finally {
      if (initialScope) initialScope.active = false;
    }
    let firstIterator = true;
    return {
      [Symbol.asyncIterator]() {
        const scope = firstIterator ? initialScope : makeScope();
        firstIterator = false;
        let iterator;
        if (scope) scope.active = true;
        try {
          iterator = storage.run(scope, () => iterable[Symbol.asyncIterator]());
        } finally {
          if (scope) scope.active = false;
        }
        let closed = false;
        async function invoke(method, args) {
          if (scope && !closed) scope.active = true;
          try {
            const result = await storage.run(scope, () => {
              const fn = iterator[method];
              if (typeof fn !== 'function') {
                if (method === 'throw') throw args[0];
                if (method === 'return') return { done: true, value: args[0] };
                throw new TypeError('Iterator has no next method');
              }
              return Reflect.apply(fn, iterator, args);
            });
            if (result?.done || method === 'return') {
              if (scope) scope.active = false;
              closed = true;
            }
            return result;
          } catch (error) {
            if (scope) scope.active = false;
            closed = true;
            throw error;
          }
        }
        return {
          next(...args) { return invoke('next', args); },
          return(...args) { return invoke('return', args); },
          throw(...args) { return invoke('throw', args); },
          [Symbol.asyncIterator]() { return this; }
        };
      }
    };
  }

  function installFetch() {
    if (disposed) throw new Error('Interceptor is disposed');
    if (wrapper) return wrapper;
    if (typeof globalThis.fetch !== 'function') throw new TypeError('Global fetch is unavailable');
    previousFetch = globalThis.fetch;
    wrapper = function (...args) {
      const forward = () => Reflect.apply(previousFetch, this, args);
      const scope = storage.getStore();
      if (disposed || !scope?.active) return forward();

      const [input, init] = args;
      let url;
      try {
        const value = typeof input === 'string' || input instanceof URL ? input : input?.url;
        url = new URL(value);
      } catch { return forward(); }
      if (url.origin !== base.origin || !paths.has(url.pathname)) return forward();
      const skip = (reason) => { notify(onSkip, reason); return forward(); };
      const reject = (reason) => {
        notify(onSkip, reason);
        return Promise.reject(new Error(`Fast interceptor: ${reason}`));
      };
      const method = init?.method ?? (typeof input === 'object' ? input?.method : undefined) ?? 'GET';
      if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return skip('method');
      let enabled;
      try { enabled = isEnabled(); } catch { return reject('enabled-error'); }
      if (enabled !== true) return skip('disabled');
      if (url.username || url.password || [...url.searchParams.keys()].some((key) => /signature|credential|^x-amz-|^x-goog-|^sig$/i.test(key))) return reject('signed-request');
      if (!(typeof input === 'string' || input instanceof URL) || !init || typeof init !== 'object') return reject('unsupported-request');
      const originalBody = init.body;
      if (typeof originalBody !== 'string') return reject('unsupported-body');
      let body;
      try { body = JSON.parse(originalBody); } catch { return reject('invalid-json'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject('invalid-json');
      if (body.model !== scope.model) return skip('model-mismatch');
      if (Object.hasOwn(body, 'service_tier')) {
        if (body.service_tier === 'priority') return skip('already-priority');
        if (!['auto', 'default', 'flex', 'scale'].includes(body.service_tier)) return reject('service-tier-conflict');
      }
      if (hasLossyNumbers(originalBody)) return reject('numeric-precision');
      if (JSON.stringify(body) !== originalBody) return reject('non-canonical-json');
      const originalHeaders = init.headers;
      let headers;
      try { headers = new Headers(originalHeaders); } catch { return reject('invalid-headers'); }
      const authorization = headers.get('authorization');
      if ([...headers.keys()].some((key) => /signature|^x-amz-|^x-goog-|^content-md5$|^digest$|^content-digest$|^repr-digest$/i.test(key)) ||
          (authorization && !/^(bearer|basic)\s/i.test(authorization))) return reject('signed-request');
      const encoding = headers.get('content-encoding');
      if (encoding && encoding.trim().toLowerCase() !== 'identity') return reject('content-encoding');
      const contentType = headers.get('content-type');
      if (contentType && !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(contentType)) return reject('content-type');
      body.service_tier = 'priority';
      const descriptors = Object.getOwnPropertyDescriptors(init);
      descriptors.body = { value: JSON.stringify(body), writable: true, enumerable: true, configurable: true };
      if (originalHeaders != null) {
        headers.delete('content-length');
        descriptors.headers = { value: headers, writable: true, enumerable: true, configurable: true };
      }
      const updated = Object.create(Object.getPrototypeOf(init), descriptors);
      notify(onInject, 'injected');
      const modified = [...args];
      modified[1] = updated;
      return Reflect.apply(previousFetch, this, modified);
    };
    globalThis.fetch = wrapper;
    return wrapper;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (wrapper && globalThis.fetch === wrapper) globalThis.fetch = previousFetch;
  }

  return { middleware, installFetch, dispose };
}
