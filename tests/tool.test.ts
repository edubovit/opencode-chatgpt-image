import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test, type TestContext } from "node:test"
import { Connection, Credential, Integration } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { createImageTool, type ImageContext } from "../src/tool.ts"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64")
const connection = Connection.CredentialInfo.make({ type: "credential", id: Credential.ID.make("cred_test"), label: "Test", method: "oauth" })
const credential = Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: "test-token", refresh: "test-refresh", expires: Date.now() + 3_600_000 })

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-image-tool-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const permissions: string[] = []
  let location = directory
  let requests = 0
  let credentialReads = 0
  let resolvedCredential: typeof credential | undefined = credential
  let resolveCredential = async () => resolvedCredential
  let permission: ImageContext["permission"]["assert"] = async input => { permissions.push(input.action) }
  const controller = new AbortController()
  const lifetime = new AbortController()
  const ctx: ImageContext = {
    session: { async get() { return {
      id: "ses_test", projectID: "project_test", location: { directory: location },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    } } },
    integration: { connection: {
      async active() { return connection },
      async resolve() { credentialReads++; return resolveCredential() },
    } },
    permission: { async assert(input) {
      assert.ok(!Object.hasOwn(input, "metadata") || (typeof input.metadata === "object" && input.metadata !== null))
      await permission(input)
    } },
  }
  const call: ToolContext = {
    sessionID: "ses_test" as ToolContext["sessionID"], agent: "build" as ToolContext["agent"],
    messageID: "msg_test" as ToolContext["messageID"], id: "call_test" as ToolContext["id"],
    signal: controller.signal, async progress() {},
  }
  let fetcher: typeof fetch = async () => { requests++; return Response.json({ data: [{ b64_json: png.toString("base64") }] }) }
  return {
    directory, permissions, ctx, call, controller, lifetime,
    get requests() { return requests }, get credentialReads() { return credentialReads },
    move(value: string) { location = value },
    fetch(value: typeof fetch) { fetcher = value },
    permission(value: typeof permission) { permission = value },
    credential(value: typeof resolvedCredential) { resolvedCredential = value },
    resolveCredential(value: typeof resolveCredential) { resolveCredential = value },
    run(input: unknown = { prompt: "A blue circle", output_path: "output/new.png" }, timeoutMs = 1000, allowExternalReferences = true) {
      return createImageTool(ctx, lifetime.signal, timeoutMs, (url, init) => fetcher(url, init), allowExternalReferences).execute(input, call)
    },
  }
}

test("writes the image and returns a native file attachment with honest model metadata", async t => {
  const f = await fixture(t)
  const result = await f.run()
  assert.deepEqual(await readFile(join(f.directory, "output/new.png")), png)
  assert.deepEqual(f.permissions, ["chatgpt_image", "edit"])
  assert.equal(f.requests, 1)
  assert.equal(result.metadata?.effective_model, null)
  assert.equal(result.metadata?.requested_model, "gpt-image-2")
  assert.ok(Array.isArray(result.content))
  assert.equal(result.content[1]?.type, "file")
  assert.equal(JSON.stringify(result).includes("test-token"), false)
})

test("reference reads are authorized and uploaded for editing", async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, "reference.png"), png)
  f.fetch(async (url, init) => {
    assert.match(String(url), /\/images\/edits$/)
    assert.deepEqual(f.permissions, ["chatgpt_image", "edit", "read"])
    const request = JSON.parse(String(init?.body))
    assert.equal(request.images[0].image_url, `data:image/png;base64,${png.toString("base64")}`)
    assert.equal(request.background, "transparent")
    return Response.json({ data: [{ b64_json: png.toString("base64") }] })
  })
  await f.run({ prompt: "Make it transparent", output_path: "edit.png", reference_images: ["reference.png"], background: "transparent" })
})

test("subscription external references default to enabled with separate generation and output permissions", async t => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), "chatgpt-external-reference-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const reference = join(outside, "image.png")
  await writeFile(reference, png)
  const input = { prompt: "Edit", output_path: "new.png", reference_images: [reference] }
  await assert.rejects(f.run(input, 1000, false))
  assert.equal(f.credentialReads, 0)
  const permissions: Parameters<ImageContext["permission"]["assert"]>[0][] = []
  f.permission(async request => { permissions.push(request) })
  await f.run(input)
  assert.deepEqual(permissions.map(request => request.action), ["chatgpt_image", "edit", "external_directory", "read"])
  assert.deepEqual(permissions[0]?.resources, ["gpt-image-2"])
  assert.deepEqual(permissions[1]?.resources, [join(f.directory, "new.png")])
  assert.equal(f.requests, 1)
})

