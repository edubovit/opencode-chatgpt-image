import assert from "node:assert/strict"
import dns from "node:dns/promises"
import https, { type RequestOptions } from "node:https"
import type { IncomingMessage } from "node:http"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test, type TestContext } from "node:test"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { createApiImageTool } from "../src/api-tool.ts"
import { parseConfig } from "../src/config.ts"
import type { ImageContext } from "../src/tool.ts"

const key = "synthetic-api-key-never-live"
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64")
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==", "base64")
const webp = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA", "base64")
const defaultInput = { prompt: "A synthetic blue circle", output_path: "output/new.png" }

async function fixture(t: TestContext, defaults: Record<string, unknown> = {}, options: { allowExternalReferences?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openai-image-tool-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = parseConfig({ mode: "api", apiKey: key, defaults, ...options })
  assert.equal(config.mode, "api")
  if (config.mode !== "api") throw new Error("Expected API fixture")
  const permissions: Parameters<ImageContext["permission"]["assert"]>[0][] = []
  const updates: unknown[] = []
  let location = directory
  let requests = 0
  let oauthReads = 0
  let permission: ImageContext["permission"]["assert"] = async () => {}
  const controller = new AbortController()
  const lifetime = new AbortController()
  const noOAuth = async () => { oauthReads++; throw new Error("API mode must not read host OAuth") }
  const ctx: ImageContext = {
    session: { async get() { return {
      id: "ses_test", projectID: "project_test", location: { directory: location },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    } } },
    integration: { connection: { active: noOAuth, resolve: noOAuth } },
    permission: { async assert(input) { permissions.push(input); await permission(input) } },
  }
  const call: ToolContext = {
    sessionID: "ses_test" as ToolContext["sessionID"], agent: "build" as ToolContext["agent"],
    messageID: "msg_test" as ToolContext["messageID"], id: "call_test" as ToolContext["id"],
    signal: controller.signal, async progress(update) { updates.push(update) },
  }
  let fetcher: typeof fetch = async (_, init) => {
    const n = init?.body instanceof FormData ? Number(init.body.get("n")) : Number(JSON.parse(String(init?.body)).n)
    return Response.json({ data: Array.from({ length: n }, () => ({ b64_json: png.toString("base64") })) })
  }
  const tool = (timeoutMs = 1000) => createApiImageTool(ctx, lifetime.signal, config, timeoutMs, async (url, init) => {
    requests++
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`)
    return fetcher(url, init)
  })
  return {
    directory, permissions, updates, controller, lifetime, tool,
    get requests() { return requests }, get oauthReads() { return oauthReads },
    move(value: string) { location = value },
    fetch(value: typeof fetch) { fetcher = value },
    permission(value: typeof permission) { permission = value },
    run(input: unknown = defaultInput, timeoutMs = 1000) { return tool(timeoutMs).execute(input, call) },
  }
}

test("API defaults use paid generation without host OAuth or exposing the key", async t => {
  const f = await fixture(t)
  f.fetch(async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/images/generations")
    assert.deepEqual(f.permissions.map(input => input.action), ["openai_image", "edit"])
    assert.deepEqual(f.permissions[0]?.resources, ["gpt-image-2.5-sunburst"])
    assert.deepEqual(f.permissions[1]?.resources, [join(f.directory, defaultInput.output_path)])
    assert.deepEqual(JSON.parse(String(init?.body)), {
      prompt: defaultInput.prompt, model: "gpt-image-2.5-sunburst", quality: "max", size: "3840x2160",
      output_format: "png", n: 1, background: "auto",
    })
    await assert.rejects(lstat(join(f.directory, "output")), { code: "ENOENT" })
    return Response.json({ data: [{ b64_json: png.toString("base64") }] })
  })
  const result = await f.run()
  assert.deepEqual(await readFile(join(f.directory, defaultInput.output_path)), png)
  assert.equal(f.oauthReads, 0)
  assert.equal(f.requests, 1)
  assert.equal(result.metadata?.requested_model, "gpt-image-2.5-sunburst")
  assert.equal(result.metadata?.effective_model, undefined)
  assert.ok(Array.isArray(result.content))
  assert.equal(result.content[1]?.type, "file")
  assert.equal(JSON.stringify([f.tool(), result, f.updates, f.permissions]).includes(key), false)
})

test("reference ancestors are revalidated after permission approval before uploading", async t => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), "openai-outside-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(f.directory, "refs"))
  await writeFile(join(f.directory, "refs", "image.png"), png)
  await writeFile(join(outside, "image.png"), png)
  let unsupported = false
  f.permission(async input => {
    if (input.action !== "edit") return
    await rename(join(f.directory, "refs"), join(f.directory, "original-refs"))
    try { await symlink(outside, join(f.directory, "refs"), process.platform === "win32" ? "junction" : "dir") }
    catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      unsupported = true
    }
  })
  await assert.rejects(f.run({ ...defaultInput, reference_images: ["refs/image.png"] }))
  assert.equal(f.requests, 0)
  if (unsupported) t.skip("Directory link creation unavailable")
})

test("external references are enabled by default but can be disabled without allowing external writes", async t => {
  const outside = await mkdtemp(join(tmpdir(), "image-external-input-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const reference = join(outside, "source.png")
  await writeFile(reference, png)
  const blocked = await fixture(t, {}, { allowExternalReferences: false })
  await assert.rejects(blocked.run({ ...defaultInput, reference_images: [reference] }))
  assert.equal(blocked.requests, 0)
  const f = await fixture(t)
  await f.run({ ...defaultInput, reference_images: [reference] })
  assert.deepEqual(f.permissions.map(input => input.action), ["openai_image", "edit", "external_directory", "read"])
  assert.deepEqual(f.permissions.at(-1)?.resources, [reference])
  assert.equal(f.requests, 1)
  await assert.rejects(f.run({ prompt: "Test", output_path: join(outside, "new.png") }))
  assert.equal(f.requests, 1)
})

test("reported settings and request usage stay distinct from requested settings", async t => {
  const f = await fixture(t)
  f.fetch(async () => Response.json({
    data: [{ b64_json: png.toString("base64") }], size: "1024x1024", quality: "high", output_format: "png",
    usage: { input_tokens: 9, output_tokens: 20, total_tokens: 29, secret: key }, model: key,
  }))
  const result = await f.run()
  assert.equal(result.metadata?.size, "3840x2160")
  assert.deepEqual(result.metadata?.reported, { size: "1024x1024", quality: "high", output_format: "png" })
  assert.deepEqual(result.metadata?.usage, { input_tokens: 9, output_tokens: 20, total_tokens: 29 })
  assert.equal(JSON.stringify(result).includes(key), false)
})

test("HTTPS references and masks are downloaded without API credentials and uploaded as multipart bytes", async t => {
  const f = await fixture(t)
  const sources = ["https://images.example.com/reference.png", "https://images.example.com/mask.png"]
  const downloads: string[] = []
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.215.14", family: 4 }])
  t.mock.method(https, "request", (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    downloads.push(url.href)
    assert.equal(JSON.stringify(options).includes(key), false)
    assert.deepEqual(f.permissions.at(-1)?.resources, [url.href])
    assert.equal(f.permissions.at(-1)?.action, "webfetch")
    return Object.assign(new EventEmitter(), { end() {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
      queueMicrotask(() => { callback(response as unknown as IncomingMessage); response.end(png) })
    } })
  })
  f.fetch(async (_, init) => {
    assert.ok(init?.body instanceof FormData)
    for (const field of ["image[]", "mask"]) {
      const file: FormDataEntryValue | null = init.body.get(field)
      assert.ok(file instanceof File)
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), png)
    }
    return Response.json({ data: [{ b64_json: png.toString("base64") }] })
  })
  await f.run({ ...defaultInput, reference_images: [sources[0]], mask: sources[1] })
  assert.deepEqual(downloads, sources)
  assert.equal(f.requests, 1)
})

test("caller parameters override configured defaults and n images get distinct authorized paths", async t => {
  const f = await fixture(t, { model: "gpt-image-2", quality: "high", size: "1024x1024", n: 1, background: "opaque" })
  f.fetch(async (_, init) => {
    const request = JSON.parse(String(init?.body))
    assert.equal(request.model, "gpt-image-2.5-sunburst")
    assert.equal(request.quality, "max")
    assert.equal(request.size, "3840x2160")
    assert.equal(request.n, 3)
    assert.equal(request.background, "transparent")
    assert.deepEqual(f.permissions.at(-1)?.resources, ["result.png", "result-2.png", "result-3.png"].map(path => join(f.directory, path)))
    return Response.json({ data: Array.from({ length: 3 }, () => ({ b64_json: png.toString("base64") })) })
  })
  const result = await f.run({ prompt: "Test", output_path: "result.png", model: "gpt-image-2.5-sunburst", quality: "max", size: "3840x2160", n: 3, background: "transparent" })
  for (const name of ["result.png", "result-2.png", "result-3.png"]) assert.deepEqual(await readFile(join(f.directory, name)), png)
  assert.ok(Array.isArray(result.content))
  assert.equal(result.content.filter(part => part.type === "file").length, 3)
  assert.equal(f.requests, 1)
})

for (const existing of ["result.png", "result-2.png", "result-3.png"]) {
  test(`all n outputs preflight before dispatch: ${existing}`, async t => {
    const f = await fixture(t)
    await writeFile(join(f.directory, existing), "keep")
    await assert.rejects(f.run({ prompt: "Test", output_path: "result.png", n: 3 }), /already exists/)
    assert.equal(f.requests, 0)
    assert.deepEqual(f.permissions, [])
    assert.equal(await readFile(join(f.directory, existing), "utf8"), "keep")
  })
}

for (const [format, extension, bytes] of [["png", "png", png], ["jpeg", "jpg", jpeg], ["jpeg", "jpeg", jpeg], ["webp", "webp", webp]] as const) {
  test(`saves ${format} as .${extension} with matching attachment MIME`, async t => {
    const f = await fixture(t, { output_format: "png" })
    f.fetch(async (_, init) => {
      assert.equal(JSON.parse(String(init?.body)).output_format, format)
      return Response.json({ data: [{ b64_json: bytes.toString("base64") }] })
    })
    const result = await f.run({ prompt: "Test", output_path: `new.${extension}`, output_format: format })
    assert.deepEqual(await readFile(join(f.directory, `new.${extension}`)), bytes)
    assert.ok(Array.isArray(result.content))
    assert.equal(result.content[1]?.type, "file")
    if (result.content[1]?.type === "file") assert.equal(result.content[1].mime, `image/${format}`)
  })
}

for (const overlay of ["mask", "markup"] as const) {
  test(`${overlay} and references use authorized multipart editing`, async t => {
    const f = await fixture(t)
    await writeFile(join(f.directory, "reference.png"), png)
    await writeFile(join(f.directory, "overlay.png"), png)
    f.fetch(async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/images/edits")
      assert.deepEqual(f.permissions.map(input => input.action), ["openai_image", "edit", "read", "read"])
      assert.deepEqual(f.permissions.filter(input => input.action === "read").flatMap(input => input.resources), ["reference.png", "overlay.png"].map(name => join(f.directory, name)))
      assert.ok(init?.body instanceof FormData)
      const image = init.body.get("image[]")
      const mask = init.body.get(overlay)
      assert.ok(image instanceof File)
      assert.ok(mask instanceof File)
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
      assert.deepEqual(Buffer.from(await mask.arrayBuffer()), png)
      assert.equal(mask.type, "image/png")
      assert.equal(init.body.has(overlay === "mask" ? "markup" : "mask"), false)
      assert.equal(init.body.get("model"), "gpt-image-2.5-sunburst")
      assert.equal(init.body.has("stream"), false)
      return Response.json({ data: [{ b64_json: png.toString("base64") }] })
    })
    await f.run({ ...defaultInput, reference_images: ["reference.png"], [overlay]: "overlay.png" })
    assert.equal(f.oauthReads, 0)
  })
}

test("accepts sixteen references and authorizes each read after generation and output permissions", async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, "reference.png"), png)
  const file = await open(join(f.directory, "reference.png"), "r")
  const prototype = Object.getPrototypeOf(file) as FileHandle
  await file.close()
  const read = prototype.read
  const spy = t.mock.method(prototype, "read", async function (this: FileHandle, ...args: unknown[]) {
    assert.deepEqual(f.permissions.slice(0, 2).map(input => input.action), ["openai_image", "edit"])
    assert.ok(f.permissions.slice(2).every(input => input.action === "read"))
    assert.deepEqual(f.permissions.at(-1)?.resources, [join(f.directory, "reference.png")])
    return Reflect.apply(read, this, args)
  })
  f.fetch(async (_, init) => {
    assert.ok(init?.body instanceof FormData)
    assert.equal(init.body.getAll("image[]").length, 16)
    return Response.json({ data: [{ b64_json: png.toString("base64") }] })
  })
  await f.run({ ...defaultInput, reference_images: Array(16).fill("reference.png") })
  assert.ok(spy.mock.callCount() >= 16)
})

for (const action of ["openai_image", "read", "edit"]) {
  test(`denial of ${action} prevents upload, network and output writes`, async t => {
    const f = await fixture(t)
    await writeFile(join(f.directory, "reference.png"), "invalid image bytes must not be read")
    const rejection = new Error("permission denied")
    f.permission(async input => { if (input.action === action) throw rejection })
    await assert.rejects(f.run({ ...defaultInput, reference_images: ["reference.png"] }), error => error === rejection)
    assert.equal(f.requests, 0)
    assert.equal(f.oauthReads, 0)
    await assert.rejects(lstat(join(f.directory, "output")), { code: "ENOENT" })
  })
}

for (const extra of [
  { apiKey: key }, { mode: "chatgpt" }, { endpoint: "https://example.invalid" }, { baseURL: "https://example.invalid" },
  { stream: true }, { n: 0 }, { n: 1.5 }, { quality: "wrong" }, { output_format: "gif" },
  { reference_images: Array(17).fill("ref.png") }, { reference_images: [null] },
  { mask: "mask.png" }, { markup: "markup.png" },
  { reference_images: ["ref.png"], mask: "mask.png", markup: "markup.png" },
]) {
  test(`invalid/forbidden caller fields fail before permissions: ${JSON.stringify(extra).replaceAll(key, "[fake-key]")}`, async t => {
    const f = await fixture(t)
    await assert.rejects(f.run({ ...defaultInput, ...extra }), (error: Error) => {
      assert.equal(error.message.includes(key), false)
      return true
    })
    assert.deepEqual(f.permissions, [])
    assert.equal(f.requests, 0)
  })
}

test("output extension must match format before authorization or dispatch", async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ ...defaultInput, output_format: "webp" }))
  assert.equal(f.requests, 0)
  assert.deepEqual(f.permissions, [])
})

for (const [defaults, overrides, size] of [
  [{}, { orientation: "vertical" }, "2160x3840"],
  [{ size: "1536x1024" }, { orientation: "vertical" }, "1024x1536"],
  [{ orientation: "vertical" }, { size: "1536x1024" }, "1536x1024"],
  [{ size: "1536x1024", orientation: "vertical" }, {}, "1024x1536"],
  [{}, { orientation: "square" }, "2160x2160"],
] as const) {
  test(`orientation resolves the effective size ${size} without sending orientation (${JSON.stringify([defaults, overrides])})`, async t => {
    const f = await fixture(t, defaults)
    f.fetch(async (_, init) => {
      const request = JSON.parse(String(init?.body))
      assert.equal(request.size, size)
      assert.equal(Object.hasOwn(request, "orientation"), false)
      assert.equal(f.permissions[0]?.metadata?.size, size)
      return Response.json({ data: [{ b64_json: png.toString("base64") }] })
    })
    const result = await f.run({ ...defaultInput, ...overrides })
    assert.equal(result.metadata?.size, size)
  })
}

for (const [field, length] of [["reference_images", 50_000_000], ["mask", 4_000_000]] as const) {
  test(`${field} rejects the byte limit before network`, async t => {
    const f = await fixture(t)
    await writeFile(join(f.directory, "reference.png"), png)
    const handle = await open(join(f.directory, "large.png"), "wx")
    await handle.truncate(length)
    await handle.close()
    await assert.rejects(f.run({ ...defaultInput, reference_images: [field === "reference_images" ? "large.png" : "reference.png"], ...(field === "mask" ? { mask: "large.png" } : {}) }), /limit/)
    assert.equal(f.requests, 0)
  })
}

for (const overlay of ["mask", "markup"]) {
  test(`${overlay} must have PNG bytes even with a .png filename`, async t => {
    const f = await fixture(t)
    await writeFile(join(f.directory, "reference.png"), png)
    await writeFile(join(f.directory, "overlay.png"), jpeg)
    await assert.rejects(f.run({ ...defaultInput, reference_images: ["reference.png"], [overlay]: "overlay.png" }), /PNG/)
    assert.equal(f.requests, 0)
  })
}

for (const kind of ["session", "unload", "timeout"] as const) {
  test(`${kind} during a permission wait prevents late network dispatch`, async t => {
    const f = await fixture(t)
    const keepAlive = setTimeout(() => {}, 1000)
    t.after(() => clearTimeout(keepAlive))
    let release!: () => void
    f.permission(async () => {
      if (kind !== "timeout") (kind === "session" ? f.controller : f.lifetime).abort()
      await new Promise<void>(resolve => { release = resolve })
    })
    await assert.rejects(f.run(undefined, kind === "timeout" ? 30 : 1000), /timed out|cancelled/)
    release()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.permissions.map(input => input.action), ["openai_image"])
    assert.equal(f.requests, 0)
    await assert.rejects(lstat(join(f.directory, "output")), { code: "ENOENT" })
  })
}

for (const kind of ["session", "unload", "timeout"] as const) {
  test(`${kind} stops an in-flight API request without saving output`, async t => {
    const f = await fixture(t)
    const keepAlive = setTimeout(() => {}, 1000)
    t.after(() => clearTimeout(keepAlive))
    f.fetch(async (_, init) => {
      if (kind !== "timeout") queueMicrotask(() => (kind === "session" ? f.controller : f.lifetime).abort())
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(key)), { once: true })
      })
    })
    await assert.rejects(f.run(undefined, kind === "timeout" ? 30 : 1000), (error: Error) => {
      assert.match(error.message, /timed out|cancelled/)
      assert.equal(error.message.includes(key), false)
      return true
    })
    assert.equal(f.requests, 1)
    await assert.rejects(lstat(join(f.directory, "output")), { code: "ENOENT" })
  })
}

for (const failure of ["network", "response"] as const) {
  test(`${failure} failure cannot expose the configured key and never retries`, async t => {
    const f = await fixture(t)
    f.fetch(async () => {
      if (failure === "network") throw new Error(`private detail ${key}`)
      return Response.json({ error: { message: `private detail ${key}` } }, { status: 401 })
    })
    await assert.rejects(f.run(), (error: Error) => {
      assert.equal(error.message.includes(key), false)
      return true
    })
    assert.equal(f.requests, 1)
    assert.equal(JSON.stringify(f.updates).includes(key), false)
    await assert.rejects(lstat(join(f.directory, "output")), { code: "ENOENT" })
  })
}

test("session movement after generation prevents writing at the stale location", async t => {
  const f = await fixture(t)
  f.fetch(async () => {
    f.move(join(f.directory, "moved"))
    return Response.json({ data: [{ b64_json: png.toString("base64") }] })
  })
  await assert.rejects(f.run(), /session moved/)
  await assert.rejects(lstat(join(f.directory, "output")), { code: "ENOENT" })
})
