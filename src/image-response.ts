import { Buffer } from 'node:buffer';

export type ImageReported = {
  size?: string;
  quality?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'standard' | 'hd';
  background?: 'auto' | 'opaque' | 'transparent';
  output_format?: 'png' | 'jpeg' | 'webp';
};

export type ImageCacheTokens = {
  image_tokens?: number;
  text_tokens?: number;
  cached_image_tokens?: number;
  cached_text_tokens?: number;
};

export type ImageTokenDetails = {
  image_tokens?: number;
  text_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cached_tokens_details?: ImageCacheTokens;
};

export type ImageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  input_tokens_details?: ImageTokenDetails;
  output_tokens_details?: ImageTokenDetails;
  cached_tokens_details?: ImageCacheTokens;
};

export type ImageResponseMetadata = { reported?: ImageReported; usage?: ImageUsage };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function member<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined;
}

function counts<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  const source = record(value);
  for (const key of keys) {
    const count = source?.[key];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  return result;
}

function nonempty<T extends object>(value: T): T | undefined {
  return Object.keys(value).length ? value : undefined;
}

function cacheTokens(value: unknown): ImageCacheTokens | undefined {
  return nonempty(counts(value, ['image_tokens', 'text_tokens', 'cached_image_tokens', 'cached_text_tokens']));
}

function tokenDetails(value: unknown): ImageTokenDetails | undefined {
  const result: ImageTokenDetails = counts(value, ['image_tokens', 'text_tokens', 'cached_tokens', 'cache_write_tokens']);
  const cached = cacheTokens(record(value)?.cached_tokens_details);
  if (cached) result.cached_tokens_details = cached;
  return nonempty(result);
}

export function imageResponseMetadata(value: unknown): ImageResponseMetadata {
  const source = record(value);
  const reported: ImageReported = {};
  const size = source?.size;
  if (typeof size === 'string' && size === size.trim() && (size === 'auto' || /^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(size))) reported.size = size;
  const quality = member(source?.quality, ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'standard', 'hd']);
  const background = member(source?.background, ['auto', 'opaque', 'transparent']);
  const format = member(source?.output_format, ['png', 'jpeg', 'webp']);
  if (quality) reported.quality = quality;
  if (background) reported.background = background;
  if (format) reported.output_format = format;

  const rawUsage = record(source?.usage);
  const usage: ImageUsage = counts(rawUsage, ['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens']);
  const input = tokenDetails(rawUsage?.input_tokens_details);
  const output = tokenDetails(rawUsage?.output_tokens_details);
  const cached = cacheTokens(rawUsage?.cached_tokens_details);
  if (input) usage.input_tokens_details = input;
  if (output) usage.output_tokens_details = output;
  if (cached) usage.cached_tokens_details = cached;
  const result: ImageResponseMetadata = {};
  if (nonempty(reported)) result.reported = reported;
  if (nonempty(usage)) result.usage = usage;
  return result;
}

export type ImageErrorCategory =
  | 'invalid_request' | 'authentication' | 'access_denied' | 'content_filter'
  | 'quota' | 'rate_limit' | 'rate_limit_or_quota' | 'remote_error'
  | 'network' | 'invalid_response' | 'response_limit' | 'cancelled' | 'timeout';
export type ImageErrorPhase = 'local' | 'dispatch' | 'response';
export type ImageErrorOutcome = 'not_submitted' | 'remote_rejected' | 'ambiguous';

type ErrorContext = {
  phase: ImageErrorPhase;
  outcome: ImageErrorOutcome;
  status?: number;
  retryAfterMs?: number;
};

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export class ImageRequestError extends Error {
  readonly category: ImageErrorCategory;
  readonly phase: ImageErrorPhase;
  readonly outcome: ImageErrorOutcome;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(category: ImageErrorCategory, message: string, context: ErrorContext) {
    const status = Number.isInteger(context.status) && context.status! >= 100 && context.status! <= 599 ? context.status : undefined;
    const retryAfterMs = Number.isSafeInteger(context.retryAfterMs) && context.retryAfterMs! >= 0 && context.retryAfterMs! <= MAX_RETRY_AFTER_MS
      ? context.retryAfterMs : undefined;
    const guidance = context.outcome === 'not_submitted'
      ? 'No request was submitted. Review the request and configuration.'
      : context.outcome === 'remote_rejected'
        ? 'The service rejected the request.'
        : 'The request may have been processed; completion and any usage are unknown. Check provider usage before deciding whether to submit again.';
    const retry = retryAfterMs === undefined ? '' : ` Provider retry delay: ${retryAfterMs} ms.`;
    super(`[${category}; ${context.phase}; ${context.outcome}${status === undefined ? '' : `; HTTP ${status}`}] ${message} ${guidance}${retry} The request was not retried.`);
    this.name = category === 'cancelled' ? 'AbortError' : category === 'timeout' ? 'TimeoutError' : 'ImageRequestError';
    this.category = category;
    this.phase = context.phase;
    this.outcome = context.outcome;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export function imageCancellation(signal: AbortSignal, phase: ImageErrorPhase): ImageRequestError {
  const timeout = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  return new ImageRequestError(timeout ? 'timeout' : 'cancelled', timeout ? 'Image generation timed out.' : 'Image generation was cancelled.', {
    phase, outcome: phase === 'local' ? 'not_submitted' : 'ambiguous',
  });
}

function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw || raw.length > 64) return undefined;
  let delay: number;
  if (/^\d{1,6}(?:\.\d{1,3})?$/.test(raw)) delay = Math.ceil(Number(raw) * 1000);
  else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
    delay = Math.max(0, Date.parse(raw) - Date.now());
  } else return undefined;
  return Number.isSafeInteger(delay) && delay >= 0 && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

