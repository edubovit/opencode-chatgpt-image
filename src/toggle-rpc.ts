import { Rpc } from "@opencode/plugin/rpc"
import type { Plugin } from "@opencode/plugin/tui"

export type ToggleStatus = {
  sessionID: string
  enabled: boolean
  enabledByDefault: boolean
  tool: string
}

export const ImageToggleRpc = Rpc.define({
  id: "opencode-chatgpt-image.toggle",
  methods: {},
  events: {
    status: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          enabled: { type: "boolean" },
          enabledByDefault: { type: "boolean" },
          tool: { type: "string" },
        },
        required: ["sessionID", "enabled", "enabledByDefault", "tool"],
        additionalProperties: false,
      },
    },
  },
})

function isToggleStatus(value: unknown): value is ToggleStatus {
  return typeof value === "object" && value !== null
    && "sessionID" in value && typeof value.sessionID === "string"
    && "enabled" in value && typeof value.enabled === "boolean"
    && "enabledByDefault" in value && typeof value.enabledByDefault === "boolean"
    && "tool" in value && typeof value.tool === "string"
}

export function subscribeImageToggle(context: Plugin.Context): () => void {
  return context.client.rpc(ImageToggleRpc).events.on("status", event => {
    if (!isToggleStatus(event.data)) return
    const route = context.ui.router.current()
    if (route.type !== "session" || route.sessionID !== event.data.sessionID) return
    const session = context.data.session.get(route.sessionID)
    if (session && session.location.directory !== event.location.directory) return
    const status = event.data
    context.ui.toast.show({
      title: "Images",
      message: `${status.enabled ? "ON" : "OFF"} (default ${status.enabledByDefault ? "ON" : "OFF"}; ${status.tool})`,
      variant: "info",
    })
  })
}
