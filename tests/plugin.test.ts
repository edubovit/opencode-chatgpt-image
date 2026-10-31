import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import plugin from "../index.ts"

const key = "synthetic-api-key-never-live"
const native = "experimental_image_generate"

function fixture(options: Context["options"]) {
  const transforms = new Set<Parameters<Context["tool"]["transform"]>[0]>()
  const operations: string[] = []
  const catalog = new Map<string, Info>()
  const commands = new Map<string, CommandDefinition>()
  const hooks = new Set<keyof SessionHooks>()
  let registrations = 0
  const unused = () => { throw new Error("Unexpected host capability access") }
  const original = [native, "unrelated_tool"].map(name => ({ name, description: name, input: { type: "object" }, execute: unused }))
  const editor: ToolEditor = {
    add(tool) { operations.push(`add:${tool.name}`); catalog.set(tool.name, tool) },
    remove(id) { operations.push(`remove:${id}`); catalog.delete(id) },
    list: unused, get: unused, namespace: unused, update: unused,
  }
  const reload = () => {
    catalog.clear()
    for (const tool of original) catalog.set(tool.name, tool)
    for (const transform of transforms) transform(editor)
  }
  reload()
  const used = {
    options,
    integration: { connection: { active: unused, resolve: unused } },
    command: {
      async transform(callback: Parameters<Context["command"]["transform"]>[0]) {
        callback({ add(command) { commands.set(command.name, command) } })
        return { async dispose() { commands.clear() } }
      },
    },
    session: {
      hook: (async name => {
        hooks.add(name)
        return { async dispose() { hooks.delete(name) } }
      }) satisfies Context["session"]["hook"],
    },
    rpc: {
      async register() {
        return { events: { async emit() {} }, async dispose() {} }
      },
    },
    tool: {
      async transform(callback: Parameters<Context["tool"]["transform"]>[0]) {
        registrations++
        transforms.add(callback)
        callback(editor)
        return { async dispose() { transforms.delete(callback); reload() } }
      },
    },
  }
  const ctx = new Proxy(used, {
    get(target, property) {
      if (property === "options") operations.push("options")
      if (property === "options" || property === "tool" || property === "session" || property === "command" || property === "rpc") return target[property]
      if (property === "integration" && options.mode !== "api") return target.integration
      return unused()
    },
  }) as unknown as Context
  return {
    ctx, catalog, commands, hooks, operations, reload,
    disposeScope() { transforms.clear(); commands.clear(); hooks.clear(); reload() },
    get tools() { return [...catalog.values()].filter(tool => !original.some(item => item.name === tool.name)) },
    get registrations() { return registrations },
  }
}

for (const options of [{}, { apiKey: key }, { mode: "chatgpt", apiKey: key }, { allowExternalReferences: true }, { allowExternalReferences: false }, { enabledByDefault: true }, { enabledByDefault: false }]) {
  test(`default/chatgpt registers only chatgpt_image (${JSON.stringify(Object.keys(options))})`, async () => {
    const f = fixture(options)
    const cleanup = await plugin.setup(f.ctx)
    assert.equal(f.registrations, 2)
    assert.deepEqual(f.operations.slice(0, 2), [`remove:${native}`, "options"])
    assert.equal(f.catalog.has(native), false)
    assert.equal(f.catalog.has("unrelated_tool"), true)
    assert.deepEqual(f.tools.map(tool => tool.name), ["chatgpt_image"])
    assert.deepEqual([...f.commands.keys()], ["images"])
    assert.deepEqual([...f.hooks].sort(), ["compaction", "context", "generate"])
    assert.equal(JSON.stringify(f.tools).includes(key), false)
    const schema = f.tools[0]!.input as { properties: Record<string, { maxItems?: number }>; required: string[] }
    assert.equal(schema.properties.reference_images?.maxItems, 5)
    assert.equal(Object.hasOwn(schema.properties, "model"), false)
    assert.equal(Object.hasOwn(schema.properties, "allowExternalReferences"), false)
    assert.equal(Object.hasOwn(schema.properties, "enabledByDefault"), false)
    assert.deepEqual(schema.required, ["prompt", "output_path"])
    await cleanup?.()
  })
}

test("API mode registers only openai_image and session controls without accessing OAuth", async () => {
  const f = fixture({ mode: "api", apiKey: key, allowExternalReferences: true, enabledByDefault: false })
  const cleanup = await plugin.setup(f.ctx)
  assert.equal(f.registrations, 2)
  assert.deepEqual(f.operations.slice(0, 2), [`remove:${native}`, "options"])
  assert.equal(f.catalog.has(native), false)
  assert.equal(f.catalog.has("unrelated_tool"), true)
  assert.deepEqual(f.tools.map(tool => tool.name), ["openai_image"])
  assert.deepEqual([...f.commands.keys()], ["images"])
  assert.deepEqual([...f.hooks].sort(), ["compaction", "context", "generate"])
  assert.equal(JSON.stringify(f.tools).includes(key), false)
  const schema = f.tools[0]!.input as { properties: Record<string, unknown>; additionalProperties: boolean; required: string[] }
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ["prompt", "output_path"])
  for (const field of ["mode", "apiKey", "endpoint", "baseURL", "stream", "allowExternalReferences", "enabledByDefault", "preset"]) assert.equal(Object.hasOwn(schema.properties, field), false)
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
  { mode: "api", apiKey: key, allowExternalReferences: "true" },
  { mode: "api", apiKey: key, enabledByDefault: "false" },
  { mode: "chatgpt", enabledByDefault: null },
  { mode: "chatgpt", allowExternalReferences: null },
  { presets: { poster: { size: "3840x2160" } } },
]) {
  test(`invalid plugin options suppress native tools before validation without stale-tool fallback (${JSON.stringify(options).replaceAll(key, "[fake-key]")})`, async t => {
    const f = fixture(options)
    const warnings = t.mock.method(console, "warn", () => {})
    assert.equal(await plugin.setup(f.ctx), undefined)
    assert.equal(f.registrations, 1)
    assert.deepEqual(f.operations, [`remove:${native}`, "options"])
    assert.equal(f.catalog.has(native), false)
    assert.equal(f.catalog.has("unrelated_tool"), true)
    assert.deepEqual(f.tools, [])
    assert.equal(f.commands.size, 0)
    assert.equal(f.hooks.size, 0)
    assert.equal(warnings.mock.callCount(), 1)
    assert.deepEqual(warnings.mock.calls[0]?.arguments, ["[opencode-chatgpt-image] Invalid configuration; image tools disabled. Check mode, apiKey and defaults."])
    assert.equal(JSON.stringify(warnings.mock.calls[0]?.arguments).includes(key), false)
  })
}

for (const options of [{}, { mode: "api", apiKey: key }, { mode: "api" }]) {
  test(`tool transforms replay suppression and remain owned by the plugin scope (${options.mode ?? "default"}, key=${"apiKey" in options})`, async t => {
    t.mock.method(console, "warn", () => {})
    const f = fixture(options)
    assert.equal(f.catalog.has(native), true)
    const cleanup = await plugin.setup(f.ctx)
    const selected = f.tools.map(tool => tool.name)
    for (let i = 0; i < 3; i++) {
      f.reload()
      assert.equal(f.catalog.has(native), false)
      assert.equal(f.catalog.has("unrelated_tool"), true)
      assert.deepEqual(f.tools.map(tool => tool.name), selected)
    }
    await cleanup?.()
    f.disposeScope()
    assert.deepEqual([...f.catalog.keys()], [native, "unrelated_tool"])
  })
}
