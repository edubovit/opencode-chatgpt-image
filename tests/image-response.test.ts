import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { ImageRequestError, imageCancellation, imageResponseMetadata, imageStatusError } from '../src/image-response.ts';

const SECRET = 'private-token private-account private prompt private-request-id';

function safe(error: ImageRequestError): void {
  assert.ok(error instanceof Error);
  assert.equal(error.cause, undefined);
  assert.match(error.message, /not retried/);
  for (const field of ['category', 'phase', 'outcome'] as const) assert.ok(error.message.includes(error[field]));
  for (const value of [String(error.stack), JSON.stringify(error)]) assert.ok(!value.includes('private'));
}

test('allowlists reported settings and numeric text/image/cache token usage without deriving totals or costs', () => {
  const result = imageResponseMetadata({
    size: '3840x2160', quality: 'max', background: 'transparent', output_format: 'webp',
    model: SECRET, revised_prompt: SECRET, safety_identifier: SECRET, request_id: SECRET, cost: 42,
    usage: {
      input_tokens: 12, output_tokens: 23, total_tokens: 35, cached_tokens: 5,
      input_tokens_details: {
        text_tokens: 7, image_tokens: 5, cached_tokens: 5, cache_write_tokens: 0,
        cached_tokens_details: { text_tokens: 2, image_tokens: 3, account: SECRET },
        reasoning_tokens: 99, model: SECRET,
      },
      output_tokens_details: { text_tokens: 0, image_tokens: 23, reasoning_tokens: 99, prompt: SECRET },
      cached_tokens_details: { cached_text_tokens: 2, cached_image_tokens: 3, secret: SECRET },
      cost: 42, account: SECRET, request_id: SECRET,
    },
  });
  assert.deepEqual(result, {
    reported: { size: '3840x2160', quality: 'max', background: 'transparent', output_format: 'webp' },
    usage: {
      input_tokens: 12, output_tokens: 23, total_tokens: 35, cached_tokens: 5,
      input_tokens_details: {
        text_tokens: 7, image_tokens: 5, cached_tokens: 5, cache_write_tokens: 0,
        cached_tokens_details: { text_tokens: 2, image_tokens: 3 },
      },
      output_tokens_details: { text_tokens: 0, image_tokens: 23 },
      cached_tokens_details: { cached_text_tokens: 2, cached_image_tokens: 3 },
    },
  });
  assert.deepEqual(imageResponseMetadata({ usage: { input_tokens: 4 } }), { usage: { input_tokens: 4 } });
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('omits absent, empty, unknown and malformed metadata without affecting image results', () => {
  for (const value of [null, [], 1, SECRET, {}, {
    size: SECRET, quality: SECRET, background: SECRET, output_format: SECRET,
    usage: { input_tokens: SECRET, output_tokens_details: SECRET, input_tokens_details: { text_tokens: SECRET }, account: SECRET },
  }, {
    size: '0x1024', quality: [], background: {}, output_format: 7, usage: [],
  }]) assert.deepEqual(imageResponseMetadata(value), {});
  for (const size of ['1024x0', '01024x1024', '100000x1024', '1e3x1024', '1024X1024', '1024x1024\n', '-1x1024']) {
    assert.deepEqual(imageResponseMetadata({ size }), {});
  }
  assert.deepEqual(imageResponseMetadata({ size: 'auto', quality: 'auto', background: 'auto' }), {
    reported: { size: 'auto', quality: 'auto', background: 'auto' },
  });
});

test('token counts must be nonnegative safe integers at every allowed depth', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5', null, true, [], {}]) {
    assert.deepEqual(imageResponseMetadata({ usage: {
      input_tokens: value, output_tokens: value, total_tokens: value, cached_tokens: value,
      input_tokens_details: { text_tokens: value, image_tokens: value, cached_tokens: value, cache_write_tokens: value, cached_tokens_details: { text_tokens: value } },
      output_tokens_details: { image_tokens: value }, cached_tokens_details: { cached_image_tokens: value },
    } }), {});
  }
  assert.deepEqual(imageResponseMetadata({ usage: { input_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER } }), {
    usage: { input_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER },
  });
});

for (const [status, code, category] of [
  [400, 'content_policy_violation', 'content_filter'],
  [403, 'image_content_policy_violation', 'content_filter'],
  [400, 'moderation_blocked', 'content_filter'],
  [429, 'insufficient_quota', 'quota'],
  [400, 'billing_hard_limit_reached', 'quota'],
  [429, 'rate_limit_exceeded', 'rate_limit'],
] as const) {
  test(`classifies only allowlisted error code ${code}`, async () => {
    for (const provider of ['OpenAI', 'Codex'] as const) {
      const error = await imageStatusError(provider, Response.json({
        error: { code, message: SECRET, param: SECRET, request_id: SECRET, moderation_details: { categories: [SECRET] } },
      }, { status, headers: { 'retry-after': '1.5', 'x-request-id': SECRET } }), new AbortController().signal);
      assert.equal(error.category, category);
      assert.equal(error.phase, 'response');
      assert.equal(error.outcome, 'remote_rejected');
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 1500);
      safe(error);
    }
  });
}

