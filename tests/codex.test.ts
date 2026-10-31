import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { generateImage } from '../src/codex.ts';
import type { ImageRequest } from '../src/codex.ts';
import { ImageRequestError } from '../src/image-response.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const INPUT: ImageRequest = { prompt: 'private prompt', background: 'opaque' };
const AUTH = { accessToken: 'private-token', accountId: 'private-account' };
const SECRET = 'private-token private-account private prompt private-request-id';
const MAX_BODY_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function imageResponse(bytes = PNG): Response {
  return Response.json({ data: [{ b64_json: bytes.toString('base64') }], model: 'unverified-model' });
}

function call(fetcher: typeof fetch, input = INPUT, signal = new AbortController().signal) {
  return generateImage(input, AUTH, signal, fetcher);
}

function safeError(pattern: RegExp, name?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ImageRequestError);
    assert.match(error.message, pattern);
    assert.match(error.message, /not retried/);
    for (const field of ['category', 'phase', 'outcome'] as const) assert.ok(error.message.includes(error[field]));
    if (name) assert.equal(error.name, name);
    assert.equal(error.cause, undefined);
    for (const secret of ['private-token', 'private-account', 'private prompt', 'private-request-id']) {
      assert.ok(!String(error.stack).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
    }
    return true;
  };
}

test('generates one image with fixed endpoint, auth, model, options and no redirects', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const result = await call(async (url, init) => {
    calls++;
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/generations');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.signal, signal);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${AUTH.accessToken}`);
    assert.equal(headers.get('chatgpt-account-id'), AUTH.accountId);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('originator'), 'opencode');
    assert.match(headers.get('x-codex-image-turn-id') ?? '', /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: 'gpt-image-2', quality: 'auto', size: 'auto', prompt: INPUT.prompt, background: 'opaque',
    });
    return imageResponse();
  }, INPUT, signal);
  assert.equal(calls, 1);
  assert.deepEqual(result, { bytes: PNG, requestedModel: 'gpt-image-2', effectiveModel: null });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('edits with data URLs and transparent background', async () => {
  const images = Object.freeze([`data:image/png;base64,${PNG.toString('base64')}`]);
  await call(async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/edits');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: 'gpt-image-2', quality: 'auto', size: 'auto', prompt: INPUT.prompt,
      background: 'transparent', images: [{ image_url: images[0] }],
    });
    return imageResponse();
  }, { ...INPUT, background: 'transparent', images });
});

test('omits optional account ID and creates a fresh turn ID for every request', async () => {
  const ids = new Set<string>();
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/generations');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('chatgpt-account-id'), false);
    ids.add(headers.get('x-codex-image-turn-id') ?? '');
    assert.equal('images' in JSON.parse(String(init?.body)), false);
    return imageResponse();
  };
  for (let i = 0; i < 2; i++) {
    await generateImage({ ...INPUT, images: [] }, { accessToken: AUTH.accessToken }, new AbortController().signal, fetcher);
  }
  assert.equal(ids.size, 2);
});

for (const [status, message] of [
  [401, /authentication/], [403, /access was denied/], [429, /rate or usage limit/],
  [500, /temporarily unavailable/], [503, /temporarily unavailable/],
  [400, /rejected/], [302, /rejected/],
] as const) {
  test(`HTTP ${status} is static, discards the response and is never retried`, async () => {
    let calls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from(SECRET)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(call(async () => {
      calls++;
      return new Response(body, { status, headers: { 'x-request-id': SECRET, 'x-codex-imagegen-request-id': SECRET } });
    }), safeError(message));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  });
}

test('replaces network exceptions without exposing their messages or causes', async () => {
  let calls = 0;
  await assert.rejects(call(async () => {
    calls++;
    throw new Error(SECRET, { cause: new Error(SECRET) });
  }), safeError(/Check connectivity/));
  assert.equal(calls, 1);
});

test('sanitizes header validation exceptions', async () => {
  await assert.rejects(generateImage(INPUT, { accessToken: `${SECRET}\ninvalid` }, new AbortController().signal, async (_, init) => {
    new Headers(init?.headers);
    return imageResponse();
  }), safeError(/request failed/));
});

test('does not expose malformed JSON response text', async () => {
  await assert.rejects(call(async () => new Response(SECRET)), safeError(/invalid JSON/));
});

for (const body of [null, {}, { data: [] }, { data: [null] }, { data: [{}] }, { data: [{ b64_json: 1 }] }, { data: [{ b64_json: '' }] }]) {
  test(`rejects missing image data: ${JSON.stringify(body)}`, async () => {
    await assert.rejects(call(async () => Response.json(body)), safeError(/no image data/));
  });
}

test('rejects responses without a body', async () => {
  await assert.rejects(call(async () => new Response(null)), safeError(/no image data/));
});

