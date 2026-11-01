import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer, Route, ToastOptions } from "@opencode/plugin/tui/context"
import { registerImageCommands } from "../src/tui-commands.ts"

type CommandInput = Parameters<Plugin.Context["client"]["session"]["command"]>[0]

function guarded<T extends object>(value: T): T {
  return new Proxy(value, { get(target, key, receiver) {
    if (!Reflect.has(target, key)) throw new Error(`Unexpected capability access: ${String(key)}`)
    return Reflect.get(target, key, receiver)
  } })
}

function fixture() {
  let route: Route = { type: "session", sessionID: "ses_first" }
  let factory!: () => KeymapLayer
  let request: (input: CommandInput) => Promise<void> = async () => {}
  const calls: CommandInput[] = []
  const toasts: ToastOptions[] = []
  let routeReads = 0
  const context = guarded({
    keymap: guarded({ layer(callback: () => KeymapLayer) { factory = callback; callback() } }),
    client: guarded({ session: guarded({ async command(input: CommandInput) { calls.push(input); await request(input) } }) }),
    ui: guarded({
      router: guarded({ current: () => { routeReads++; return route } }),
      toast: guarded({ show: (toast: ToastOptions) => { toasts.push(toast) } }),
    }),
  }) as unknown as Plugin.Context
  const cleanup = registerImageCommands(context)
  const layer = factory()
  const commands = layer.commands!
  return {
    calls, toasts, layer, commands, cleanup, factory,
    get routeReads() { return routeReads },
    route(value: Route) { route = value },
    request(callback: typeof request) { request = callback },
    enabled(index = 0) { const enabled = commands[index]!.enabled; return typeof enabled === "function" ? enabled() : enabled },
    run(index = 0) { return commands[index]!.run() },
  }
}

test("registers three named palette actions without slash aliases or shortcuts", () => {
  const f = fixture()
  assert.equal(f.layer.mode, "global")
  assert.deepEqual(f.commands.map(command => [command.id, command.title, command.group, command.palette]), [
    ["opencode-chatgpt-image.on", "Enable image tools", "Images", true],
    ["opencode-chatgpt-image.off", "Disable image tools", "Images", true],
    ["opencode-chatgpt-image.status", "Image tools status", "Images", true],
  ])
  for (const command of f.commands) {
    assert.equal(command.slash, undefined)
    assert.equal(command.bind, undefined)
  }
  f.factory()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.toasts, [])
})

test("palette actions call only the existing server command with fixed arguments", async () => {
  const f = fixture()
  for (const command of f.commands) await command.run("ignored draft text")
  assert.deepEqual(f.calls, ["on", "off", "status"].map(text => ({ sessionID: "ses_first", name: "images", text })))
  assert.deepEqual(f.toasts, [])
})

test("commands are unavailable outside a session and stale callbacks are harmless", async () => {
  const f = fixture()
  for (const route of [{ type: "home" }, { type: "plugin", id: "other", name: "other" }] as const) {
    f.route(route)
    for (let index = 0; index < 3; index++) {
      assert.equal(f.enabled(index), false)
      await f.run(index)
    }
  }
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.toasts, [])
})

test("actions target the session displayed at invocation, not setup or menu construction", async () => {
  const f = fixture()
  f.route({ type: "session", sessionID: "ses_second" })
  assert.equal(f.enabled(), true)
  await f.run()
  assert.deepEqual(f.calls, [{ sessionID: "ses_second", name: "images", text: "on" }])
})

test("command failures are handled with static feedback, without leaking raw errors", async () => {
  const f = fixture()
  f.request(async () => { throw new Error("private-token raw response") })
  await f.run()
  assert.deepEqual(f.toasts, [{
    title: "Images", variant: "error", message: "Could not complete the image-tools command. Check /images status.",
  }])
  assert.equal(JSON.stringify(f.toasts).includes("private-token"), false)
})

for (const transition of ["session", "home", "unload"] as const) {
  test(`late command failures cannot notify another session or an unloaded plugin (${transition})`, async () => {
    const f = fixture()
    let reject!: (error: Error) => void
    f.request(() => new Promise((_resolve, fail) => { reject = fail }))
    const pending = f.run()
    const reads = f.routeReads
    if (transition === "unload") f.cleanup()
    else f.route(transition === "session" ? { type: "session", sessionID: "ses_second" } : { type: "home" })
    reject(new Error("late failure"))
    await pending
    if (transition === "unload") assert.equal(f.routeReads, reads)
    assert.deepEqual(f.toasts, [])
    assert.equal(f.calls[0]?.sessionID, "ses_first")
  })
}

test("cleanup revokes captured commands; host owns keymap-layer disposal", async () => {
  const f = fixture()
  f.cleanup()
  const reads = f.routeReads
  for (let index = 0; index < 3; index++) {
    assert.equal(f.enabled(index), false)
    await f.run(index)
  }
  assert.deepEqual(f.calls, [])
  assert.equal(f.routeReads, reads)
})
