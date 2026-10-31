import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { generateApiImages } from '../src/openai.ts';
import type { ImageUpload } from '../src/openai.ts';
import { ImageRequestError } from '../src/image-response.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const PNG2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY/jPwPAfAAUAAf+mXJtdAAAAAElFTkSuQmCC', 'base64');
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/'
  + '8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/'
  + '8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==',
  'base64',
);
const WEBP = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA', 'base64');
const LOSSY_WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const INPUT = Object.freeze({ prompt: 'private prompt', model: 'gpt-image-2.5-sunburst', quality: 'max', size: '3840x2160', n: 1, output_format: 'png' });
const KEY = 'private-key';
const SECRET = 'private-key private-account private prompt private-request-id';
const REFERENCE: ImageUpload = Object.freeze({ bytes: PNG, mime: 'image/png', name: 'C:\\private-account\\reference.png' });
const MAX_REQUEST_BYTES = 200 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
type Parameters = Readonly<Record<string, string | number>>;
type Overlays = { mask?: ImageUpload; markup?: ImageUpload };

function imageResponse(images: readonly Buffer[] = [PNG]): Response {
  return Response.json({
    data: images.map(bytes => ({ b64_json: bytes.toString('base64'), revised_prompt: SECRET })),
    model: SECRET, usage: { account: SECRET },
  }, { headers: { 'x-request-id': SECRET } });
}

function call(fetcher: typeof fetch, parameters: Parameters = INPUT, signal = new AbortController().signal, images: readonly ImageUpload[] = [], overlays: Overlays = {}) {
  return generateApiImages(parameters, images, overlays, KEY, signal, fetcher);
}

function safeError(pattern: RegExp, name?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ImageRequestError);
    assert.match(error.message, pattern);
    assert.match(error.message, /not retried/);
    for (const field of ['category', 'phase', 'outcome'] as const) assert.ok(error.message.includes(error[field]));
    if (name) assert.equal(error.name, name);
    assert.equal(error.cause, undefined);
    for (const secret of ['private-key', 'private-account', 'private prompt', 'private-request-id']) {
      assert.ok(!String(error.stack).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
    }
    return true;
  };
}

test('forwards parent defaults as JSON with only API auth and never follows redirects', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const result = await call(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.signal, signal);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.deepEqual([...headers], [['authorization', `Bearer ${KEY}`], ['content-type', 'application/json']]);
    assert.deepEqual(JSON.parse(String(init?.body)), INPUT);
    return imageResponse();
  }, INPUT, signal);
  assert.equal(calls, 1);
  assert.deepEqual(result, [{ bytes: PNG, mime: 'image/png' }]);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('preserves every passed generation scalar override and does not mutate input', async () => {
  const parameters = Object.freeze({
    ...INPUT, model: 'gpt-image-2.5-flare-2026-09-08', quality: 'low', size: '1024x1024', n: 2,
    output_format: 'webp', output_compression: 0, background: 'transparent', moderation: 'low',
    safety_identifier: 'private-account', user: 'private-account', future_scalar: 'forwarded',
  });
  const result = await call(async (_, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), parameters);
    return imageResponse([WEBP, WEBP]);
  }, parameters);
  assert.deepEqual(result, [{ bytes: WEBP, mime: 'image/webp' }, { bytes: WEBP, mime: 'image/webp' }]);
});

test('does not invent generation defaults when the parent omits them', async () => {
  const parameters = { prompt: 'private prompt' };
  await call(async (_, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), parameters);
    return imageResponse();
  }, parameters);
});

for (const images of [[], [REFERENCE]]) {
  test(`never sends orientation, response_format, or stream (${images.length ? 'edit' : 'generate'})`, async () => {
    await call(async (_, init) => {
      const fields = init?.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(String(init?.body));
      for (const key of ['orientation', 'response_format', 'stream']) assert.equal(key in fields, false);
      assert.equal(fields.size, INPUT.size);
      return imageResponse();
    }, { ...INPUT, orientation: 'landscape', response_format: 'url', stream: 'true' }, undefined, images);
  });
}