for (const encoded of ['!!!!', 'AA', 'A===', 'AAAA\n', 'AA-A', 'AB==', 'AAB=', '====', 'data:image/png;base64,AAAA']) {
  test(`rejects invalid base64: ${JSON.stringify(encoded)}`, async () => {
    await assert.rejects(call(async () => Response.json({ data: [{ b64_json: encoded }] })), safeError(/valid base64/));
  });
}

test('rejects non-PNG, truncated PNG, missing image data and invalid dimensions', async () => {
  const zeroWidth = Buffer.from(PNG);
  zeroWidth.writeUInt32BE(0, 16);
  const oversizedHeight = Buffer.from(PNG);
  oversizedHeight.writeUInt32BE(0xffffffff, 20);
  const badHeader = Buffer.from(PNG);
  badHeader.writeUInt32BE(12, 8);
  const truncatedChunk = Buffer.from(PNG);
  truncatedChunk.writeUInt32BE(0xffffffff, 33);
  const samples = [
    Buffer.from('not a PNG'), PNG.subarray(0, 8), PNG.subarray(0, 24), PNG.subarray(0, 33),
    PNG.subarray(0, -1), Buffer.concat([PNG.subarray(0, 33), PNG.subarray(-12)]),
    Buffer.concat([PNG, Buffer.from([0])]), zeroWidth, oversizedHeight, badHeader, truncatedChunk,
  ];
  for (const bytes of samples) {
    await assert.rejects(call(async () => imageResponse(bytes)), safeError(/invalid or truncated PNG/));
  }
});

test('reads a streamed JSON response across chunk boundaries', async () => {
  const json = Buffer.from(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of json) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  assert.deepEqual((await call(async () => new Response(stream))).bytes, PNG);
});

test('sanitizes a response stream failure and removes its abort listener', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    pull() { throw new Error(SECRET); },
  });
  await assert.rejects(call(async () => new Response(stream), INPUT, controller.signal), safeError(/Could not read/));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('honors cancellation before fetch without exposing its reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error(SECRET));
  let called = false;
  await assert.rejects(call(async () => { called = true; return imageResponse(); }, INPUT, controller.signal), safeError(/cancelled/, 'AbortError'));
  assert.equal(called, false);
});

test('honors cancellation during fetch', async () => {
  const controller = new AbortController();
  await assert.rejects(call(async (_, init) => {
    assert.equal(init?.signal, controller.signal);
    controller.abort(new Error(SECRET));
    throw controller.signal.reason;
  }, INPUT, controller.signal), safeError(/cancelled/, 'AbortError'));
});

test('sanitizes an upstream AbortError', async () => {
  await assert.rejects(call(async () => { throw new DOMException(SECRET, 'AbortError'); }), safeError(/cancelled/, 'AbortError'));
});

test('retains timeout classification without exposing timeout reason', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException(SECRET, 'TimeoutError'));
  await assert.rejects(call(async () => imageResponse(), INPUT, controller.signal), safeError(/timed out/, 'TimeoutError'));
});

test('cancels a stalled response stream even when it does not observe the fetch signal', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    pull() { started(); return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  });
  const result = call(async () => new Response(stream), INPUT, controller.signal);
  await reading;
  controller.abort(new Error(SECRET));
  await assert.rejects(result, safeError(/cancelled/, 'AbortError'));
  assert.equal(cancelled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('checks cancellation after fetch and discards the response', async () => {
  const controller = new AbortController();
  let cancelled = false;
  await assert.rejects(call(async () => {
    controller.abort();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }, INPUT, controller.signal), safeError(/cancelled/, 'AbortError'));
  assert.equal(cancelled, true);
});

test('rejects oversized Content-Length before reading the response', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(call(async () => new Response(stream, {
    headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
  })), safeError(/response exceeds the 48 MiB limit/));
  assert.equal(cancelled, true);
});

test('enforces the streamed response limit even with a misleading Content-Length', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 32);
  let cancelled = false;
  const signal = new AbortController().signal;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(call(async () => new Response(stream, { headers: { 'content-length': '1' } }), INPUT, signal), safeError(/response exceeds the 48 MiB limit/));
  assert.equal(cancelled, true);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('enforces decoded image size before creating the image Buffer', async () => {
  const encoded = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4);
  await assert.rejects(call(async () => Response.json({ data: [{ b64_json: encoded }] })), safeError(/image exceeds the 32 MiB limit/));
});

test('rejects reference URLs and malformed base64 without sending a request', async () => {
  for (const image of ['https://example.com/private-token.png', 'data:text/plain;base64,AAAA', 'data:image/png;base64,!!!!']) {
    let called = false;
    await assert.rejects(call(async () => { called = true; return imageResponse(); }, { ...INPUT, images: [image] }), safeError(/data URLs|valid base64/));
    assert.equal(called, false);
  }
});

