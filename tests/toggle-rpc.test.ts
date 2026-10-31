import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { Route, ToastOptions } from "@opencode/plugin/tui/context"
import type { RpcEventPayload } from "@opencode/plugin/promise/rpc"
import { ImageToggleRpc, subscribeImageToggle, type ToggleStatus } from "../src/toggle-rpc.ts"

type StatusEvent = RpcEventPayload<typeof ImageToggleRpc, "status">

const status: ToggleStatus = {
  sessionID: "ses_visible",
  enabled: false,
  enabledByDefault: true,
  tool: "chatgpt_image",
}

function fixture() {
  let route: Route = { type: "session", sessionID: status.sessionID }
  let directory: string | undefined = "C:/project"
  let listener: ((event: StatusEvent) => void) | undefined
  let disposed = false
  const toasts: ToastOptions[] = []
  const used = {
    client: {
      rpc(definition: typeof ImageToggleRpc) {
        assert.equal(definition, ImageToggleRpc)
        return {
          events: {
            on(name: "status", callback: (event: StatusEvent) => void) {
              assert.equal(name, "status")
              listener = callback
              return () => { disposed = true; listener = undefined }
            },
          },
        }
      },
    },
    data: {
      session: {
        get(sessionID: string) {
          assert.equal(sessionID, route.type === "session" ? route.sessionID : undefined)
          return directory === undefined ? undefined : { location: { directory } }
        },
      },
    },
    ui: {
      router: { current: () => route },
      toast: { show: (toast: ToastOptions) => { toasts.push(toast) } },
    },
  }
  const context = new Proxy(used, {
    get(target, property) {
      if (property === "client" || property === "data" || property === "ui") return target[property]
      throw new Error(`Unexpected host capability: ${String(property)}`)
    },
  }) as unknown as Plugin.Context
  const cleanup = subscribeImageToggle(context)
  return {
    toasts,
    cleanup,
    get disposed() { return disposed },
    route(value: Route) { route = value },
    directory(value: string | undefined) { directory = value },
    emit(data: StatusEvent["data"] = status, eventDirectory = "C:/project") {
      listener?.({
        id: "evt_status",
        created: 0,
        type: "rpc.opencode-chatgpt-image.toggle.status",
        location: { directory: eventDirectory },
        data,
      })
    },
  }
}

test("toggle RPC exposes only a strict status event, without methods", () => {
  assert.equal(ImageToggleRpc.id, "opencode-chatgpt-image.toggle")
  assert.deepEqual(ImageToggleRpc.methods, {})
  assert.deepEqual(Object.keys(ImageToggleRpc.events), ["status"])
  const schema = ImageToggleRpc.events.status.schema
  assert.equal(schema.type, "object")
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ["sessionID", "enabled", "enabledByDefault", "tool"])
  assert.deepEqual(Object.keys(schema.properties), schema.required)
})

test("status toasts show effective/default states and the selected tool", () => {
  const f = fixture()
  for (const enabled of [true, false]) {
    for (const enabledByDefault of [true, false]) {
      f.emit({ ...status, enabled, enabledByDefault, tool: "openai_image" })
    }
  }
  assert.deepEqual(f.toasts, [
    { title: "Images", message: "ON (default ON; openai_image)", variant: "info" },
    { title: "Images", message: "ON (default OFF; openai_image)", variant: "info" },
    { title: "Images", message: "OFF (default ON; openai_image)", variant: "info" },
    { title: "Images", message: "OFF (default OFF; openai_image)", variant: "info" },
  ])
  f.cleanup()
})

test("only the currently displayed session receives feedback", () => {
  const f = fixture()
  f.emit({ ...status, sessionID: "ses_other" })
  f.route({ type: "home" })
  f.emit()
  f.route({ type: "plugin", id: "another", name: "dashboard" })
  f.emit()
  f.route({ type: "session", sessionID: "ses_other" })
  f.emit()
  assert.deepEqual(f.toasts, [])
  f.emit({ ...status, sessionID: "ses_other" })
  assert.equal(f.toasts.length, 1)
  f.cleanup()
})

test("location filtering follows the session rather than the plugin instance", () => {
  const f = fixture()
  f.emit(status, "C:/other")
  assert.deepEqual(f.toasts, [])
  f.directory("C:/moved")
  f.emit()
  assert.deepEqual(f.toasts, [])
  f.emit(status, "C:/moved")
  assert.equal(f.toasts.length, 1)
  f.directory(undefined)
  f.emit()
  assert.equal(f.toasts.length, 2)
  f.cleanup()
})

test("malformed JSON-schema payloads are ignored without stopping the listener", () => {
  const f = fixture()
  for (const data of [{}, { ...status, enabled: "false" }, { ...status, enabledByDefault: null }, { ...status, tool: 1 }, { ...status, sessionID: false }]) {
    f.emit(data)
  }
  assert.deepEqual(f.toasts, [])
  f.emit()
  assert.equal(f.toasts.length, 1)
  f.cleanup()
})

test("cleanup unsubscribes without changing any session state", () => {
  const f = fixture()
  assert.equal(f.disposed, false)
  f.cleanup()
  assert.equal(f.disposed, true)
  f.emit()
  assert.deepEqual(f.toasts, [])
})