test('multipart edits preserve references, scalar fields, basename filenames, and mask with a generated boundary', async () => {
  const parameters = Object.freeze({ ...INPUT, input_fidelity: 'high', background: 'transparent', safety_identifier: 'private-account', user: 'private-account' });
  const images = Object.freeze([REFERENCE, { bytes: JPEG, mime: 'image/jpeg', name: '/private-account/second picture.jpg' }]);
  const overlays = Object.freeze({ mask: { bytes: PNG2, mime: 'image/png', name: 'masks\\alpha.png' } });
  const signal = new AbortController().signal;
  await call(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.signal, signal);
    assert.ok(init?.body instanceof FormData);
    assert.deepEqual([...new Headers(init.headers)], [['authorization', `Bearer ${KEY}`]]);
    const request = new Request(url, init);
    assert.match(request.headers.get('content-type') ?? '', /^multipart\/form-data; boundary=/);
    const form = await request.formData();
    for (const [key, value] of Object.entries(parameters)) assert.equal(form.get(key), String(value));
    assert.equal(form.has('image'), false);
    assert.equal(form.has('images'), false);
    assert.equal(form.has('markup'), false);
    const references = form.getAll('image[]');
    assert.equal(references.length, 2);
    for (const [index, name] of ['reference.png', 'second picture.jpg'].entries()) {
      const file = references[index];
      assert.ok(file instanceof File);
      assert.equal(file.name, name);
      assert.equal(file.type, images[index]!.mime);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), images[index]!.bytes);
    }
    const mask = form.get('mask');
    assert.ok(mask instanceof File);
    assert.equal(mask.name, 'alpha.png');
    assert.equal(mask.type, 'image/png');
    assert.deepEqual(Buffer.from(await mask.arrayBuffer()), PNG2);
    return imageResponse();
  }, parameters, signal, images, overlays);
});

for (const overlays of [{}, { markup: REFERENCE }, { markup: REFERENCE, mask: REFERENCE }]) {
  test(`appends exactly the supplied overlays: ${Object.keys(overlays).join(',') || 'none'}`, async () => {
    await call(async (_, init) => {
      assert.ok(init?.body instanceof FormData);
      for (const key of ['mask', 'markup']) {
        assert.equal(init.body.has(key), key in overlays);
        if (key in overlays) {
          const file = init.body.get(key);
          assert.ok(file instanceof File);
          assert.equal(file.name, 'reference.png');
          assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
        }
      }
      return imageResponse();
    }, INPUT, undefined, [REFERENCE], overlays);
  });
}

test('rejects overlays without references before sending a request', async () => {
  for (const overlays of [{ mask: REFERENCE }, { markup: REFERENCE }]) {
    let called = false;
    await assert.rejects(call(async () => { called = true; return imageResponse(); }, INPUT, undefined, [], overlays), safeError(/requires a reference image/));
    assert.equal(called, false);
  }
});

for (const [format, bytes] of [['png', PNG], ['jpeg', JPEG], ['webp', WEBP]] as const) {
  test(`validates actual ${format} bytes and returns every requested image`, async () => {
    const result = await call(async () => imageResponse([bytes, bytes]), { ...INPUT, output_format: format, n: 2 });
    assert.deepEqual(result, [{ bytes, mime: `image/${format}` }, { bytes, mime: `image/${format}` }]);
  });
  test(`rejects ${format} output when another format was requested`, async () => {
    await assert.rejects(call(async () => imageResponse([bytes]), { ...INPUT, output_format: format === 'png' ? 'jpeg' : 'png' }), safeError(/does not match/));
  });
}

test('preserves image order and discards response metadata', async () => {
  const result = await call(async () => imageResponse([PNG2, PNG]), { ...INPUT, n: 2 });
  assert.deepEqual(result, [{ bytes: PNG2, mime: 'image/png' }, { bytes: PNG, mime: 'image/png' }]);
});

for (const [status, message] of [
  [401, /authentication/], [403, /access was denied/], [429, /rate or usage limit/],
  [500, /temporarily unavailable/], [503, /temporarily unavailable/],
  [400, /rejected/], [404, /rejected/], [302, /rejected/], [307, /rejected/],
] as const) {
  test(`HTTP ${status} is static, discards sensitive bodies and is never retried`, async () => {
    let calls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from(SECRET)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(call(async (_, init) => {
      calls++;
      assert.equal(init?.redirect, 'error');
      return new Response(body, { status, headers: { 'x-request-id': SECRET, location: `https://example.com/${KEY}` } });
    }), safeError(message));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  });
}

test('replaces network errors and causes without retries or API fallback', async () => {
  let calls = 0;
  await assert.rejects(call(async (url) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    throw new Error(SECRET, { cause: new Error(SECRET) });
  }), safeError(/Check connectivity/));
  assert.equal(calls, 1);
});

