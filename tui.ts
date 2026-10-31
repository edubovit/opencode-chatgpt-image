import { Plugin } from "@opencode/plugin/tui"
import { subscribeImageToggle } from "./src/toggle-rpc.ts"

export default Plugin.define({
  id: "opencode-chatgpt-image",
  setup: subscribeImageToggle,
})
