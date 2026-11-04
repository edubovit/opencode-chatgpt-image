import { Plugin } from "@opencode/plugin"
import { createImageTool, waitFor } from "./tool.ts"
import { createApiImageTool } from "./api-tool.ts"
import { parseConfig, type PluginConfig } from "./config.ts"
import { withSessionToggle } from "./session-toggle.ts"
import { attachmentManifest } from "./attachments.ts"

export default Plugin.define({
  id: "opencode-chatgpt-image",
  async setup(ctx) {
    await ctx.tool.transform(editor => editor.remove("experimental_image_generate"))
    let config: PluginConfig
    try {
      config = parseConfig(ctx.options)
    } catch {
      console.warn("[opencode-chatgpt-image] Invalid configuration; image tools disabled. Check mode, apiKey and defaults.")
      return
    }
    const lifetime = new AbortController()
    const imageTool = config.mode === "api" ? createApiImageTool(ctx, lifetime.signal, config) : createImageTool(ctx, lifetime.signal, undefined, undefined, config.allowExternalReferences)
    const tool = await withSessionToggle(ctx, imageTool, lifetime.signal, config.enabledByDefault)
    for (const hook of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(hook, async event => {
        const definition = event.tools[tool.name]
        if (!definition || lifetime.signal.aborted) return
        try {
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)])
          const messages = await waitFor(signal, () => ctx.session.context({ sessionID: event.sessionID }))
          definition.description += `\n${attachmentManifest(messages)}`
        } catch {
          definition.description += "\nSession attachment list unavailable. Do not guess attachment handles or silently omit requested references."
        }
      })
    }
    await ctx.tool.transform(editor => {
      editor.add(tool)
    })
    return () => lifetime.abort()
  },
})
