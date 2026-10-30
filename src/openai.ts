import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

export type ImageUpload = { bytes: Buffer; mime: string; name: string };
export type ApiImage = { bytes: Buffer; mime: string };

const MAX_REQUEST_BYTES = 200 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

class ImageError extends Error {
  constructor(message: string) {
    super(`${message} The request was not retried.`);
  }
}

function cancellation(signal: AbortSignal): DOMException {
  const timeout = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  return new DOMException(
    timeout ? 'Image generation timed out. The request was not retried.' : 'Image generation was cancelled. The request was not retried.',
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
    throw new ImageError('OpenAI image response exceeds the 256 MiB limit.');
  }
  if (!response.body) throw new ImageError('OpenAI returned no image data.');

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
        throw new ImageError('Could not read the OpenAI image response.');
      }
      checkCancellation(signal);
      if (chunk.done) {
        complete = true;
        return buffer.toString('utf8', 0, size);
      }
      const length = size + chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new ImageError('OpenAI image response exceeds the 256 MiB limit.');
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

function validPng(bytes: Buffer): boolean {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff
    || !depths[bytes[25]!]?.includes(bytes[24]!)
    || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) return false;
  let offset = 33;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || type === 'IHDR') return false;
    offset += length + 12;
    if (type === 'IDAT' && length > 0) hasData = true;
    if (type === 'IEND') return length === 0 && offset === bytes.length && hasData;
  }
  return false;
}

function validJpeg(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  let hasData = false;
  let scanning = false;
  while (offset < bytes.length) {
    if (scanning) {
      const marker = bytes.indexOf(0xff, offset);
      if (marker < 0) return false;
      if (marker > offset) hasData = true;
      offset = marker;
    }
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) return false;
    if (scanning && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) {
      if (marker === 0) hasData = true;
      continue;
    }
    scanning = false;
    if (marker === 0xd9) return offset === bytes.length && hasFrame && hasScan && hasData;
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)
      || offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 11 || length !== 8 + 3 * bytes[offset + 7]!
        || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) return false;
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (!hasFrame || length < 8 || length !== 6 + 2 * bytes[offset + 2]!) return false;
      hasScan = true;
      scanning = true;
    }
    offset += length;
  }
  return false;
}

function validWebp(bytes: Buffer): boolean {
  if (bytes.length < 26 || bytes.toString('latin1', 0, 4) !== 'RIFF'
    || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('latin1', 8, 12) !== 'WEBP'
    || !['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16))) return false;
  let offset = 12;
  let hasData = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + (length % 2) > bytes.length || (length % 2 && bytes[end] !== 0)) return false;
    if (type === 'VP8X' && (offset !== 12 || length !== 10)) return false;
    if (type === 'VP8 ' || type === 'VP8L') {
      if (hasData) return false;
      if (type === 'VP8 ' && (length <= 10 || (bytes[start]! & 1) !== 0
        || bytes.toString('hex', start + 3, start + 6) !== '9d012a'
        || !(bytes.readUInt16LE(start + 6) & 0x3fff) || !(bytes.readUInt16LE(start + 8) & 0x3fff))) return false;
      if (type === 'VP8L' && (length <= 5 || bytes[start] !== 0x2f || (bytes[start + 4]! & 0xe0) !== 0)) return false;
      hasData = true;
    }
    offset = end + (length % 2);
  }
  return offset === bytes.length && hasData;
}

function imageMime(bytes: Buffer): string {
  if (validPng(bytes)) return 'image/png';
  if (validJpeg(bytes)) return 'image/jpeg';
  if (validWebp(bytes)) return 'image/webp';
  throw new ImageError('OpenAI returned an invalid or truncated PNG, JPEG, or WebP image.');
}

function decodeImage(encoded: unknown, format: string): ApiImage {
  if (typeof encoded !== 'string' || !encoded) throw new ImageError('OpenAI returned no image data.');
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new ImageError('OpenAI image exceeds the 32 MiB limit.');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new ImageError('OpenAI image data is not valid base64.');
  }
  const tail = encoded.slice(-4);
  if (Buffer.from(tail, 'base64').toString('base64') !== tail) throw new ImageError('OpenAI image data is not valid base64.');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (encoded.length / 4 * 3 - padding > MAX_IMAGE_BYTES) throw new ImageError('OpenAI image exceeds the 32 MiB limit.');
  const bytes = Buffer.from(encoded, 'base64');
  const mime = imageMime(bytes);
  if (mime !== `image/${format}`) throw new ImageError('OpenAI returned an image that does not match the requested output format.');
  return { bytes, mime };
}

