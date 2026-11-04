import type { Plugin } from "@opencode/plugin"
import { imageType } from "./files.ts"

export type AttachmentMessages = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
export const referenceAdvice = "For attached photos, copy exact attachment: handles from the Available session images list into reference_images; never invent paths, use bare [Image N] labels, or copy base64. Select only relevant images, in deliberate order. In prompt, describe each selected image's role by its reference_images order (image 1, image 2, etc.), what to preserve (identity, composition, colors), and what to change. Put the edit target first; use other images for identity, style or composition as requested. Seeing a photo in chat does not send it to the image backend: include it explicitly. Do not silently omit unavailable references or exceed the tool's image limit."

export function parseAttachment(source: string) {
  if (!/^attachment:/i.test(source)) return undefined
  const match = /^attachment:(msg_[A-Za-z0-9_-]{1,128}):([1-9][0-9]{0,5})$/.exec(source)
  if (!match) throw new Error("Invalid attachment handle. Copy an exact handle from Available session images.")
  return { kind: "attachment" as const, handle: source, messageID: match[1]!, index: Number(match[2]) - 1 }
}

export function attachmentManifest(messages: AttachmentMessages): string {
  const entries: { handle: string; image: number; mime: string }[] = []
  for (const message of messages) {
    if (message.type !== "user" || !/^msg_[A-Za-z0-9_-]{1,128}$/.test(message.id)) continue
    let image = 0
    for (const [index, file] of (message.files ?? []).entries()) {
      if (!file.mime.startsWith("image/")) continue
      image++
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.mime)) continue
      entries.push({ handle: `attachment:${message.id}:${index + 1}`, image, mime: file.mime })
    }
  }
  return `Available session images (oldest to newest; image numbers are within each source message, not upload order; ${entries.length > 32 ? "only newest 32 shown" : "active context only"}): ${JSON.stringify(entries.slice(-32))}. Handles are session-local. Missing/compacted attachments must be reattached; do not substitute another image.`
}

export function readAttachment(reference: NonNullable<ReturnType<typeof parseAttachment>>, messages: AttachmentMessages, limit: number) {
  const message = messages.find(message => message.id === reference.messageID)
  const file = message?.type === "user" ? message.files?.[reference.index] : undefined
  if (!file) throw new Error("Attachment is unavailable in this session's active context. Ask the user to reattach it; no image request was made.")
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mime) || typeof file.data !== "string") {
    throw new Error("Attachment must contain PNG, JPEG, or WebP image data.")
  }
  if (file.data.length > Math.ceil(limit / 3) * 4) throw new Error("Attachment exceeds the reference image byte limit.")
  if (!file.data.length || file.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error("Attachment contains invalid image data.")
  const bytes = Buffer.from(file.data, "base64")
  if (bytes.length > limit) throw new Error("Attachment exceeds the reference image byte limit.")
  if (bytes.toString("base64") !== file.data) throw new Error("Attachment contains invalid image data.")
  const mime = imageType(bytes)
  if (!mime || mime !== file.mime) throw new Error("Attachment image content does not match its supported MIME type.")
  return { bytes, mime, name: `attachment-${reference.index + 1}.${mime.slice(6)}` }
}