test('uses only the supplied key and rejects a missing key without fetching', async () => {
  for (const key of ['', '   ']) {
    let called = false;
    await assert.rejects(generateApiImages(INPUT, [], {}, key, new AbortController().signal, async () => {
      called = true;
      return imageResponse();
    }), safeError(/key must be configured/));
    assert.equal(called, false);
  }
});

test('sanitizes header validation exceptions', async () => {
  await assert.rejects(generateApiImages(INPUT, [], {}, `${SECRET}\ninvalid`, new AbortController().signal, async (_, init) => {
    new Headers(init?.headers);
    return imageResponse();
  }), safeError(/request failed/));
});

test('does not expose malformed JSON response text', async () => {
  await assert.rejects(call(async () => new Response(SECRET)), safeError(/invalid JSON/));
});

for (const body of [null, {}, { data: null }, { data: {} }, { data: [null] }, { data: [{}] }, { data: [{ b64_json: 1 }] }, { data: [{ b64_json: '' }] }, { data: [{ url: `https://example.com/${KEY}` }] }]) {
  test(`rejects missing base64 image data without URL fallback: ${JSON.stringify(body)}`, async () => {
    let calls = 0;
    await assert.rejects(call(async () => { calls++; return Response.json(body); }), safeError(/no image data/));
    assert.equal(calls, 1);
  });
}

for (const [count, images] of [[1, []], [2, [PNG]], [1, [PNG, PNG]]] as const) {
  test(`rejects a partial or excess result: expected ${count}, received ${images.length}`, async () => {
    await assert.rejects(call(async () => imageResponse(images), { ...INPUT, n: count }), safeError(/requested number/));
  });
}

test('rejects an entire batch when a later image is invalid', async () => {
  await assert.rejects(call(async () => imageResponse([PNG, Buffer.from(SECRET)]), { ...INPUT, n: 2 }), safeError(/invalid or truncated/));
});

test('rejects responses without a body', async () => {
  await assert.rejects(call(async () => new Response(null)), safeError(/no image data/));
});

for (const encoded of ['!!!!', 'AA', 'A===', 'AAAA\n', 'AAAA ', 'AA-A', 'AA_A', 'AB==', 'AAB=', '====', 'data:image/png;base64,AAAA']) {
  test(`rejects invalid or noncanonical base64: ${JSON.stringify(encoded)}`, async () => {
    await assert.rejects(call(async () => Response.json({ data: [{ b64_json: encoded }] })), safeError(/valid base64/));
  });
}

test('rejects structurally invalid PNGs without trusting a signature alone', async () => {
  const zeroWidth = Buffer.from(PNG);
  zeroWidth.writeUInt32BE(0, 16);
  const oversizedHeight = Buffer.from(PNG);
  oversizedHeight.writeUInt32BE(0xffffffff, 20);
  const badHeader = Buffer.from(PNG);
  badHeader.writeUInt32BE(12, 8);
  const badDepth = Buffer.from(PNG);
  badDepth[24] = 0;
  const truncatedChunk = Buffer.from(PNG);
  truncatedChunk.writeUInt32BE(0xffffffff, 33);
  for (const bytes of [
    Buffer.from(SECRET), PNG.subarray(0, 8), PNG.subarray(0, 24), PNG.subarray(0, 33), PNG.subarray(0, -1),
    Buffer.concat([PNG.subarray(0, 33), PNG.subarray(-12)]), Buffer.concat([PNG, Buffer.from([0])]),
    zeroWidth, oversizedHeight, badHeader, badDepth, truncatedChunk,
  ]) await assert.rejects(call(async () => imageResponse([bytes])), safeError(/invalid or truncated/));
});

test('rejects truncated JPEGs, garbage between markers, and missing frames or scan data', async () => {
  const badLength = Buffer.from(JPEG);
  badLength.writeUInt16BE(0xffff, 4);
  const zeroWidth = Buffer.from(JPEG);
  const frame = zeroWidth.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame >= 0);
  zeroWidth.writeUInt16BE(0, frame + 7);
  for (const bytes of [
    JPEG.subarray(0, -1), JPEG.subarray(0, 10), Buffer.concat([JPEG, Buffer.from([0])]), badLength, zeroWidth,
    Buffer.from('ffd8ff00000000000000ffd9', 'hex'), Buffer.from('ffd8ffe00008000000000000ffd9', 'hex'),
    Buffer.concat([JPEG.subarray(0, JPEG.indexOf(Buffer.from([0xff, 0xda]))), Buffer.from([0xff, 0xd9])]),
  ]) await assert.rejects(call(async () => imageResponse([bytes]), { ...INPUT, output_format: 'jpeg' }), safeError(/invalid or truncated/));
});

