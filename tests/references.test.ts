import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import https from "node:https";
import type { RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { describeReference, isPublicAddress, prepareReference, readReference } from "../src/references.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY/jPwPAfAAUAAf+mXJtdAAAAAElFTkSuQmCC", "base64");
const webp = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA", "base64");
const signal = () => new AbortController().signal;
const allow = async () => {};
const limit = 10 * 1024 * 1024;

async function workspace(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "opencode-image-references-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "session");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root: await realpath(root), outside: await realpath(outside) };
}

async function link(t: TestContext, target: string, path: string) {
  try {
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Creating symlinks is not supported in this environment");
      return false;
    }
    throw error;
  }
}

type Reply = {
  status?: number;
  headers?: IncomingHttpHeaders;
  chunks?: Buffer[];
  pending?: "headers" | "body";
  error?: Error;
  streamError?: Error;
};

function network(t: TestContext, replies: Reply[] = [{}]) {
  const events: string[] = [];
  const requests: { url: URL; options: RequestOptions; response: IncomingMessage }[] = [];
  const lookup = t.mock.method(dns, "lookup", async (host: string) => {
    events.push(`dns:${host}`);
    return [{ address: "93.184.215.14", family: 4 }];
  });
  const request = t.mock.method(https, "request", (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    events.push(`request:${url.href}`);
    const reply = replies[requests.length] ?? replies.at(-1)!;
    const response = Object.assign(new PassThrough(), { statusCode: reply.status ?? 200, headers: reply.headers ?? {} }) as unknown as IncomingMessage;
    const emitter = new EventEmitter();
    const abort = () => {
      response.destroy();
      emitter.emit("error", options.signal!.reason);
    };
    options.signal!.addEventListener("abort", abort, { once: true });
    response.once("close", () => options.signal!.removeEventListener("abort", abort));
    requests.push({ url, options, response });
    return Object.assign(emitter, {
      end() {
        queueMicrotask(() => {
          if (reply.error) { emitter.emit("error", reply.error); response.destroy(); return; }
          if (reply.pending === "headers") return;
          callback(response);
          if (reply.streamError) { response.destroy(reply.streamError); return; }
          if (reply.pending === "body") return;
          for (const chunk of reply.chunks ?? [png]) (response as unknown as PassThrough).write(chunk);
          (response as unknown as PassThrough).end();
        });
      },
    });
  });
  const authorize = async (action: string, resources: string[]) => { events.push(`${action}:${resources.join(",")}`); };
  return { events, requests, lookup, request, authorize };
}

test("local preflight is canonical and local reads request permission before reading", async t => {
  const { root } = await workspace(t);
  const path = join(root, "image.data");
  await writeFile(path, png);
  const reference = await prepareReference(root, "image.data", false);
  assert.deepEqual(reference, { kind: "file", path, directory: root, external: false });
  assert.equal(describeReference(reference), path);
  const permissions: unknown[] = [];
  const image = await readReference(reference, signal(), limit, async (action, resources) => {
    permissions.push([action, resources]);
    await writeFile(path, webp);
  });
  assert.deepEqual(permissions, [["read", [path]]]);
  assert.deepEqual(image, { bytes: webp, mime: "image/webp", name: "image.data" });
});

test("external files require the opt-in and both canonical directory and file permissions", async t => {
  const { root, outside } = await workspace(t);
  const path = join(outside, "image.png");
  await writeFile(path, png);
  await assert.rejects(prepareReference(root, path, false), /within the session directory/);
  await assert.rejects(prepareReference(root, "../outside/image.png", false), /within the session directory/);
  const reference = await prepareReference(root, path, true);
  assert.deepEqual(reference, { kind: "file", path, directory: root, external: true });
  const permissions: unknown[] = [];
  await readReference(reference, signal(), limit, async (action, resources) => { permissions.push([action, resources]); });
  assert.deepEqual(permissions, [["external_directory", [join(dirname(path), "*").replaceAll("\\", "/")]], ["read", [path]]]);
  if (!(await link(t, outside, join(root, "alias")))) return;
  await assert.rejects(prepareReference(root, "alias/image.png", false), /within the session directory/);
  assert.deepEqual(await prepareReference(root, "alias/image.png", true), reference);
});

