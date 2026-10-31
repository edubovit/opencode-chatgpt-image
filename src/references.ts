import dns from "node:dns/promises";
import { realpath } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { imageType, readReferenceFile, resolveReferencePath } from "./files.ts";

export type Reference =
  | { readonly kind: "file"; readonly path: string; readonly directory: string; readonly external: boolean }
  | { readonly kind: "https"; readonly url: string };

type Authorize = (action: string, resources: string[]) => Promise<void>;
type Download = { bytes: Buffer } | { location: string };

class ReferenceDownloadError extends Error {
  constructor(detail: string) {
    super(`Reference download failed: ${detail}. No OpenAI request was made.`);
  }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20],
] as const) blocked.addSubnet(address, prefix, "ipv6");
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && !address.includes("%") && globalIPv6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

function referenceURL(source: string): URL {
  if (source !== source.trim() || /[\x00-\x20\x7f\\]/.test(source)) throw new ReferenceDownloadError("Reference URL contains unsupported characters");
  let url: URL;
  try { url = new URL(source); } catch { throw new ReferenceDownloadError("Invalid reference URL"); }
  if (url.protocol !== "https:") throw new ReferenceDownloadError("Remote reference images must use HTTPS");
  if (!/^https:\/\/[^/]/i.test(source)) throw new ReferenceDownloadError("Reference images require an absolute HTTPS URL");
  if (url.username || url.password || /^https:\/\/[^/?#]*@/i.test(source)) throw new ReferenceDownloadError("Reference URLs must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new ReferenceDownloadError("Reference URL must use a public IP address");
  } else if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host) || /(?:^|\.)home\.arpa$/.test(host)) {
    throw new ReferenceDownloadError("Reference URL must use a public host");
  }
  url.hash = "";
  return url;
}

export function describeReference(reference: Reference): string {
  return reference.kind === "file" ? reference.path : reference.url;
}

export async function prepareReference(directory: string, source: string, allowExternalReferences: boolean): Promise<Reference> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(source.trim()) && !/^[a-z]:[/\\]/i.test(source)) {
    return { kind: "https", url: referenceURL(source).href };
  }
  const root = await realpath(directory);
  const path = await resolveReferencePath(directory, source, allowExternalReferences);
  const difference = relative(root, path);
  const external = difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference);
  return { kind: "file", path, directory: root, external };
}

function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function publicAddress(url: URL, signal: AbortSignal): Promise<{ address: string; family: number }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] :
    await abortable(signal, () => dns.lookup(hostname.endsWith(".") ? hostname : `${hostname}.`, { all: true, verbatim: true }));
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new ReferenceDownloadError("Reference host must resolve only to public IP addresses");
  }
  signal.throwIfAborted();
  return addresses[0]!;
}

async function consume(response: IncomingMessage, limit: number): Promise<Download> {
  try {
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (!response.headers.location) throw new ReferenceDownloadError("Reference redirect is missing its location");
      return { location: response.headers.location };
    }
    if (status !== 200) throw new ReferenceDownloadError(`HTTP ${status}`);
    if (response.headers["content-encoding"] && response.headers["content-encoding"].toLowerCase() !== "identity") {
      throw new ReferenceDownloadError("Compressed reference responses are not supported");
    }
    const tooLarge = () => new ReferenceDownloadError(`Reference image exceeds the ${limit / 1024 / 1024} MiB limit`);
    if (Number(response.headers["content-length"]) > limit) throw tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > limit) throw tooLarge();
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks, size) };
  } finally {
    response.destroy();
  }
}

async function download(url: URL, signal: AbortSignal, limit: number): Promise<Download> {
  const pinned = await publicAddress(url, signal);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET", agent: false, signal, family: pinned.family,
      rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
      headers: { Accept: "image/png, image/jpeg, image/webp", "Accept-Encoding": "identity" },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, response => { void consume(response, limit).then(resolve, reject); });
    request.on("error", reject);
    request.end();
  });
}

export async function readReference(reference: Reference, signal: AbortSignal, limit: number, authorize: Authorize): Promise<{ bytes: Buffer; mime: string; name: string }> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Reference image byte limit must be a positive safe integer");
  if (reference.kind === "file") {
    signal.throwIfAborted();
    if (reference.external) await abortable(signal, () => authorize("external_directory", [join(dirname(reference.path), "*").replaceAll("\\", "/")]));
    await abortable(signal, () => authorize("read", [reference.path]));
    const current = await resolveReferencePath(reference.directory, reference.path, reference.external);
    if (current !== reference.path) throw new Error("Reference image path changed after permission approval");
    const image = await readReferenceFile(current, signal, limit, current);
    return { ...image, name: basename(current) };
  }
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal.aborted) throw new DOMException("Reference download cancelled. No OpenAI request was made.", "AbortError");
    let url = referenceURL(reference.url);
    await abortable(signal, () => authorize("webfetch", [url.href]));
    timer = setTimeout(() => deadline.abort(new ReferenceDownloadError("Timed out after 30 seconds")), 30_000);
    timer.unref();
    const downloadSignal = AbortSignal.any([signal, deadline.signal]);
    for (let redirects = 0; ; redirects++) {
      if (redirects) await abortable(downloadSignal, () => authorize("webfetch", [url.href]));
      let result: Download;
      try {
        result = await abortable(downloadSignal, () => download(url, downloadSignal, limit));
        downloadSignal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw new DOMException("Reference download cancelled. No OpenAI request was made.", "AbortError");
        if (deadline.signal.aborted) throw new ReferenceDownloadError("Timed out after 30 seconds");
        if (error instanceof ReferenceDownloadError) throw error;
        throw new ReferenceDownloadError("Could not download the public image");
      }
      if ("location" in result) {
        if (redirects >= 5) throw new ReferenceDownloadError("Reference image has too many redirects");
        if (/[\x00-\x20\x7f\\]/.test(result.location) || /^(?:https:)?\/{3,}/i.test(result.location) || /^(?:https:)?\/\/[^/?#]*@/i.test(result.location)) {
          throw new ReferenceDownloadError("Reference redirect contains unsupported characters or credentials");
        }
        let target: string;
        try { target = /^[a-z][a-z0-9+.-]*:/i.test(result.location) ? result.location : new URL(result.location, url).href; }
        catch { throw new ReferenceDownloadError("Invalid reference redirect URL"); }
        url = referenceURL(target);
        continue;
      }
      const mime = imageType(result.bytes);
      if (!mime) throw new ReferenceDownloadError("Reference image must be a valid PNG, JPEG, or WebP image");
      return { bytes: result.bytes, mime, name: `reference.${mime.slice("image/".length)}` };
    }
  } finally {
    clearTimeout(timer);
  }
}
