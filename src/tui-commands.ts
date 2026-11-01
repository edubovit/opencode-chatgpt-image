import type { Plugin } from "@opencode/plugin/tui"

export function registerImageCommands(context: Plugin.Context): () => void {
  let disposed = false
  context.keymap.layer(() => ({
    mode: "global",
    commands: ([
      ["on", "Enable image tools"],
      ["off", "Disable image tools"],
      ["status", "Image tools status"],
    ] as const).map(([action, title]) => ({
      id: `opencode-chatgpt-image.${action}`,
      title,
      description: `Run /images ${action} for this session without changing the draft prompt.`,
      group: "Images",
      palette: true,
      enabled: () => !disposed && context.ui.router.current().type === "session",
      async run() {
        if (disposed) return
        const route = context.ui.router.current()
        if (route.type !== "session") return
        try {
          await context.client.session.command({ sessionID: route.sessionID, name: "images", text: action })
        } catch {
          if (disposed) return
          const current = context.ui.router.current()
          if (current.type !== "session" || current.sessionID !== route.sessionID) return
          context.ui.toast.show({
            title: "Images",
            message: "Could not complete the image-tools command. Check /images status.",
            variant: "error",
          })
        }
      },
    })),
  }))
  return () => { disposed = true }
}