test('accepts lossy, lossless and extended WebP containers and rejects malformed chunk lengths or headers', async () => {
  assert.deepEqual(await call(async () => imageResponse([LOSSY_WEBP]), { ...INPUT, output_format: 'webp' }), [{ bytes: LOSSY_WEBP, mime: 'image/webp' }]);
  const extended = Buffer.concat([WEBP.subarray(0, 12), Buffer.from('565038580a00000000000000000000000000', 'hex'), WEBP.subarray(12)]);
  extended.writeUInt32LE(extended.length - 8, 4);
  assert.deepEqual(await call(async () => imageResponse([extended]), { ...INPUT, output_format: 'webp' }), [{ bytes: extended, mime: 'image/webp' }]);
  const badLength = Buffer.from(WEBP);
  badLength.writeUInt32LE(0xffffffff, 16);
  const badHeader = Buffer.from(WEBP);
  badHeader[20] = 0;
  const onlyExtended = extended.subarray(0, 30);
  onlyExtended.writeUInt32LE(onlyExtended.length - 8, 4);
  for (const bytes of [WEBP.subarray(0, 12), WEBP.subarray(0, -1), Buffer.concat([WEBP, Buffer.from([0])]), badLength, badHeader, onlyExtended]) {
    await assert.rejects(call(async () => imageResponse([bytes]), { ...INPUT, output_format: 'webp' }), safeError(/invalid or truncated/));
  }
});

test('reads streamed JSON across byte boundaries', async () => {
  const json = Buffer.from(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }], revised_prompt: '秘密' }));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of json) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  assert.deepEqual(await call(async () => new Response(stream)), [{ bytes: PNG, mime: 'image/png' }]);
});

test('sanitizes a response stream failure and removes its abort listener', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ pull() { throw new Error(SECRET); } });
  await assert.rejects(call(async () => new Response(stream), INPUT, controller.signal), safeError(/Could not read/));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('honors cancellation before fetch without exposing the reason', async () => {
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

test('sanitizes upstream AbortError exceptions', async () => {
  await assert.rejects(call(async () => { throw new DOMException(SECRET, 'AbortError'); }), safeError(/cancelled/, 'AbortError'));
});

test('retains timeout classification without exposing its reason', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException(SECRET, 'TimeoutError'));
  await assert.rejects(call(async () => imageResponse(), INPUT, controller.signal), safeError(/timed out/, 'TimeoutError'));
});

