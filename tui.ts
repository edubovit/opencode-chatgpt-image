import { Plugin } from "@opencode/plugin/tui"
import { subscribeImageToggle } from "./src/toggle-rpc.ts"
import { registerImageCommands } from "./src/tui-commands.ts"

export default Plugin.define({
  id: "opencode-chatgpt-image",
  setup(context) {
    const disposeCommands = registerImageCommands(context)
    const unsubscribe = subscribeImageToggle(context)
    return () => {
      disposeCommands()
      unsubscribe()
    }
  },
})