test("denied external permission never attempts read permission or reads bytes", async t => {
  const { root, outside } = await workspace(t);
  const path = join(outside, "not-an-image.txt");
  await writeFile(path, "secret");
  const reference = await prepareReference(root, path, true);
  const denied = new Error("permission denied");
  const actions: string[] = [];
  await assert.rejects(readReference(reference, signal(), limit, async action => { actions.push(action); throw denied; }), error => error === denied);
  assert.deepEqual(actions, ["external_directory"]);
});

test("canonical file paths are revalidated after permission even with external opt-in", async t => {
  const { root, outside } = await workspace(t);
  const folder = join(root, "folder");
  await mkdir(folder);
  await writeFile(join(folder, "image.png"), png);
  await writeFile(join(outside, "image.png"), png);
  if (!(await link(t, outside, join(root, "probe")))) return;
  const reference = await prepareReference(root, "folder/image.png", true);
  await assert.rejects(readReference(reference, signal(), limit, async () => {
    await rename(folder, join(root, "moved"));
    await link(t, outside, folder);
  }), /within the session directory|path changed/);
});

test("network filesystem paths are rejected even with opt-in", async t => {
  const { root } = await workspace(t);
  for (const source of ["\\\\server\\share\\image.png", "//server/share/image.png", "\\\\?\\C:\\image.png"]) {
    await assert.rejects(prepareReference(root, source, true), /Network reference paths/);
  }
});

test("HTTPS preflight validates without filesystem, DNS, or network access", async t => {
  const net = network(t);
  const reference = await prepareReference("nonexistent-directory", "https://EXAMPLE.com/image.png?size=2#ignored", false);
  assert.deepEqual(reference, { kind: "https", url: "https://example.com/image.png?size=2" });
  assert.equal(describeReference(reference), "https://example.com/image.png?size=2");
  assert.equal(net.lookup.mock.callCount(), 0);
  assert.equal(net.request.mock.callCount(), 0);
});

test("URLs reject insecure schemes, credentials, special hosts and nonpublic IP literals", async () => {
  for (const source of [
    "http://example.com/image.png", "file:///image.png", "data:image/png;base64,AA==",
    "https://user:secret@example.com/image.png", "https://@example.com/image.png",
    "https:////@example.com/image.png", "https:example.com/image.png", " https://example.com/image.png",
    "https://localhost/image.png", "https://LOCALHOST./image.png", "https://printer/image.png",
    "https://device.local/image.png", "https://home.arpa/image.png", "https://host.home.arpa/image.png",
    "https://host.internal/image.png", "https://host.test/image.png", "https://host.onion/image.png",
    "https://127.1/image.png", "https://2130706433/image.png", "https://0x7f000001/image.png",
    "https://0177.0.0.1/image.png", "https://10.1.2.3/image.png", "https://169.254.169.254/image.png",
    "https://192.0.2.1/image.png", "https://[::1]/image.png", "https://[::ffff:8.8.8.8]/image.png",
    "https://[64:ff9b::808:808]/image.png", "https://[fe80::1]/image.png", "https://[2001:db8::1]/image.png",
    "https://example.com/\nimage.png", "https://example.com\\@localhost/image.png",
  ]) await assert.rejects(prepareReference("unused", source, true), source);
});

