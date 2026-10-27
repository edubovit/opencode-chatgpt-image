import type { Plugin } from "@opencode/plugin"
import type { CodexAuth } from "./codex.ts"

export type Connections = Pick<Plugin.Context["integration"]["connection"], "active" | "resolve">

const loginHelp = "Connect OpenAI with a Codex browser or device login in /connect. API keys and Sign in with ChatGPT plan-sharing are not supported."

export function createAuthResolver(connections: Connections): () => Promise<CodexAuth> {
  let pending: Promise<CodexAuth> | undefined
  return () => {
    pending ??= resolveAuth(connections).finally(() => { pending = undefined })
    return pending
  }
}

async function resolveAuth(connections: Connections): Promise<CodexAuth> {
  const connection = await connections.active("openai").catch(() => {
    throw new Error(`Could not read the active OpenAI connection. ${loginHelp}`)
  })
  if (connection?.type !== "credential" || connection.method !== "oauth") {
    throw new Error(loginHelp)
  }

  const credential = await connections.resolve(connection).catch(() => {
    throw new Error(`OpenCode could not resolve or refresh the OpenAI credential. ${loginHelp}`)
  })
  if (
    credential?.type !== "oauth" ||
    !["chatgpt-browser", "chatgpt-headless"].includes(credential.methodID) ||
    credential.metadata?.clientID !== undefined ||
    credential.metadata?.scopes !== undefined
  ) {
    throw new Error(loginHelp)
  }
  if (!credential.access.trim() || /[\r\n]/.test(credential.access) || !Number.isFinite(credential.expires) || credential.expires <= Date.now()) {
    throw new Error(`OpenCode returned an empty or expired Codex credential. ${loginHelp}`)
  }
  const accountID = credential.metadata?.accountID
  if (accountID !== undefined && (typeof accountID !== "string" || !accountID.trim() || /[\r\n]/.test(accountID))) {
    throw new Error(`The Codex account metadata is invalid. ${loginHelp}`)
  }
  const active = await connections.active("openai").catch(() => {
    throw new Error("Could not confirm the active OpenAI account. No image request was sent.")
  })
  if (active?.type !== "credential" || active.id !== connection.id || active.method !== "oauth") {
    throw new Error("The active OpenAI account changed. Run the image tool again with the intended account selected.")
  }
  return {
    accessToken: credential.access,
    ...(typeof accountID === "string" ? { accountId: accountID } : {}),
  }
}