test('limits request memory before serialization and fetch', async () => {
  let called = false;
  await assert.rejects(call(async () => { called = true; return imageResponse(); }, {
    ...INPUT, prompt: 'a'.repeat(MAX_BODY_BYTES + 1),
  }), safeError(/request exceeds the 48 MiB limit/));
  assert.equal(called, false);
});

test('returns only validated response metadata while preserving requested and unknown effective model', async () => {
  const reported = { size: '1536x1024', quality: 'high', background: 'transparent', output_format: 'png' };
  const usage = { input_tokens: 5, output_tokens: 8, total_tokens: 13, output_tokens_details: { image_tokens: 8 } };
  const result = await call(async () => Response.json({
    data: [{ b64_json: PNG.toString('base64'), revised_prompt: SECRET, model: SECRET }],
    ...reported, usage: { ...usage, account: SECRET, cost: 1.99 }, model: SECRET, request_id: SECRET, safety_identifier: SECRET,
  }));
  assert.deepEqual(result, { bytes: PNG, requestedModel: 'gpt-image-2', effectiveModel: null, reported, usage });
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('does not fabricate response metadata or return unknown or malformed metadata', async () => {
  for (const metadata of [{}, { size: SECRET, quality: SECRET, background: SECRET, output_format: SECRET, usage: { account: SECRET, total_tokens: SECRET } }]) {
    const result = await call(async () => Response.json({ data: [{ b64_json: PNG.toString('base64') }], ...metadata, model: SECRET }));
    assert.deepEqual(result, { bytes: PNG, requestedModel: 'gpt-image-2', effectiveModel: null });
  }
});

test('Codex request validation, missing auth and invalid headers fail locally without dispatch', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return imageResponse(); };
  for (const request of [
    () => call(fetcher, { ...INPUT, images: ['data:image/png;base64,!!!!'] }),
    () => generateImage(INPUT, { accessToken: `${SECRET}\ninvalid` }, new AbortController().signal, fetcher),
    () => generateImage(INPUT, { accessToken: ' ' }, new AbortController().signal, fetcher),
  ]) {
    await assert.rejects(request, (error: unknown) => {
      safeError(/valid base64|request failed|access token/)(error);
      assert.ok(error instanceof ImageRequestError);
      assert.ok(['invalid_request', 'authentication'].includes(error.category));
      assert.equal(error.phase, 'local');
      assert.equal(error.outcome, 'not_submitted');
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('Codex failures distinguish rejection from ambiguous dispatch and response failures without retries', async () => {
  const cases = [
    { fetcher: async () => { throw new Error(SECRET); }, category: 'network', phase: 'dispatch', outcome: 'ambiguous', status: undefined },
    { fetcher: async () => new Response(SECRET), category: 'invalid_response', phase: 'response', outcome: 'ambiguous', status: undefined },
    { fetcher: async () => new Response(null, { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }), category: 'response_limit', phase: 'response', outcome: 'ambiguous', status: undefined },
    { fetcher: async () => new Response(new ReadableStream({ pull() { throw new Error(SECRET); } })), category: 'network', phase: 'response', outcome: 'ambiguous', status: undefined },
    { fetcher: async () => Response.json({ error: { code: 'insufficient_quota', message: SECRET } }, { status: 429 }), category: 'quota', phase: 'response', outcome: 'remote_rejected', status: 429 },
    { fetcher: async () => Response.json({ error: { code: 'rate_limit_exceeded', message: SECRET } }, { status: 429 }), category: 'rate_limit', phase: 'response', outcome: 'remote_rejected', status: 429 },
    { fetcher: async () => Response.json({ error: { message: SECRET } }, { status: 503 }), category: 'remote_error', phase: 'response', outcome: 'ambiguous', status: 503 },
  ];
  for (const { fetcher, category, phase, outcome, status } of cases) {
    let calls = 0;
    await assert.rejects(call(async () => { calls++; return fetcher(); }), (error: unknown) => {
      safeError(/./)(error);
      assert.ok(error instanceof ImageRequestError);
      assert.deepEqual({ category: error.category, phase: error.phase, outcome: error.outcome, status: error.status }, { category, phase, outcome, status });
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Codex cancellation identifies whether dispatch has started', async () => {
  for (const phase of ['local', 'dispatch', 'response']) {
    const controller = new AbortController();
    if (phase === 'local') controller.abort(new Error(SECRET));
    let calls = 0;
    await assert.rejects(call(async () => {
      calls++;
      controller.abort(new Error(SECRET));
      if (phase === 'dispatch') throw controller.signal.reason;
      return imageResponse();
    }, INPUT, controller.signal), (error: unknown) => {
      safeError(/cancelled/, 'AbortError')(error);
      assert.ok(error instanceof ImageRequestError);
      assert.equal(error.phase, phase);
      assert.equal(error.outcome, phase === 'local' ? 'not_submitted' : 'ambiguous');
      return true;
    });
    assert.equal(calls, phase === 'local' ? 0 : 1);
  }
});
