import assert from "node:assert/strict"
import { test } from "node:test"
import { attachmentManifest, parseAttachment, readAttachment, referenceAdvice, type AttachmentMessages } from "../src/attachments.ts"
import { prepareReference, readReference } from "../src/references.ts"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64")
const file = { data: png.toString("base64"), mime: "image/png", source: { type: "inline" as const }, name: "private-name.png" }
const user: Extract<AttachmentMessages[number], { type: "user" }> = { id: "msg_photo", type: "user", text: "private prompt", time: { created: 0 }, files: [file, file] }
const messages: AttachmentMessages = [user]
const handle = "attachment:msg_photo:2"
const reference = parseAttachment(handle)!

test("attachment handles use exact message and file slot, not unstable image labels", () => {
  assert.deepEqual(reference, { kind: "attachment", handle, messageID: "msg_photo", index: 1 })
  assert.equal(parseAttachment("source.png"), undefined)
  for (const value of ["attachment:msg_photo:0", "attachment:msg_photo:-1", "attachment:msg_photo:01", "attachment:msg_photo:2/../x", "Attachment:msg_photo:1", "attachment:other:1"]) assert.throws(() => parseAttachment(value))
  assert.deepEqual(readAttachment(reference, messages, png.length).bytes, png)
})

test("manifest contains bounded handles and message-local image numbers, never bytes/names/prompts", () => {
  const many: AttachmentMessages = Array.from({ length: 40 }, (_, i) => ({ ...messages[0]!, id: `msg_${i}` }))
  const manifest = attachmentManifest(many)
  assert.equal((manifest.match(/"handle":/g) ?? []).length, 32)
  for (const secret of [file.data, file.name, "private prompt"]) assert.equal(manifest.includes(secret), false)
  assert.match(manifest, /only newest 32/)
  assert.match(manifest, /attachment:msg_39:2/)
  assert.match(referenceAdvice, /preserve.*identity/)
  assert.match(referenceAdvice, /Do not silently omit/)
})

test("non-image and unsupported slots do not renumber attachment handles", () => {
  const mixed: AttachmentMessages = [{ ...user, files: [{ ...file, mime: "text/plain" }, { ...file, mime: "image/gif" }, file] }]
  assert.match(attachmentManifest(mixed), /"handle":"attachment:msg_photo:3","image":2/)
  assert.throws(() => readAttachment(parseAttachment("attachment:msg_photo:2")!, mixed, 1000), /PNG/)
})

test("missing, other-session, removed and out-of-range references fail without substitutes", () => {
  for (const source of [[], [{ ...messages[0]!, id: "msg_other" }]] as AttachmentMessages[]) assert.throws(() => readAttachment(reference, source, 1000), /unavailable/)
  assert.throws(() => readAttachment(parseAttachment("attachment:msg_photo:3")!, messages, 1000), /unavailable/)
})

test("attachment validation enforces bytes, base64 and detected MIME", () => {
  assert.throws(() => readAttachment(reference, messages, png.length - 1), /byte limit/)
  for (const changed of [{ data: "!!!!" }, { data: "AB==" }, { data: "" }, { mime: "image/jpeg" }, { data: "a".repeat(1000) }]) {
    const altered: AttachmentMessages = [{ ...user, files: [file, { ...file, ...changed }] }]
    assert.throws(() => readAttachment(reference, altered, 500))
  }
})

test("attachment read uses read approval, never filesystem or source URI", async () => {
  const ref = await prepareReference("nonexistent-directory", handle, false)
  const actions: string[] = []
  const result = await readReference(ref, new AbortController().signal, 1000, async (action, resources) => {
    actions.push(action); assert.deepEqual(resources, [handle])
  }, async () => { assert.deepEqual(actions, ["read"]); return [{ ...messages[0]!, files: [file, { ...file, source: { type: "uri", uri: "https://127.0.0.1/private" } }] }] })
  assert.deepEqual(result.bytes, png)
  assert.equal(result.name, "attachment-2.png")
})

test("denial identity is preserved before loading; host failures are redacted", async () => {
  const denial = new Error("declined")
  let loaded = false
  await assert.rejects(readReference(reference, new AbortController().signal, 1000, async () => { throw denial }, async () => { loaded = true; return messages }), error => error === denial)
  assert.equal(loaded, false)
  await assert.rejects(readReference(reference, new AbortController().signal, 1000, async () => {}, async () => { throw new Error("secret-host-data") }), error => error instanceof Error && !error.message.includes("secret-host-data"))
})

test("cancellation stops waiting for attachment hydration", async () => {
  const controller = new AbortController()
  const result = readReference(reference, controller.signal, 1000, async () => {}, () => new Promise(() => {}))
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(result, { name: "AbortError" })
})