test("public address classification rejects private, reserved, multicast and transition ranges", () => {
  for (const address of [
    "invalid", "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1",
    "192.0.0.1", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.0.1",
    "192.175.48.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:93.184.215.14", "64:ff9b::1", "100::1", "fc00::1", "fdff::1", "fe80::1", "ff02::1",
    "2001::1", "2001:20::1", "2001:db8::1", "2002:0808:0808::1", "2620:4f:8000::1", "3fff::1", "4000::1",
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "93.184.215.14", "172.15.255.255", "172.32.0.1", "2001:4860:4860::8888", "2606:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("webfetch denial preserves the exact permission rejection before DNS and requests", async t => {
  const net = network(t);
  const reference = await prepareReference("unused", "https://example.com/image.png", false);
  const denied = new Error("denied");
  await assert.rejects(readReference(reference, signal(), limit, async () => { throw denied; }), error => error === denied);
  assert.deepEqual(net.events, []);
});

test("DNS must resolve only public addresses and is not bypassed by mixed answers", async t => {
  const net = network(t);
  for (const addresses of [[], [{ address: "10.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }]]) {
    net.lookup.mock.mockImplementation(async () => addresses);
    const reference = await prepareReference("unused", "https://example.com/image.png", false);
    await assert.rejects(readReference(reference, signal(), limit, net.authorize), /only to public/);
  }
  assert.equal(net.request.mock.callCount(), 0);
});

test("HTTPS uses pinned DNS, normal TLS validation, no proxy agent, no credentials, and content-detected MIME", async t => {
  const net = network(t, [{ headers: { "content-type": "text/plain", "set-cookie": ["secret=ignored"] }, chunks: [webp] }]);
  const reference = await prepareReference("unused", "https://example.com/not-an-image.jpg?size=2", false);
  const result = await readReference(reference, signal(), limit, net.authorize);
  assert.deepEqual(result, { bytes: webp, mime: "image/webp", name: "reference.webp" });
  assert.deepEqual(net.events, ["webfetch:https://example.com/not-an-image.jpg?size=2", "dns:example.com.", "request:https://example.com/not-an-image.jpg?size=2"]);
  const { options } = net.requests[0]!;
  assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.family, 4);
  assert.equal(options.auth, undefined);
  assert.deepEqual(options.headers, { Accept: "image/png, image/jpeg, image/webp", "Accept-Encoding": "identity" });
  assert.ok(options.lookup);
  options.lookup("example.com", {}, ((error: Error | null, address: string, family: number) => {
    assert.equal(error, null);
    assert.equal(address, "93.184.215.14");
    assert.equal(family, 4);
  }) as Parameters<NonNullable<RequestOptions["lookup"]>>[2]);
  assert.equal(net.lookup.mock.callCount(), 1);
});

test("public IP literals skip DNS and IPv6 DNS results are pinned as IPv6", async t => {
  const net = network(t);
  let reference = await prepareReference("unused", "https://8.8.8.8/image.png", false);
  await readReference(reference, signal(), limit, allow);
  assert.equal(net.lookup.mock.callCount(), 0);
  net.lookup.mock.mockImplementation(async () => [{ address: "2606:4700::1111", family: 6 }]);
  reference = await prepareReference("unused", "https://example.com/image.png", false);
  await readReference(reference, signal(), limit, allow);
  assert.equal(net.requests[1]!.options.family, 6);
});

test("redirects require fresh permission and validated DNS, without cookie or auth forwarding", async t => {
  const net = network(t, [
    { status: 302, headers: { location: "https://cdn.example.com/next", "set-cookie": ["secret=ignored"] } },
    { status: 307, headers: { location: "/final" } },
    {},
  ]);
  const reference = await prepareReference("unused", "https://example.com/start", false);
  await readReference(reference, signal(), limit, net.authorize);
  assert.deepEqual(net.events, [
    "webfetch:https://example.com/start", "dns:example.com.", "request:https://example.com/start",
    "webfetch:https://cdn.example.com/next", "dns:cdn.example.com.", "request:https://cdn.example.com/next",
    "webfetch:https://cdn.example.com/final", "dns:cdn.example.com.", "request:https://cdn.example.com/final",
  ]);
  for (const { options, response } of net.requests) {
    assert.deepEqual(options.headers, { Accept: "image/png, image/jpeg, image/webp", "Accept-Encoding": "identity" });
    assert.equal(response.destroyed, true);
  }
});

test("redirects cannot downgrade HTTPS, add credentials, reach private hosts, or loop forever", async t => {
  const net = network(t);
  const reference = await prepareReference("unused", "https://example.com/start", false);
  for (const location of ["http://example.com/x", "https://user:pass@example.com/x", "//user@example.com/x", "//@@example.com/x", "https:////@example.com/x", "////@example.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x"]) {
    net.requests.length = 0;
    net.request.mock.mockImplementationOnce((_url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const response = Object.assign(new PassThrough(), { statusCode: 302, headers: { location } }) as unknown as IncomingMessage;
      return Object.assign(new EventEmitter(), { end() { queueMicrotask(() => callback(response)); } });
    });
    const before = net.lookup.mock.callCount();
    await assert.rejects(readReference(reference, signal(), limit, allow));
    assert.equal(net.lookup.mock.callCount(), before + 1);
  }
  net.lookup.mock.mockImplementation(async (host: string) => [{ address: host === "private.example.com." ? "192.168.1.1" : "8.8.8.8", family: 4 }]);
  net.request.mock.mockImplementation((_url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const response = Object.assign(new PassThrough(), { statusCode: 302, headers: { location: "https://private.example.com/x" } }) as unknown as IncomingMessage;
    return Object.assign(new EventEmitter(), { end() { queueMicrotask(() => callback(response)); } });
  });
  await assert.rejects(readReference(reference, signal(), limit, allow), /only to public/);
});

test("a redirect loop is capped at five redirects", async t => {
  const net = network(t, [{ status: 302, headers: { location: "/loop" } }]);
  const reference = await prepareReference("unused", "https://example.com/start", false);
  await assert.rejects(readReference(reference, signal(), limit, allow), /too many redirects/);
  assert.equal(net.requests.length, 6);
});

test("denied redirect permission preserves the exact rejection without redirected DNS or network", async t => {
  const net = network(t, [{ status: 302, headers: { location: "https://cdn.example.com/image.png?token=secret" } }]);
  const reference = await prepareReference("unused", "https://example.com/start", false);
  let permissions = 0;
  const denied = new Error("permission denied");
  await assert.rejects(readReference(reference, signal(), limit, async () => {
    if (++permissions > 1) throw denied;
  }), error => error === denied);
  assert.equal(permissions, 2);
  assert.equal(net.lookup.mock.callCount(), 1);
  assert.equal(net.requests.length, 1);
});

test("download rejects excessive declared or streamed size, unsupported bytes, encoding, and unsuccessful responses", async t => {
  const net = network(t, [
    { headers: { "content-length": String(png.length + 1) } },
    { headers: { "content-length": "1" }, chunks: [png, Buffer.from("x")] },
    { chunks: [Buffer.from("<html>not an image</html>")] },
    { headers: { "content-encoding": "gzip" } },
    { status: 404 },
    { status: 302 },
    { error: new Error("TLS certificate verification failed") },
  ]);
  const reference = await prepareReference("unused", "https://example.com/image.png", false);
  for (const error of [/MiB limit/, /MiB limit/, /PNG, JPEG, or WebP/, /Compressed/, /HTTP 404/, /missing its location/, /Could not download/]) {
    await assert.rejects(readReference(reference, signal(), png.length, allow), error);
  }
  assert.ok(net.requests.every(({ response }) => response.destroyed));
});

test("remote failures never expose DNS, TLS, request, stream, or URL details and never call OpenAI", async t => {
  const secret = "s3cr3t-signed-query";
  const safe = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Reference download failed:/);
    assert.match(error.message, /No OpenAI request was made\./);
    assert.doesNotMatch(error.stack ?? "", /s3cr3t/);
    assert.doesNotMatch(JSON.stringify(error), /s3cr3t/);
    assert.equal(error.cause, undefined);
    return true;
  };
  for (const stage of ["dns", "tls", "request", "stream", "redirect", "content", "HTTP"]) {
    await t.test(stage, async t => {
      const raw = Object.assign(new Error(`upstream ${secret}`, { cause: new Error(secret) }), { input: `https://example.com/?token=${secret}`, code: secret });
      const reply: Reply = stage === "tls" ? { error: raw } : stage === "stream" ? { streamError: raw } :
        stage === "redirect" ? { status: 302, headers: { location: `https://[invalid]?token=${secret}` } } :
        stage === "content" ? { chunks: [Buffer.from(secret)] } : stage === "HTTP" ? { status: 403, chunks: [Buffer.from(secret)] } : {};
      const net = network(t, [reply]);
      const openai = t.mock.method(globalThis, "fetch", async () => { throw new Error("OpenAI must not be called"); });
      if (stage === "dns") net.lookup.mock.mockImplementation(async () => { throw raw; });
      if (stage === "request") net.request.mock.mockImplementation(() => { throw raw; });
      const reference = await prepareReference("unused", `https://example.com/image.png?token=${secret}`, false);
      await assert.rejects(readReference(reference, signal(), limit, allow), safe);
      assert.equal(openai.mock.callCount(), 0);
    });
  }
  for (const source of [`https://[invalid]?token=${secret}`, `https://user:${secret}@example.com/image.png`]) {
    await assert.rejects(prepareReference("unused", source, false), safe);
  }
});

test("remote cancellation never exposes its reason before or during a request", async t => {
  const net = network(t, [{ pending: "body" }]);
  const reference = await prepareReference("unused", "https://example.com/image.png?token=secret-query", false);
  for (const early of [true, false]) {
    const controller = new AbortController();
    if (early) controller.abort(new Error("secret-abort-reason"));
    const rejected = assert.rejects(readReference(reference, controller.signal, limit, allow), (error: Error) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.message, "Reference download cancelled. No OpenAI request was made.");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack ?? "", /secret/);
      return true;
    });
    if (!early) { await setImmediate(); controller.abort(new Error("secret-abort-reason")); }
    await rejected;
  }
  assert.equal(net.requests.length, 1);
});

