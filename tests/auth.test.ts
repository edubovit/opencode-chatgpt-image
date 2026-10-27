import assert from "node:assert/strict"
import { test } from "node:test"
import { Connection, Credential, Integration } from "@opencode/plugin"
import { createAuthResolver } from "../src/auth.ts"

const connection = Connection.CredentialInfo.make({ type: "credential", id: Credential.ID.make("cred_test"), label: "Test", method: "oauth" })
const credential = (method = "chatgpt-browser", metadata: Record<string, unknown> = { accountID: "test-account" }) => Credential.OAuth.make({
  type: "oauth", methodID: Integration.MethodID.make(method), access: "test-access", refresh: "test-refresh",
  expires: Date.now() + 3_600_000, metadata,
})

for (const method of ["chatgpt-browser", "chatgpt-headless"]) {
  test(`reuses the active host-managed ${method} credential`, async () => {
    let reads = 0
    const resolve = createAuthResolver({
      async active(id) { assert.equal(id, "openai"); return connection },
      async resolve(value) { assert.equal(value, connection); reads++; return credential(method) },
    })
    assert.deepEqual(await resolve(), { accessToken: "test-access", accountId: "test-account" })
    assert.deepEqual(await resolve(), { accessToken: "test-access", accountId: "test-account" })
    assert.equal(reads, 2)
  })
}

test("coalesces concurrent credential refreshes without caching the result", async () => {
  let calls = 0
  const resolve = createAuthResolver({ async active() { return connection }, async resolve() { calls++; return credential() } })
  await Promise.all([resolve(), resolve(), resolve()])
  assert.equal(calls, 1)
  await resolve()
  assert.equal(calls, 2)
})

for (const active of [undefined, { type: "env", name: "OPENAI_API_KEY" }, { ...connection, method: "key" }, { ...connection, method: "external" }] as const) {
  test(`rejects non-Codex connections before resolving: ${JSON.stringify(active)}`, async () => {
    const resolve = createAuthResolver({ async active() { return active }, async resolve() { assert.fail("must not resolve") } })
    await assert.rejects(resolve(), /Codex browser or device login/)
  })
}

for (const value of [
  undefined,
  Credential.Key.make({ type: "key", key: "test-api-key" }),
  credential("chatgpt-token-sharing"),
  credential("oauth"),
  credential("chatgpt-browser", { clientID: "client" }),
  credential("chatgpt-headless", { scopes: [] }),
  { ...credential(), access: "" },
  { ...credential(), access: "token\r\nunsafe" },
  { ...credential(), expires: Date.now() - 100 },
  { ...credential(), expires: Infinity },
  credential("chatgpt-browser", { accountID: 123 }),
  credential("chatgpt-browser", { accountID: "bad\nheader" }),
]) {
  test(`rejects unusable credential ${value?.type}/${value?.type === "oauth" ? value.methodID : "none"}`, async () => {
    const resolve = createAuthResolver({ async active() { return connection }, async resolve() { return value } })
    await assert.rejects(resolve(), /Codex|account metadata/)
  })
}

test("allows a legacy credential without optional account metadata", async () => {
  const resolve = createAuthResolver({ async active() { return connection }, async resolve() { return credential("chatgpt-browser", {}) } })
  assert.deepEqual(await resolve(), { accessToken: "test-access" })
})

test("aborts when the active account changes during resolution", async () => {
  let calls = 0
  const resolve = createAuthResolver({
    async active() { return ++calls === 1 ? connection : undefined },
    async resolve() { return credential() },
  })
  await assert.rejects(resolve(), /account changed/)
})

test("does not disclose host resolution errors or keep a failed pending resolution", async () => {
  let calls = 0
  const resolve = createAuthResolver({
    async active() { return connection },
    async resolve() { if (++calls === 1) throw new Error("secret-token secret-email"); return credential() },
  })
  await assert.rejects(resolve(), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /could not resolve or refresh/)
    assert.doesNotMatch(error.stack ?? "", /secret-/)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal((await resolve()).accessToken, "test-access")
})
