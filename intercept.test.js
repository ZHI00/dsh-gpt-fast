import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterceptor } from './intercept.js';

const baseURL = 'https://api.example.test/v1';
const endpoint = `${baseURL}/responses`;
const options = { provider: 'openai', model: 'gpt-test' };
const body = (extra = {}) => JSON.stringify({ model: 'gpt-test', ...extra });
const request = (extra = {}) => ({ method: 'POST', body: body(), ...extra });

function setup(t, config = {}, implementation = () => Promise.resolve('fake-response')) {
  const original = globalThis.fetch;
  const calls = [];
  const injected = [];
  const skipped = [];
  const fake = function (...args) { calls.push({ args, receiver: this }); return implementation(...args); };
  globalThis.fetch = fake;
  const interceptor = createInterceptor({ provider: 'openai', models: ['gpt-test'], baseURL,
    isEnabled: () => true, onInject: (event) => injected.push(event), onSkip: (event) => skipped.push(event), ...config });
  interceptor.installFetch();
  t.after(() => { interceptor.dispose(); globalThis.fetch = original; });
  return { interceptor, calls, injected, skipped, fake };
}

function stream(interceptor, fn, opts = options) {
  return interceptor.middleware(opts, () => (async function* () { yield await fn(); })())[Symbol.asyncIterator]();
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('lazy generator injects priority, preserves arguments and caller objects', async (t) => {
  const { interceptor, calls, injected } = setup(t);
  const signal = new AbortController().signal;
  const headers = { Authorization: 'Bearer fake-secret', 'Content-Type': 'application/json', 'Content-Length': '2', 'X-Test': 'ok' };
  const init = request({ headers, signal, body: body({ service_tier: 'default' }) });
  const iterator = stream(interceptor, () => fetch(endpoint, init));
  assert.equal(calls.length, 0);
  assert.deepEqual(await iterator.next(), { value: 'fake-response', done: false });
  assert.equal(calls.length, 1);
  const sent = calls[0].args[1];
  assert.notEqual(sent, init);
  assert.equal(sent.signal, signal);
  assert.deepEqual([...sent.headers], [['authorization', 'Bearer fake-secret'], ['content-type', 'application/json'], ['x-test', 'ok']]);
  assert.equal(headers['Content-Length'], '2');
  assert.equal(JSON.parse(init.body).service_tier, 'default');
  assert.equal(JSON.parse(sent.body).service_tier, 'priority');
  assert.deepEqual(injected, [{ reason: 'injected' }]);
  await iterator.next();
});

test('isolates concurrent provider and model scopes and masks nested non-target scope', async (t) => {
  const { interceptor, calls, injected } = setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const target = stream(interceptor, async () => { await gate; return fetch(endpoint, request()); });
  const otherProvider = stream(interceptor, async () => { await gate; return fetch(endpoint, request()); }, { ...options, provider: 'other' });
  const otherModel = stream(interceptor, async () => { await gate; return fetch(endpoint, request()); }, { ...options, model: 'other' });
  const pending = [target.next(), otherProvider.next(), otherModel.next()];
  release();
  await Promise.all(pending);
  assert.equal(calls.filter(({ args }) => JSON.parse(args[1].body).service_tier === 'priority').length, 1);
  const nested = stream(interceptor, () => stream(interceptor, () => fetch(endpoint, request()), { ...options, provider: 'other' }).next());
  await nested.next();
  assert.equal(JSON.parse(calls.at(-1).args[1].body).service_tier, undefined);
  assert.equal(injected.length, 1);
});

test('binds asynchronous work started synchronously by next and iterator setup', async (t) => {
  const { interceptor, calls } = setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const work = [];
  let nextCalled = false;
  const iterable = interceptor.middleware(options, (received) => {
    assert.equal(received, options);
    nextCalled = true;
    work.push(gate.then(() => fetch(endpoint, request())));
    return {
      [Symbol.asyncIterator]() {
        work.push(gate.then(() => fetch(endpoint, request())));
        return { async next() { await gate; return { value: 'ready', done: false }; } };
      }
    };
  });
  assert.equal(nextCalled, true);
  const iterator = iterable[Symbol.asyncIterator]();
  const pending = iterator.next();
  release();
  await Promise.all([...work, pending]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(JSON.parse(call.args[1].body).service_tier, 'priority');
  await iterator.return();
});

test('non-target setup and iterator construction mask an enclosing target scope', async (t) => {
  const { interceptor, calls } = setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const work = [];
  const outer = stream(interceptor, async () => {
    const iterable = interceptor.middleware({ ...options, provider: 'other' }, () => {
      work.push(gate.then(() => fetch(endpoint, request())));
      return { [Symbol.asyncIterator]() {
        work.push(gate.then(() => fetch(endpoint, request())));
        return { async next() { await gate; return { done: true }; } };
      } };
    });
    const pending = iterable[Symbol.asyncIterator]().next();
    release();
    await Promise.all([...work, pending]);
  });
  await outer.next();
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(JSON.parse(call.args[1].body).service_tier, undefined);
});

test('unconsumed and failed initialization do not leave active scopes', async (t) => {
  const { interceptor, calls } = setup(t);
  const work = [];
  const schedule = () => { work.push(Promise.resolve().then(() => fetch(endpoint, request()))); };
  const unused = interceptor.middleware(options, () => {
    schedule();
    return { [Symbol.asyncIterator]() { schedule(); return { next() { return { done: true }; } }; } };
  });
  unused[Symbol.asyncIterator]();
  const failure = new Error('initialization failure');
  assert.throws(() => interceptor.middleware(options, () => { schedule(); throw failure; }), (error) => error === failure);
  const broken = interceptor.middleware(options, () => ({
    [Symbol.asyncIterator]() { schedule(); throw failure; }
  }));
  assert.throws(() => broken[Symbol.asyncIterator](), (error) => error === failure);
  await Promise.all(work);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(JSON.parse(call.args[1].body).service_tier, undefined);
});

test('iterator method getter errors close the scope and preserve the error', async (t) => {
  const { interceptor, calls } = setup(t);
  let release;
  let work;
  const gate = new Promise((resolve) => { release = resolve; });
  const failure = new Error('getter failure');
  const iterator = interceptor.middleware(options, () => ({
    [Symbol.asyncIterator]() {
      work = gate.then(() => fetch(endpoint, request()));
      return { get next() { throw failure; } };
    }
  }))[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), (error) => error === failure);
  release();
  await work;
  assert.equal(JSON.parse(calls[0].args[1].body).service_tier, undefined);
});

test('reads enabled state at each request and preserves non-target requests', async (t) => {
  let enabled = false;
  const { interceptor, calls, skipped } = setup(t, { isEnabled: () => enabled });
  const init = request();
  const iterator = interceptor.middleware(options, () => (async function* () {
    yield await fetch(endpoint, init);
    enabled = true;
    yield await fetch(`${baseURL}/chat/completions?x=1`, init);
    for (const url of [`${baseURL}/responses/`, `${baseURL}/responses/extra`, 'https://other.example.test/v1/responses', 'http://api.example.test/v1/responses', 'https://api.example.test/v10/responses']) yield await fetch(url, init);
    yield await fetch(endpoint, request({ body: body({ model: 'other' }) }));
    yield await fetch(endpoint, request({ method: 'GET' }));
  })())[Symbol.asyncIterator]();
  while (!(await iterator.next()).done) {}
  assert.equal(calls[0].args[1], init);
  assert.equal(JSON.parse(calls[1].args[1].body).service_tier, 'priority');
  for (const call of calls.slice(2, 7)) assert.equal(call.args[1], init);
  assert.equal(JSON.parse(calls[7].args[1].body).service_tier, undefined);
  assert.equal(calls[8].args[1].method, 'GET');
  assert.deepEqual(skipped.map((v) => v.reason), ['disabled', 'model-mismatch', 'method']);
});

test('signed non-POST requests pass through with their original arguments', async (t) => {
  const { interceptor, calls, skipped } = setup(t);
  const url = `${endpoint}?X-Amz-Signature=fake-secret`;
  const init = { method: 'GET', headers: { 'X-Signature': 'fake-secret' } };
  await stream(interceptor, () => fetch(url, init)).next();
  const input = new Request(endpoint, { method: 'GET' });
  await stream(interceptor, () => fetch(input)).next();
  assert.equal(calls[0].args[0], url);
  assert.equal(calls[0].args[1], init);
  assert.equal(calls[1].args[0], input);
  assert.deepEqual(skipped, [{ reason: 'method' }, { reason: 'method' }]);
});

test('rejects unsafe target requests with secret-free diagnostics', async (t) => {
  const { interceptor, calls, skipped, injected } = setup(t);
  const cases = [
    [endpoint, request({ body: Buffer.from(body()) }), 'unsupported-body'],
    [endpoint, request({ body: '{fake-secret' }), 'invalid-json'],
    [endpoint, request({ body: '[]' }), 'invalid-json'],
    [endpoint, request({ body: body({ service_tier: { secret: 'fake-secret' } }) }), 'service-tier-conflict'],
    [endpoint, request({ headers: { 'Content-Encoding': 'gzip' } }), 'content-encoding'],
    [endpoint, request({ headers: { 'Content-Type': 'text/plain' } }), 'content-type'],
    [endpoint, request({ headers: { Authorization: 'AWS4-HMAC-SHA256 fake-secret' } }), 'signed-request'],
    [endpoint, request({ headers: { 'X-Signature': 'fake-secret' } }), 'signed-request'],
    [`${endpoint}?X-Amz-Signature=fake-secret`, request(), 'signed-request'],
    [new Request(endpoint, request()), undefined, 'unsupported-request'],
    [endpoint, request({ headers: [['bad\nheader', 'fake-secret']] }), 'invalid-headers']
  ];
  for (const [url, init, reason] of cases) {
    await assert.rejects(stream(interceptor, () => fetch(url, init)).next(), (error) => {
      assert.equal(error.message, `Fast interceptor: ${reason}`);
      return true;
    });
  }
  assert.equal(calls.length, 0);
  assert.equal(injected.length, 0);
  assert.deepEqual(skipped.map((item) => item.reason), cases.map((item) => item[2]));
  assert.doesNotMatch(JSON.stringify(skipped), /fake-secret/);
});

test('rejects non-round-tripping JSON number tokens without exposing values', async (t) => {
  const { interceptor, calls, injected, skipped } = setup(t);
  const numbers = ['-0', '9007199254740993', '1.00', '0.1234567890123456789', '1e0', '1e-07', '1E+21', '1e400'];
  for (const number of numbers) {
    const init = request({ body: `{"model":"gpt-test","message":"fake-secret","nested":[{"value":${number}}]}` });
    await assert.rejects(stream(interceptor, () => fetch(endpoint, init)).next(), (error) => {
      assert.equal(error.message, 'Fast interceptor: numeric-precision');
      return true;
    });
  }
  assert.deepEqual(skipped, numbers.map(() => ({ reason: 'numeric-precision' })));
  assert.equal(calls.length, 0);
  assert.equal(injected.length, 0);
  assert.doesNotMatch(JSON.stringify(skipped), /fake-secret|9007199254740993/);
});

test('accepts JSON.stringify numbers and ignores numbers inside escaped strings', async (t) => {
  const { interceptor, calls, injected } = setup(t);
  const values = [0, -1, 1.5, 0.000001, 1e-7, 1e21, 9007199254740992];
  const text = 'fake \\\"-0 9007199254740993 1.00 1e-07\\\" with \\\\ backslash';
  const original = { model: 'gpt-test', text, 'key 9007199254740993': values };
  const init = request({ body: JSON.stringify(original) });
  await stream(interceptor, () => fetch(endpoint, init)).next();
  assert.deepEqual(JSON.parse(calls[0].args[1].body), { ...original, service_tier: 'priority' });
  assert.deepEqual(injected, [{ reason: 'injected' }]);
});

test('rejects non-canonical JSON only when injection is needed', async (t) => {
  const { interceptor, calls, injected, skipped } = setup(t);
  const invalid = [
    '{"model":"gpt-test","x":1,"x":2}',
    '{"model":"gpt-test","nested":{"x":1,"x":2}}',
    '{"model": "gpt-test"}',
    ' {"model":"gpt-test"}',
    '{"model":"gpt-test","text":"\\u0061"}'
  ];
  for (const input of invalid) {
    await assert.rejects(stream(interceptor, () => fetch(endpoint, request({ body: input }))).next(),
      (error) => error.message === 'Fast interceptor: non-canonical-json');
  }
  assert.deepEqual(skipped, invalid.map(() => ({ reason: 'non-canonical-json' })));
  assert.equal(calls.length, 0);
  assert.equal(injected.length, 0);
  const canonical = request({ body: JSON.stringify({ model: 'gpt-test', nested: { x: 1 }, message: 'fake-secret' }) });
  await stream(interceptor, () => fetch(endpoint, canonical)).next();
  assert.equal(JSON.parse(calls.at(-1).args[1].body).service_tier, 'priority');
  for (const text of ['{"model": "other"}', '{"model": "gpt-test", "service_tier": "priority"}']) {
    const init = request({ body: text });
    await stream(interceptor, () => fetch(endpoint, init)).next();
    assert.equal(calls.at(-1).args[1], init);
  }
});

test('content-length removal supports Headers and tuples without mutation', async (t) => {
  const { interceptor, calls } = setup(t);
  for (const headers of [new Headers({ 'content-length': '3', 'x-test': 'ok' }), [['Content-Length', '3'], ['X-Test', 'ok']]]) {
    const init = request({ headers });
    await stream(interceptor, () => fetch(endpoint, init)).next();
    const sentHeaders = new Headers(calls.at(-1).args[1].headers);
    assert.equal(sentHeaders.has('content-length'), false);
    assert.equal(sentHeaders.get('x-test'), 'ok');
    assert.equal(new Headers(headers).get('content-length'), '3');
  }
});

test('preserves Set and one-shot iterable headers during injection', async (t) => {
  const { interceptor, calls } = setup(t);
  const entries = [['Authorization', 'Bearer fake-secret'], ['X-Test', 'ok']];
  for (const withLength of [true, false]) {
    for (const makeHeaders of [
      (values) => new Set(values),
      (values) => values.values()
    ]) {
      const values = withLength ? [...entries, ['Content-Length', '3']] : entries;
      const init = request({ headers: makeHeaders(values) });
      await stream(interceptor, () => fetch(endpoint, init)).next();
      const sent = calls.at(-1).args[1];
      assert.equal(sent.headers.get('authorization'), 'Bearer fake-secret');
      assert.equal(sent.headers.get('x-test'), 'ok');
      assert.equal(sent.headers.has('content-length'), false);
      assert.equal(JSON.parse(sent.body).service_tier, 'priority');
    }
  }
});

test('unmodified model and priority requests leave one-shot headers unconsumed', async (t) => {
  const { interceptor, calls } = setup(t);
  for (const extra of [{ model: 'other' }, { service_tier: 'priority' }]) {
    const values = [['Authorization', 'Bearer fake-secret'], ['Content-Length', '3']];
    const headers = values.values();
    const init = request({ headers, body: body(extra) });
    await stream(interceptor, () => fetch(endpoint, init)).next();
    assert.equal(calls.at(-1).args[1], init);
    assert.deepEqual([...headers], values);
  }
});

test('preserves inherited and non-enumerable init properties', async (t) => {
  const { interceptor, calls } = setup(t);
  const signal = new AbortController().signal;
  const init = Object.create({ method: 'POST', signal });
  Object.defineProperty(init, 'body', { value: body(), enumerable: false });
  Object.defineProperty(init, 'headers', { value: { 'Content-Length': '3', 'X-Test': 'ok' }, enumerable: false });
  await stream(interceptor, () => fetch(endpoint, init)).next();
  const sent = calls[0].args[1];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.signal, signal);
  assert.equal(new Headers(sent.headers).get('x-test'), 'ok');
  assert.equal(new Headers(sent.headers).has('content-length'), false);
  assert.equal(new Headers(init.headers).get('content-length'), '3');
  assert.equal(JSON.parse(sent.body).service_tier, 'priority');
});

