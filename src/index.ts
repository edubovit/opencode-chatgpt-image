import { Plugin } from "@opencode/plugin"
import { createImageTool } from "./tool.ts"
import { createApiImageTool } from "./api-tool.ts"
import { parseConfig, type PluginConfig } from "./config.ts"

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
    const tool = config.mode === "api" ? createApiImageTool(ctx, lifetime.signal, config) : createImageTool(ctx, lifetime.signal, undefined, undefined, config.allowExternalReferences)
    await ctx.tool.transform(editor => {
      editor.add(tool)
    })
    return () => lifetime.abort()
  },
})