function responseImages(body: string, count: number, format: string, signal: AbortSignal): ApiImage[] {
  checkCancellation(signal);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ImageError('OpenAI returned invalid JSON.');
  }
  const data = value && typeof value === 'object' && 'data' in value ? value.data : undefined;
  if (!Array.isArray(data)) throw new ImageError('OpenAI returned no image data.');
  if (data.length !== count) throw new ImageError('OpenAI did not return the requested number of images.');
  return data.map((image: unknown) => {
    checkCancellation(signal);
    const encoded = image && typeof image === 'object' && 'b64_json' in image ? image.b64_json : undefined;
    return decodeImage(encoded, format);
  });
}

function statusError(status: number): ImageError {
  if (status === 401) return new ImageError('OpenAI API authentication was rejected. Check the configured API key.');
  if (status === 403) return new ImageError('OpenAI image access was denied for this API project.');
  if (status === 429) return new ImageError('OpenAI image rate or usage limit reached.');
  if (status >= 500) return new ImageError('OpenAI image service is temporarily unavailable.');
  return new ImageError('OpenAI rejected the image request.');
}

export async function generateApiImages(
  parameters: Readonly<Record<string, string | number>>,
  images: readonly ImageUpload[],
  overlays: { mask?: ImageUpload; markup?: ImageUpload },
  apiKey: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ApiImage[]> {
  try {
    checkCancellation(signal);
    if (!apiKey.trim()) throw new ImageError('An OpenAI API key must be configured.');
    if ((overlays.mask || overlays.markup) && !images.length) throw new ImageError('An image mask or markup requires a reference image.');
    const count = Number(parameters.n ?? 1);
    const format = String(parameters.output_format ?? 'png');
    if (!Number.isSafeInteger(count) || count < 1) throw new ImageError('The requested image count must be a positive integer.');
    if (!['png', 'jpeg', 'webp'].includes(format)) throw new ImageError('The requested output format must be PNG, JPEG, or WebP.');
    const entries = Object.entries(parameters).filter(([key]) => !['orientation', 'response_format', 'stream'].includes(key));
    const uploads = [...images, ...[overlays.mask, overlays.markup].filter(image => image !== undefined)];
    let size = 0;
    for (const upload of uploads) {
      size += upload.bytes.length;
      if (size > MAX_REQUEST_BYTES) throw new ImageError('OpenAI image request exceeds the 200 MiB upload and parameter limit.');
    }
    for (const [key, value] of entries) {
      size += Buffer.byteLength(key) + Buffer.byteLength(String(value));
      if (size > MAX_REQUEST_BYTES) throw new ImageError('OpenAI image request exceeds the 200 MiB upload and parameter limit.');
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    let body: string | FormData;
    if (images.length) {
      body = new FormData();
      for (const [key, value] of entries) body.append(key, String(value));
      for (const image of images) {
        checkCancellation(signal);
        body.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), posix.basename(image.name.replaceAll('\\', '/')));
      }
      for (const [key, image] of Object.entries(overlays)) {
        if (image) body.append(key, new Blob([new Uint8Array(image.bytes)], { type: image.mime }), posix.basename(image.name.replaceAll('\\', '/')));
      }
    } else {
      body = JSON.stringify(Object.fromEntries(entries));
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ImageError('OpenAI image request exceeds the 200 MiB upload and parameter limit.');
      headers['Content-Type'] = 'application/json';
    }
    checkCancellation(signal);
    const endpoint = images.length ? 'edits' : 'generations';
    const response = await fetcher(`https://api.openai.com/v1/images/${endpoint}`, {
      method: 'POST', headers, body, signal, redirect: 'error',
    });
    if (signal.aborted) {
      discardBody(response);
      throw cancellation(signal);
    }
    if (!response.ok) {
      discardBody(response);
      throw statusError(response.status);
    }
    const result = responseImages(await readBody(response, signal), count, format, signal);
    checkCancellation(signal);
    return result;
  } catch (error) {
    checkCancellation(signal);
    if (error instanceof ImageError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new DOMException('Image generation was cancelled. The request was not retried.', 'AbortError');
    }
    throw new Error('OpenAI image request failed. Check connectivity. The request was not retried.');
  }
}
