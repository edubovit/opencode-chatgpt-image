import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Info } from "@opencode/plugin/promise/tool"
import { ImageToggleRpc } from "./toggle-rpc.ts"

type Context = {
  session: Pick<Plugin.Context["session"], "hook">
  command: Pick<Plugin.Context["command"], "transform">
  rpc: Pick<Plugin.Context["rpc"], "register">
}

export async function withSessionToggle(ctx: Context, tool: Info, lifetime: AbortSignal, enabledByDefault = true): Promise<Info> {
  const sessions = new Map<string, boolean>()
  const enabled = (sessionID: string) => sessions.get(sessionID) ?? enabledByDefault
  const active = () => {
    if (lifetime.aborted) throw new DOMException("Image plugin unloaded; operation cancelled.", "AbortError")
  }
  lifetime.addEventListener("abort", () => sessions.clear(), { once: true })
  const status = await ctx.rpc.register(ImageToggleRpc, {})
  const filter = (event: SessionContext) => {
    if (lifetime.aborted || !enabled(event.sessionID)) delete event.tools[tool.name]
  }
  for (const hook of ["context", "compaction", "generate"] as const) {
    await ctx.session.hook(hook, filter)
  }
  await ctx.command.transform(editor => editor.add({
    name: "images",
    description: `Enable, disable, or check image tools for this session: /images on|off|status. Default: ${enabledByDefault ? "on" : "off"}.`,
    async execute({ sessionID, prompt }) {
      active()
      const action = prompt.text.trim().toLowerCase() || "status"
      if (!["on", "off", "status"].includes(action) || prompt.files?.length || prompt.agents?.length || prompt.skills?.length) {
        throw new Error("Use /images on, /images off, or /images status without attachments.")
      }
      if (action === "on" || action === "off") sessions.set(sessionID, action === "on")
      await status.events.emit("status", { sessionID, enabled: enabled(sessionID), enabledByDefault, tool: tool.name })
    },
  }))
  return {
    ...tool,
    async execute(input, call) {
      active()
      if (!enabled(call.sessionID)) throw new Error("Image generation is disabled for this session. Run /images on first.")
      return tool.execute(input, call)
    },
  }
}