test("cancellation while permission or DNS is pending never starts a request", async t => {
  const net = network(t);
  const reference = await prepareReference("unused", "https://example.com/image.png", false);
  for (const stage of ["permission", "dns"]) {
    const controller = new AbortController();
    const pending = Promise.withResolvers<never>();
    const entered = Promise.withResolvers<void>();
    const hang = async () => { entered.resolve(); return pending.promise; };
    if (stage === "dns") net.lookup.mock.mockImplementation(hang);
    const operation = readReference(reference, controller.signal, limit, stage === "permission" ? hang : allow);
    const rejected = assert.rejects(operation, { name: "AbortError" });
    await entered.promise;
    controller.abort();
    await rejected;
    pending.reject(new Error("late error is handled"));
  }
  assert.equal(net.request.mock.callCount(), 0);
});

test("cancellation destroys pending header and body downloads", async t => {
  const net = network(t, [{ pending: "headers" }, { pending: "body" }]);
  const reference = await prepareReference("unused", "https://example.com/image.png", false);
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    const operation = readReference(reference, controller.signal, limit, allow);
    const rejected = assert.rejects(operation, { name: "AbortError" });
    await setImmediate();
    controller.abort();
    await rejected;
    assert.equal(net.requests[i]!.response.destroyed, true);
  }
});

