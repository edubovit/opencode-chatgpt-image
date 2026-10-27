import { Plugin } from "@opencode/plugin"
import { createImageTool } from "./tool.ts"

export default Plugin.define({
  id: "opencode-chatgpt-image",
  async setup(ctx) {
    const lifetime = new AbortController()
    await ctx.tool.transform(editor => {
      editor.add(createImageTool(ctx, lifetime.signal))
    })
    return () => lifetime.abort()
  },
})
