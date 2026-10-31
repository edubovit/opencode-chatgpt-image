import assert from "node:assert/strict"
import { test } from "node:test"
import type { CommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { withSessionToggle } from "../src/session-toggle.ts"

type Context = Parameters<typeof withSessionToggle>[0]
const session = (id: string) => id as ToolContext["sessionID"]

async function fixture(enabledByDefault?: boolean) {
  const hooks = new Map<string, (event: SessionContext) => void>()
  const notices: Record<string, unknown>[] = []
  const commands: CommandDefinition[] = []
  let executed = 0
  let executor: Info["execute"] = async () => { executed++; return { content: "generated" } }
  const lifetime = new AbortController()
  const original: Info = {
    name: "openai_image", description: "Full image tool", options: { codemode: false },
    input: { type: "object", properties: { output_path: { type: "string" } }, required: ["output_path"] },
    execute: (input, call) => executor(input, call),
  }
  const ctx = {
    session: { async hook(name: string, callback: (event: SessionContext) => void) {
      hooks.set(name, callback)
      return { async dispose() { hooks.delete(name) } }
    } },
    command: { async transform(callback: (editor: { add(command: CommandDefinition): void }) => void) {
      callback({ add: command => commands.push(command) })
      return { async dispose() {} }
    } },
    rpc: { async register() { return {
      events: { async emit(name: string, data: Record<string, unknown>) { assert.equal(name, "status"); notices.push(data) } },
      async dispose() {},
    } } },
  } as unknown as Context
  const tool = await withSessionToggle(ctx, original, lifetime.signal, enabledByDefault)
  const command = (id: string, text: string, extras: Partial<CommandInvocation["prompt"]> = {}) => commands[0]!.execute({
    sessionID: session(id), prompt: { text, ...extras }, delivery: "queue",
  })
  const visible = (id: string, hook = "context") => {
    const event: SessionContext = {
      sessionID: session(id), agent: "build" as SessionContext["agent"],
      model: { providerID: "fake", id: "fake" } as SessionContext["model"],
      system: [], messages: [], options: {},
      tools: { openai_image: { description: original.description, input: { type: "object" } }, read: { description: "Read", input: { type: "object" } } },
    }
    hooks.get(hook)!(event)
    assert.ok(event.tools.read)
    assert.deepEqual(event.system, [])
    assert.deepEqual(event.messages, [])
    assert.deepEqual(event.options, {})
    return Object.hasOwn(event.tools, "openai_image")
  }
  const execute = (id: string) => tool.execute({ output_path: "out.png" }, {
    sessionID: session(id), agent: "build" as ToolContext["agent"], messageID: "msg_fake" as ToolContext["messageID"],
    id: "call_fake" as ToolContext["id"], signal: new AbortController().signal, async progress() {},
  })
  return { hooks, notices, commands, lifetime, original, tool, command, visible, execute,
    executor(next: Info["execute"]) { executor = next }, get executed() { return executed } }
}

for (const configured of [undefined, true, false]) {
  test(`configured default controls every request kind (${configured})`, async () => {
    const f = await fixture(configured)
    assert.equal(f.commands.length, 1)
    assert.equal(f.commands[0]!.name, "images")
    assert.deepEqual([...f.hooks.keys()], ["context", "compaction", "generate"])
    for (const hook of f.hooks.keys()) assert.equal(f.visible("ses_a", hook), configured ?? true)
    assert.equal(f.tool.input, f.original.input)
    assert.equal(f.tool.options?.codemode, false)
    assert.deepEqual(f.notices, [])
  })
}

for (const configured of [true, false]) {
  test(`session overrides do not leak to another session or child (default=${configured})`, async () => {
    const f = await fixture(configured)
    await f.command("ses_a", configured ? "off" : "on")
    for (const hook of f.hooks.keys()) {
      assert.equal(f.visible("ses_a", hook), !configured)
      assert.equal(f.visible("ses_b", hook), configured)
      assert.equal(f.visible("ses_child", hook), configured)
    }
    await f.command("ses_a", configured ? "on" : "off")
    assert.equal(f.visible("ses_a"), configured)
    assert.equal(f.executed, 0)
  })
}

test("status and empty commands report state without enabling tools or model input", async () => {
  const f = await fixture(false)
  for (const text of ["", "status", " STATUS "]) {
    await f.command("ses_a", text)
    assert.equal(f.visible("ses_a"), false)
    assert.deepEqual(f.notices.at(-1), { sessionID: "ses_a", enabled: false, enabledByDefault: false, tool: "openai_image" })
  }
  await f.command("ses_a", "on")
  await f.command("ses_a", "status")
  assert.equal(f.notices.at(-1)?.enabled, true)
  assert.equal(f.executed, 0)
})

test("invalid arguments and attachments do not change state or emit notices", async () => {
  const f = await fixture(false)
  for (const text of ["toggle", "on now", "on\noff", "generate a picture"]) {
    await assert.rejects(f.command("ses_a", text), /Use \/images/)
  }
  await assert.rejects(f.command("ses_a", "on", { files: [{ uri: "file:///unused.png" }] }), /without attachments/)
  assert.equal(f.visible("ses_a"), false)
  assert.deepEqual(f.notices, [])
})

test("executor rejects hidden calls, including calls from a previously enabled snapshot", async () => {
  const f = await fixture(false)
  await assert.rejects(f.execute("ses_a"), /disabled/)
  await f.command("ses_a", "on")
  assert.equal(f.visible("ses_a"), true)
  await f.execute("ses_a")
  await f.command("ses_a", "off")
  await assert.rejects(f.execute("ses_a"), /disabled/)
  assert.equal(f.executed, 1)
})

test("off does not cancel an executor that already started", async () => {
  const f = await fixture(true)
  let finish!: (result: { content: string }) => void
  f.executor(() => new Promise(resolve => { finish = resolve }))
  const running = f.execute("ses_a")
  await f.command("ses_a", "off")
  finish({ content: "already completed" })
  assert.deepEqual(await running, { content: "already completed" })
  await assert.rejects(f.execute("ses_a"), /disabled/)
})

for (const configured of [true, false]) {
  test(`unload revokes stale callbacks and reload uses configured default (${configured})`, async () => {
    const previous = await fixture(configured)
    await previous.command("ses_a", configured ? "off" : "on")
    previous.lifetime.abort()
    assert.equal(previous.visible("ses_a"), false)
    await assert.rejects(previous.execute("ses_a"), /cancelled/)
    await assert.rejects(previous.command("ses_a", "on"), /cancelled/)
    const next = await fixture(configured)
    assert.equal(next.visible("ses_a"), configured)
  })
}