test('accepts known error types but never infers a category from free text or unknown codes', async () => {
  const signal = new AbortController().signal;
  const typed = await imageStatusError('OpenAI', Response.json({ error: { type: 'insufficient_quota', message: SECRET } }, { status: 429 }), signal);
  assert.equal(typed.category, 'quota');
  for (const body of [null, [], { code: 'insufficient_quota' }, { error: { code: SECRET, message: 'insufficient_quota', type: SECRET } }, { error: { code: { code: 'insufficient_quota' } } }]) {
    const error = await imageStatusError('OpenAI', Response.json(body, { status: 429 }), signal);
    assert.equal(error.category, 'rate_limit_or_quota');
    safe(error);
  }
});

test('server failures and HTTP timeouts remain ambiguous even if their bodies contain known rejection codes', async () => {
  for (const status of [408, 500, 503]) {
    const error = await imageStatusError('OpenAI', Response.json({ error: { code: 'insufficient_quota', message: SECRET } }, { status }), new AbortController().signal);
    assert.equal(error.outcome, 'ambiguous');
    assert.equal(error.status, status);
    assert.match(error.message, /may have been processed/);
    safe(error);
  }
});

test('ignores oversized or malformed Retry-After values and validates error numeric fields', async () => {
  for (const raw of [SECRET, '-1', 'Infinity', 'NaN', '99999999999999999', '86401', '1e3', '2026-10-31', '1.0001']) {
    const error = await imageStatusError('Codex', new Response(null, { status: 429, headers: { 'retry-after': raw } }), new AbortController().signal);
    assert.equal(error.retryAfterMs, undefined);
    safe(error);
  }
  for (const [raw, expected] of [['0', 0], ['86400', 86_400_000], ['0.001', 1]] as const) {
    const error = await imageStatusError('Codex', new Response(null, { status: 429, headers: { 'retry-after': raw } }), new AbortController().signal);
    assert.equal(error.retryAfterMs, expected);
  }
  const future = new Date(Date.now() + 10_000).toUTCString();
  const error = await imageStatusError('Codex', new Response(null, { status: 429, headers: { 'retry-after': future } }), new AbortController().signal);
  assert.ok(error.retryAfterMs! >= 8000 && error.retryAfterMs! <= 10_000);
  for (const value of [-1, Infinity, NaN, 99999999999999999, 0.5]) {
    const invalid = new ImageRequestError('network', 'Check connectivity.', { phase: 'dispatch', outcome: 'ambiguous', status: value, retryAfterMs: value });
    assert.equal(invalid.status, undefined);
    assert.equal(invalid.retryAfterMs, undefined);
  }
});

test('bounds error JSON by declared and streamed length, cancels unread bodies and removes listeners', async () => {
  for (const declared of [String(64 * 1024 + 1), '1']) {
    let cancelled = false;
    let reads = 0;
    const signal = new AbortController().signal;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(Buffer.alloc(64 * 1024 + 1, 32)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const error = await imageStatusError('OpenAI', new Response(stream, { status: 429, headers: { 'content-type': 'application/json', 'content-length': declared } }), signal);
    assert.equal(error.category, 'rate_limit_or_quota');
    assert.equal(cancelled, true);
    assert.equal(reads, declared === '1' ? 1 : 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    safe(error);
  }
});

test('sanitizes malformed and failing JSON error streams without losing the HTTP status', async () => {
  const signal = new AbortController().signal;
  for (const body of [SECRET, new ReadableStream<Uint8Array>({ pull() { throw new Error(SECRET); } })]) {
    const error = await imageStatusError('OpenAI', new Response(body, { status: 401, headers: { 'content-type': 'application/json' } }), signal);
    assert.equal(error.category, 'authentication');
    assert.equal(error.status, 401);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    safe(error);
  }
});

test('non-JSON error bodies are discarded without parsing even when they contain an allowlisted code', async () => {
  let cancelled = false;
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(Buffer.from('{"error":{"code":"insufficient_quota"}}')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const error = await imageStatusError('OpenAI', new Response(stream, { status: 429 }), new AbortController().signal);
  assert.equal(error.category, 'rate_limit_or_quota');
  assert.equal(reads, 0);
  assert.equal(cancelled, true);
});

test('aborting an error-body read cancels a stalled stream and retains safe cancellation classification', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    pull() { started(); return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  });
  const result = imageStatusError('OpenAI', new Response(stream, { status: 429, headers: { 'content-type': 'application/json' } }), controller.signal);
  await reading;
  controller.abort(new Error(SECRET));
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof ImageRequestError);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.category, 'cancelled');
    assert.equal(error.phase, 'response');
    assert.equal(error.outcome, 'ambiguous');
    safe(error);
    return true;
  });
  assert.equal(cancelled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation preserves names and distinguishes not-submitted from ambiguous phases', () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    const controller = new AbortController();
    controller.abort(new DOMException(SECRET, name));
    for (const phase of ['local', 'dispatch', 'response'] as const) {
      const error = imageCancellation(controller.signal, phase);
      assert.equal(error.name, name);
      assert.equal(error.phase, phase);
      assert.equal(error.outcome, phase === 'local' ? 'not_submitted' : 'ambiguous');
      safe(error);
    }
  }
});