test('cancels a stalled response reader even when the stream ignores the fetch signal', async () => {
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

test('checks cancellation after fetch and discards its response', async () => {
  const controller = new AbortController();
  let cancelled = false;
  await assert.rejects(call(async () => {
    controller.abort(new Error(SECRET));
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }, INPUT, controller.signal), safeError(/cancelled/, 'AbortError'));
  assert.equal(cancelled, true);
});

test('honors cancellation when a response finishes during an abort', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    pull(body) {
      controller.abort(new Error(SECRET));
      body.close();
    },
  });
  await assert.rejects(call(async () => new Response(stream), INPUT, controller.signal), safeError(/cancelled/, 'AbortError'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('rejects oversized Content-Length before reading', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(call(async () => new Response(stream, {
    headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
  })), safeError(/response exceeds the 256 MiB limit/));
  assert.equal(cancelled, true);
});

test('enforces the cumulative streamed response limit with a misleading Content-Length', async () => {
  let cancelled = false;
  let chunks = 0;
  const signal = new AbortController().signal;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunks++ === 0 ? Buffer.from('x') : Buffer.allocUnsafe(MAX_BODY_BYTES)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(call(async () => new Response(stream, { headers: { 'content-length': '1' } }), INPUT, signal), safeError(/response exceeds the 256 MiB limit/));
  assert.equal(cancelled, true);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('enforces decoded image size before creating a decoded image Buffer', async () => {
  const encoded = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4);
  await assert.rejects(call(async () => Response.json({ data: [{ b64_json: encoded }] })), safeError(/image exceeds the 32 MiB limit/));
});

test('limits aggregate upload bytes including mask and markup before multipart allocation or fetch', async () => {
  const upload = { ...REFERENCE, bytes: Buffer.alloc(1024 * 1024) };
  const images = Array.from({ length: MAX_REQUEST_BYTES / upload.bytes.length }, () => upload);
  for (const overlays of [{ mask: REFERENCE }, { markup: REFERENCE }]) {
    let called = false;
    await assert.rejects(call(async () => { called = true; return imageResponse(); }, INPUT, undefined, images, overlays), safeError(/200 MiB/));
    assert.equal(called, false);
  }
});

test('checks scalar bytes together with uploads before allocating a multipart body', async () => {
  const upload = { ...REFERENCE, bytes: Buffer.alloc(1024 * 1024) };
  const images = Array.from({ length: MAX_REQUEST_BYTES / upload.bytes.length }, () => upload);
  let called = false;
  await assert.rejects(call(async () => { called = true; return imageResponse(); }, INPUT, undefined, images), safeError(/200 MiB/));
  assert.equal(called, false);
});

test('rejects unsupported output formats and impossible counts before fetching', async () => {
  for (const parameters of [{ ...INPUT, output_format: SECRET }, { ...INPUT, n: 0 }, { ...INPUT, n: 1.5 }, { ...INPUT, n: NaN }]) {
    let called = false;
    await assert.rejects(call(async () => { called = true; return imageResponse(); }, parameters), safeError(/format must be|count must be/));
    assert.equal(called, false);
  }
});

test('returns response-level reported settings and aggregate usage on the first image only', async () => {
  const reported = { size: '1024x1024', quality: 'high', background: 'opaque', output_format: 'png' };
  const usage = { input_tokens: 4, output_tokens: 8, total_tokens: 12, input_tokens_details: { text_tokens: 4, image_tokens: 0 } };
  const result = await call(async () => Response.json({
    data: [PNG, PNG2].map(bytes => ({ b64_json: bytes.toString('base64'), model: SECRET, usage: { input_tokens: 999 }, size: SECRET })),
    ...reported, usage: { ...usage, account: SECRET, cost: 1.99 }, model: SECRET, effective_model: SECRET, safety_identifier: SECRET,
  }), { ...INPUT, n: 2 });
  assert.deepEqual(result, [
    { bytes: PNG, mime: 'image/png', reported, usage },
    { bytes: PNG2, mime: 'image/png' },
  ]);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('metadata is not fabricated from API request settings when the response omits it', async () => {
  const result = await call(async () => imageResponse());
  assert.equal(result[0]?.reported, undefined);
  assert.equal(result[0]?.usage, undefined);
});

test('API validation and header failures are local/not_submitted without calling fetch', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return imageResponse(); };
  for (const request of [
    () => call(fetcher, { ...INPUT, n: 0 }),
    () => generateApiImages(INPUT, [], {}, `${SECRET}\ninvalid`, new AbortController().signal, fetcher),
  ]) {
    await assert.rejects(request, (error: unknown) => {
      safeError(/count must be|request failed/)(error);
      assert.ok(error instanceof ImageRequestError);
      assert.equal(error.category, 'invalid_request');
      assert.equal(error.phase, 'local');
      assert.equal(error.outcome, 'not_submitted');
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('API failures distinguish rejection from ambiguous dispatch or response failures without retries', async () => {
  const cases = [
    { fetcher: async () => { throw new Error(SECRET); }, category: 'network', phase: 'dispatch', outcome: 'ambiguous', status: undefined },
    { fetcher: async () => new Response(SECRET), category: 'invalid_response', phase: 'response', outcome: 'ambiguous', status: undefined },
    { fetcher: async () => new Response(null, { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }), category: 'response_limit', phase: 'response', outcome: 'ambiguous', status: undefined },
    { fetcher: async () => new Response(new ReadableStream({ pull() { throw new Error(SECRET); } })), category: 'network', phase: 'response', outcome: 'ambiguous', status: undefined },
    { fetcher: async () => Response.json({ error: { code: 'insufficient_quota', message: SECRET } }, { status: 429 }), category: 'quota', phase: 'response', outcome: 'remote_rejected', status: 429 },
    { fetcher: async () => Response.json({ error: { code: 'content_policy_violation', message: SECRET } }, { status: 400 }), category: 'content_filter', phase: 'response', outcome: 'remote_rejected', status: 400 },
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

test('API cancellation identifies whether dispatch has started', async () => {
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