type RejectionCategory = 'content_filter' | 'quota' | 'rate_limit';

function rejectionCategory(value: unknown): RejectionCategory | undefined {
  if (value === 'content_policy_violation' || value === 'image_content_policy_violation' || value === 'moderation_blocked') return 'content_filter';
  if (value === 'insufficient_quota' || value === 'billing_hard_limit_reached') return 'quota';
  if (value === 'rate_limit_exceeded') return 'rate_limit';
  return undefined;
}

async function errorCategory(response: Response, signal: AbortSignal): Promise<RejectionCategory | undefined> {
  const maxBytes = 64 * 1024;
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if ((type !== 'application/json' && type !== 'application/problem+json')
    || Number(response.headers.get('content-length')) > maxBytes || !response.body) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const buffer = Buffer.allocUnsafe(maxBytes);
  let size = 0;
  let complete = false;
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        const error = record(record(JSON.parse(buffer.toString('utf8', 0, size)))?.error);
        return rejectionCategory(error?.code) ?? rejectionCategory(error?.type);
      }
      if (size + chunk.value.byteLength > maxBytes) return undefined;
      buffer.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) abort();
    reader.releaseLock();
  }
  return undefined;
}

export async function imageStatusError(provider: 'OpenAI' | 'Codex', response: Response, signal: AbortSignal): Promise<ImageRequestError> {
  const category = await errorCategory(response, signal);
  if (signal.aborted) throw imageCancellation(signal, 'response');
  const status = response.status;
  const context: ErrorContext = {
    phase: 'response', outcome: status >= 500 || status === 408 ? 'ambiguous' : 'remote_rejected',
    status, retryAfterMs: retryAfter(response.headers),
  };
  if (status === 401) return new ImageRequestError('authentication', provider === 'OpenAI'
    ? 'OpenAI API authentication was rejected. Check the configured API key.'
    : 'Codex authentication expired or was rejected. Sign in to ChatGPT again.', context);
  if (status === 408) return new ImageRequestError('timeout', `${provider} image request timed out at the service. Check service status.`, context);
  if (status >= 400 && status < 500 && category === 'content_filter') {
    return new ImageRequestError(category, `${provider} rejected the image request through its content filter. Review the prompt and reference images for policy compliance.`, context);
  }
  if (status >= 400 && status < 500 && category === 'quota') {
    return new ImageRequestError(category, provider === 'OpenAI'
      ? 'OpenAI image quota was exhausted. Check API project billing, credits, and spending limits.'
      : 'Codex image quota was exhausted. Check ChatGPT plan usage and allowance.', context);
  }
  if (status >= 400 && status < 500 && category === 'rate_limit') {
    return new ImageRequestError(category, `${provider} image rate limit reached. Wait for the limit to reset before deciding whether to submit again.`, context);
  }
  if (status === 403) return new ImageRequestError('access_denied', provider === 'OpenAI'
    ? 'OpenAI image access was denied for this API project. Check project and model permissions.'
    : 'Codex image access was denied for this ChatGPT account. Check account access and plan eligibility.', context);
  if (status === 429) return new ImageRequestError('rate_limit_or_quota', `${provider} image rate or usage limit reached. Check provider usage and limits.`, context);
  if (status >= 500) return new ImageRequestError('remote_error', `${provider} image service is temporarily unavailable. Check service status.`, context);
  return new ImageRequestError('remote_error', `${provider} rejected the image request. Check supported parameters and account access.`, context);
}
