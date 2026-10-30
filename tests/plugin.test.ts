import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import plugin from "../index.ts"

const key = "synthetic-api-key-never-live"

function fixture(options: Context["options"]) {
  const tools: Info[] = []
  let registrations = 0
  const unused = () => { throw new Error("Unexpected host capability access") }
  const editor: ToolEditor = {
    add(tool) { tools.push(tool) },
    list: unused, get: unused, namespace: unused, update: unused, remove: unused,
  }
  const used = {
    options,
    integration: { connection: { active: unused, resolve: unused } },
    tool: {
      async transform(callback: Parameters<Context["tool"]["transform"]>[0]) {
        registrations++
        callback(editor)
        return { async dispose() {} }
      },
    },
  }
  const ctx = new Proxy(used, {
    get(target, property) {
      if (property === "options" || property === "tool") return target[property]
      if (property === "integration" && options.mode !== "api") return target.integration
      return unused()
    },
  }) as unknown as Context
  return { tools, ctx, get registrations() { return registrations } }
}

for (const options of [{}, { apiKey: key }, { mode: "chatgpt", apiKey: key }]) {
  test(`default/chatgpt registers only chatgpt_image (${JSON.stringify(Object.keys(options))})`, async () => {
    const f = fixture(options)
    const cleanup = await plugin.setup(f.ctx)
    assert.equal(f.registrations, 1)
    assert.deepEqual(f.tools.map(tool => tool.name), ["chatgpt_image"])
    assert.equal(JSON.stringify(f.tools).includes(key), false)
    const schema = f.tools[0]!.input as { properties: Record<string, { maxItems?: number }> }
    assert.equal(schema.properties.reference_images?.maxItems, 5)
    assert.equal(Object.hasOwn(schema.properties, "model"), false)
    await cleanup?.()
  })
}

test("API mode registers only openai_image without accessing OAuth or another host capability", async () => {
  const f = fixture({ mode: "api", apiKey: key })
  const cleanup = await plugin.setup(f.ctx)
  assert.equal(f.registrations, 1)
  assert.deepEqual(f.tools.map(tool => tool.name), ["openai_image"])
  assert.equal(JSON.stringify(f.tools).includes(key), false)
  const schema = f.tools[0]!.input as { properties: Record<string, unknown>; additionalProperties: boolean }
  assert.equal(schema.additionalProperties, false)
  for (const field of ["mode", "apiKey", "endpoint", "baseURL", "stream"]) assert.equal(Object.hasOwn(schema.properties, field), false)
  await cleanup?.()
})

for (const mode of ["api", "chatgpt"]) {
  test(`${mode} plugin cleanup cancels old tool instances before any host call`, async () => {
    const f = fixture({ mode, apiKey: key })
    const cleanup = await plugin.setup(f.ctx)
    assert.equal(typeof cleanup, "function")
    await cleanup?.()
    const call: ToolContext = {
      sessionID: "ses_test" as ToolContext["sessionID"], agent: "build" as ToolContext["agent"],
      messageID: "msg_test" as ToolContext["messageID"], id: "call_test" as ToolContext["id"],
      signal: new AbortController().signal, async progress() { throw new Error("Unexpected progress after unload") },
    }
    await assert.rejects(f.tools[0]!.execute({ prompt: "Test", output_path: "new.png" }, call), /cancelled/)
  })
}

for (const options of [
  { mode: "api" }, { mode: "api", apiKey: " " }, { mode: "unknown", apiKey: key },
  { mode: "api", apiKey: key, defaults: { n: 0 } },
  { mode: "api", apiKey: key, defaults: { quality: "invalid" } },
  { mode: "api", apiKey: key, defaults: { output_format: "gif" } },
  { mode: "api", apiKey: key, defaults: { stream: true } },
  { mode: "api", apiKey: key, endpoint: "https://example.invalid" },
]) {
  test(`invalid plugin options activate inertly so the host cannot restore stale tools (${JSON.stringify(options).replaceAll(key, "[fake-key]")})`, async t => {
    const f = fixture(options)
    const warnings = t.mock.method(console, "warn", () => {})
    assert.equal(await plugin.setup(f.ctx), undefined)
    assert.equal(f.registrations, 0)
    assert.deepEqual(f.tools, [])
    assert.equal(warnings.mock.callCount(), 1)
    assert.deepEqual(warnings.mock.calls[0]?.arguments, ["[opencode-chatgpt-image] Invalid configuration; image tools disabled. Check mode, apiKey and defaults."])
    assert.equal(JSON.stringify(warnings.mock.calls[0]?.arguments).includes(key), false)
  })
}