test('return, completion, and errors deactivate inherited asynchronous work', async (t) => {
  const { interceptor, calls } = setup(t);
  for (const termination of ['return', 'complete', 'error']) {
    let release;
    let background;
    const gate = new Promise((resolve) => { release = resolve; });
    const failure = new Error('iterator failure');
    const iterator = interceptor.middleware(options, () => (async function* () {
      background = gate.then(() => fetch(endpoint, request()));
      try {
        yield 'first';
        if (termination === 'error') throw failure;
      } finally {
        if (termination === 'return') await fetch(endpoint, request());
      }
    })())[Symbol.asyncIterator]();
    await iterator.next();
    if (termination === 'return') await iterator.return('cancelled');
    else if (termination === 'error') await assert.rejects(iterator.next(), (error) => error === failure);
    else await iterator.next();
    release();
    await background;
    assert.equal(JSON.parse(calls.at(-1).args[1].body).service_tier, undefined);
  }
  assert.equal(JSON.parse(calls[0].args[1].body).service_tier, 'priority');
});

test('throw forwards the same error and cleanup runs in scope', async (t) => {
  const { interceptor, calls } = setup(t);
  const failure = new Error('test');
  const iterator = interceptor.middleware(options, () => (async function* () {
    try { yield 'ready'; } finally { await fetch(endpoint, request()); }
  })())[Symbol.asyncIterator]();
  await iterator.next();
  await assert.rejects(iterator.throw(failure), (error) => error === failure);
  assert.equal(JSON.parse(calls[0].args[1].body).service_tier, 'priority');
});