test("the 30-second download deadline covers stalled DNS and response streaming", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const net = network(t, [{ pending: "body" }]);
  const reference = await prepareReference("unused", "https://example.com/image.png", false);
  for (const stage of ["dns", "body"]) {
    if (stage === "dns") net.lookup.mock.mockImplementationOnce(async () => new Promise<never>(() => {}));
    const rejected = assert.rejects(readReference(reference, signal(), limit, allow), /Timed out after 30 seconds/);
    await setImmediate();
    t.mock.timers.tick(30_000);
    await rejected;
  }
  assert.equal(net.requests.length, 1);
  assert.equal(net.requests[0]!.response.destroyed, true);
});

test("redirects do not reset the total download deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const net = network(t, [{ status: 302, headers: { location: "/next" } }, { pending: "body" }]);
  const reference = await prepareReference("unused", "https://example.com/start", false);
  let permissions = 0;
  const rejected = assert.rejects(readReference(reference, signal(), limit, async () => {
    if (++permissions === 2) t.mock.timers.tick(29_000);
  }), /Timed out after 30 seconds/);
  await setImmediate();
  assert.equal(net.requests.length, 2);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(net.requests[1]!.response.destroyed, true);
});

test("already-aborted reads and invalid byte limits do not ask permissions or access network", async t => {
  const net = network(t);
  const reference = await prepareReference("unused", "https://example.com/image.png", false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readReference(reference, controller.signal, limit, net.authorize), { name: "AbortError" });
  for (const size of [0, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(readReference(reference, signal(), size, net.authorize), /positive safe integer/);
  }
  assert.deepEqual(net.events, []);
});
