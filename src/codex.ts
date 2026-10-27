import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

export type CodexAuth = { accessToken: string; accountId?: string };

export type ImageRequest = {
  prompt: string;
  background: 'opaque' | 'transparent';
  images?: readonly string[];
};

export type ImageResult = {
  bytes: Buffer;
  requestedModel: string;
  effectiveModel: null;
};

const MODEL = 'gpt-image-2';
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 48 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class ImageError extends Error {}

function cancellation(signal: AbortSignal): DOMException {
  const timeout = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  return new DOMException(
    timeout ? 'Image generation timed out.' : 'Image generation was cancelled.',
    timeout ? 'TimeoutError' : 'AbortError',
  );
}

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw cancellation(signal);
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  checkCancellation(signal);
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    discardBody(response);
    throw new ImageError('Codex image response exceeds the 48 MiB limit.');
  }
  if (!response.body) throw new ImageError('Codex returned no image data.');

  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  let complete = false;
  try {
    while (true) {
      checkCancellation(signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        checkCancellation(signal);
        throw new ImageError('Could not read the Codex image response.');
      }
      checkCancellation(signal);
      if (chunk.done) {
        complete = true;
        return buffer.toString('utf8', 0, size);
      }
      const length = size + chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        throw new ImageError('Codex image response exceeds the 48 MiB limit.');
      }
      if (length > buffer.length) {
        const expanded = Buffer.allocUnsafe(Math.min(MAX_BODY_BYTES, Math.max(length, buffer.length * 2)));
        buffer.copy(expanded, 0, 0, size);
        buffer = expanded;
      }
      buffer.set(chunk.value, size);
      size = length;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) abort();
    reader.releaseLock();
  }
}

function base64Size(value: string): number {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ImageError('Codex image data is not valid base64.');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const tail = value.slice(-4);
  if (Buffer.from(tail, 'base64').toString('base64') !== tail) {
    throw new ImageError('Codex image data is not valid base64.');
  }
  return value.length / 4 * 3 - padding;
}

function validatePng(bytes: Buffer): void {
  const invalid = () => new ImageError('Codex returned an invalid or truncated PNG image.');
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw invalid();
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw invalid();

  let offset = 33;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) throw invalid();
    offset += length + 12;
    if (type === 'IDAT' && length > 0) hasImageData = true;
    if (type === 'IEND') {
      if (length === 0 && offset === bytes.length && hasImageData) return;
      throw invalid();
    }
  }
  throw invalid();
}

function responseImage(body: string): Buffer {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ImageError('Codex returned invalid JSON.');
  }
  const data = value && typeof value === 'object' && 'data' in value ? value.data : undefined;
  const image: unknown = Array.isArray(data) ? data[0] : undefined;
  const encoded = image && typeof image === 'object' && 'b64_json' in image ? image.b64_json : undefined;
  if (typeof encoded !== 'string' || !encoded) throw new ImageError('Codex returned no image data.');
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || base64Size(encoded) > MAX_IMAGE_BYTES) {
    throw new ImageError('Codex image exceeds the 32 MiB limit.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  validatePng(bytes);
  return bytes;
}

function statusError(status: number): ImageError {
  if (status === 401) return new ImageError('Codex authentication expired or was rejected. Sign in to ChatGPT again.');
  if (status === 403) return new ImageError('Codex image access was denied for this ChatGPT account.');
  if (status === 429) return new ImageError('Codex image rate or usage limit reached. Try again later.');
  if (status >= 500) return new ImageError('Codex image service is temporarily unavailable. The request was not retried.');
  return new ImageError('Codex rejected the image request. The request was not retried.');
}

export async function generateImage(
  input: ImageRequest,
  auth: CodexAuth,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ImageResult> {
  try {
    checkCancellation(signal);
    const references = input.images ?? [];
    let requestSize = Buffer.byteLength(input.prompt);
    for (const image of references) {
      requestSize += Buffer.byteLength(image);
      if (requestSize > MAX_BODY_BYTES) throw new ImageError('Image request exceeds the 48 MiB limit.');
      if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(image)) {
        throw new ImageError('Reference images must be base64 image data URLs.');
      }
      base64Size(image.slice(image.indexOf(',') + 1));
    }
    if (requestSize > MAX_BODY_BYTES) throw new ImageError('Image request exceeds the 48 MiB limit.');
    const body = JSON.stringify({
      model: MODEL,
      quality: 'auto',
      size: 'auto',
      prompt: input.prompt,
      background: input.background,
      ...(references.length ? { images: references.map(image_url => ({ image_url })) } : {}),
    });
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new ImageError('Image request exceeds the 48 MiB limit.');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      originator: 'opencode',
      'x-codex-image-turn-id': randomUUID(),
    };
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
    const endpoint = references.length ? 'edits' : 'generations';
    const response = await fetcher(`https://chatgpt.com/backend-api/codex/images/${endpoint}`, {
      method: 'POST',
      headers,
      body,
      signal,
      redirect: 'error',
    });
    if (signal.aborted) {
      discardBody(response);
      throw cancellation(signal);
    }
    if (!response.ok) {
      discardBody(response);
      throw statusError(response.status);
    }
    const bytes = responseImage(await readBody(response, signal));
    checkCancellation(signal);
    return { bytes, requestedModel: MODEL, effectiveModel: null };
  } catch (error) {
    checkCancellation(signal);
    if (error instanceof ImageError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new DOMException('Image generation was cancelled.', 'AbortError');
    }
    throw new Error('Codex image request failed. Check connectivity. The request was not retried.');
  }
}