test('dispose coexists with later wrappers and cached fetch clients', async (t) => {
  const { interceptor, calls, fake } = setup(t);
  const cached = globalThis.fetch;
  const later = (...args) => cached(...args);
  globalThis.fetch = later;
  interceptor.dispose();
  assert.equal(globalThis.fetch, later);
  const init = request();
  await stream(interceptor, () => fetch(endpoint, init)).next();
  assert.equal(calls.at(-1).args[1], init);
  await stream(interceptor, () => cached(endpoint, init)).next();
  assert.equal(calls.at(-1).args[1], init);
  interceptor.dispose();
  assert.throws(() => interceptor.installFetch(), /disposed/);
  assert.notEqual(fake, cached);
});

test('callbacks cannot break fetch and errors from fetch remain unchanged', async (t) => {
  const failure = new Error('fetch failure');
  let fail = false;
  const { interceptor } = setup(t, { onInject() { throw new Error('secret'); }, onSkip() { throw new Error('secret'); } },
    () => fail ? Promise.reject(failure) : Promise.resolve('fake-response'));
  await stream(interceptor, () => fetch(endpoint, request())).next();
  await stream(interceptor, () => fetch(endpoint, request({ method: 'GET' }))).next();
  fail = true;
  await assert.rejects(stream(interceptor, () => fetch(endpoint, request())).next(), (error) => error === failure);
});

test('configuration validation and enabled errors never expose secrets', async (t) => {
  for (const baseURL of ['http://example.test/v1', 'https://user:password@example.test/v1', 'https://example.test/v1?secret=1', 'not a url']) {
    assert.throws(() => createInterceptor({ provider: 'p', models: ['m'], baseURL, isEnabled: () => true }), /Invalid baseURL/);
  }
  const { interceptor, calls, skipped } = setup(t, { isEnabled() { throw new Error('fake-secret'); } });
  await assert.rejects(stream(interceptor, () => fetch(endpoint, request())).next(), /enabled-error/);
  assert.deepEqual(skipped, [{ reason: 'enabled-error' }]);
  assert.equal(calls.length, 0);
  await tick();
});