for (const action of ["chatgpt_image", "edit", "read"]) {
  test(`denied ${action} permission stops credential resolution, network and output`, async t => {
    const f = await fixture(t)
    await writeFile(join(f.directory, "reference.png"), png)
    const rejection = new Error("permission denied")
    f.permission(async input => { if (input.action === action) throw rejection })
    await assert.rejects(f.run({ prompt: "Edit", output_path: "new.png", reference_images: ["reference.png"] }), error => error === rejection)
    assert.equal(f.requests, 0)
    assert.equal(f.credentialReads, 0)
    await assert.rejects(readFile(join(f.directory, "new.png")), { code: "ENOENT" })
  })
}

test("existing outputs fail before spending quota", async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, "exists.png"), "keep")
  await assert.rejects(f.run({ prompt: "Test", output_path: "exists.png" }))
  assert.equal(f.requests, 0)
  assert.equal(await readFile(join(f.directory, "exists.png"), "utf8"), "keep")
})

for (const input of [null, {}, { prompt: " ", output_path: "new.png" }, { prompt: "test", output_path: "new.png", model: "gpt-image-2.5-sunburst" }, { prompt: "test", output_path: "new.png", reference_images: [null] }, { prompt: "test", output_path: "new.png", reference_images: Array(6).fill("ref.png") }, { prompt: "test", output_path: "new.png", background: "wrong" }]) {
  test(`rejects invalid arguments before permission or network: ${JSON.stringify(input)}`, async t => {
    const f = await fixture(t)
    await assert.rejects(f.run(input))
    assert.equal(f.requests, 0)
    assert.deepEqual(f.permissions, [])
  })
}

test("account-resolution failure does not write output or dispatch a request", async t => {
  const f = await fixture(t)
  f.credential(undefined)
  await assert.rejects(f.run(), /Codex browser or device/)
  assert.equal(f.requests, 0)
})

test("session movement after generation prevents output at the stale location", async t => {
  const f = await fixture(t)
  f.fetch(async () => { f.move(join(f.directory, "moved")); return Response.json({ data: [{ b64_json: png.toString("base64") }] }) })
  await assert.rejects(f.run(), /session moved/)
  await assert.rejects(readFile(join(f.directory, "output/new.png")), { code: "ENOENT" })
})

for (const kind of ["session", "unload", "timeout"] as const) {
  test(`${kind} cancellation stops a pending request and does not save output`, async t => {
    const f = await fixture(t)
    const keepAlive = setTimeout(() => {}, 2000)
    t.after(() => clearTimeout(keepAlive))
    f.fetch(async (_, init) => {
      if (kind !== "timeout") queueMicrotask(() => (kind === "session" ? f.controller : f.lifetime).abort())
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("private abort detail")), { once: true })
      })
    })
    await assert.rejects(f.run(undefined, kind === "timeout" ? 30 : 1000), /timed out|cancelled/)
    await assert.rejects(readFile(join(f.directory, "output/new.png")), { code: "ENOENT" })
  })
}

test("cancellation during a permission wait stops locally and never asks for later permissions", async t => {
  const f = await fixture(t)
  let release!: () => void
  f.permission(async input => {
    f.permissions.push(input.action)
    f.controller.abort()
    await new Promise<void>(resolve => { release = resolve })
  })
  await assert.rejects(f.run(), /cancelled/)
  assert.deepEqual(f.permissions, ["chatgpt_image"])
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.permissions, ["chatgpt_image"])
  assert.equal(f.requests, 0)
  assert.equal(f.credentialReads, 0)
})

test("timeout stops waiting for a stalled host refresh and never dispatches after late completion", async t => {
  const f = await fixture(t)
  const keepAlive = setTimeout(() => {}, 1000)
  t.after(() => clearTimeout(keepAlive))
  let release!: (value: typeof credential) => void
  f.resolveCredential(() => new Promise(resolve => { release = resolve }))
  await assert.rejects(f.run(undefined, 30), /timed out/)
  assert.equal(f.requests, 0)
  release(credential)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.requests, 0)
  await assert.rejects(readFile(join(f.directory, "output/new.png")), { code: "ENOENT" })
})
