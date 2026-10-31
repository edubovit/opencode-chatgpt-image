import { basename } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Info } from "@opencode/plugin/promise/tool"
import { createAuthResolver, type Connections } from "./auth.ts"
import { generateImage } from "./codex.ts"
import { resolveOutputPath, writeImage } from "./files.ts"
import { prepareReference, readReference } from "./references.ts"
import { ImageRequestError } from "./image-response.ts"

export type ImageContext = {
  integration: { connection: Connections }
  permission: Pick<Plugin.Context["permission"], "assert">
  session: Pick<Plugin.Context["session"], "get">
}

type ImageInput = {
  prompt: string
  output_path: string
  reference_images: string[]
  background: "opaque" | "transparent"
}

export function waitFor<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Image generation cancelled.", "AbortError"))
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return operation()
    }).then(value => {
      signal.removeEventListener("abort", abort)
      resolve(value)
    }, error => {
      signal.removeEventListener("abort", abort)
      reject(error)
    })
  })
}

function parseInput(value: unknown): ImageInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected image tool arguments.")
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !["prompt", "output_path", "reference_images", "background"].includes(key))) {
    throw new Error("Unknown image tool argument. Model, quality and exact size selection are not supported.")
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 32_000) {
    throw new Error("prompt must contain 1–32000 characters.")
  }
  if (typeof input.output_path !== "string" || !input.output_path.trim()) throw new Error("output_path is required.")
  const references = input.reference_images ?? []
  if (!Array.isArray(references) || references.length > 5 || references.some(path => typeof path !== "string" || !path.trim())) {
    throw new Error("reference_images must contain at most five nonempty paths or HTTPS URLs.")
  }
  const background = input.background ?? "opaque"
  if (background !== "opaque" && background !== "transparent") throw new Error("background must be opaque or transparent.")
  return { prompt: input.prompt, output_path: input.output_path, reference_images: references, background }
}

export function createImageTool(
  ctx: ImageContext,
  lifetime: AbortSignal,
  timeoutMs = 300_000,
  fetcher: typeof fetch = fetch,
  allowExternalReferences = true,
): Info {
  const resolveAuth = createAuthResolver(ctx.integration.connection)
  return {
    name: "chatgpt_image",
    description: "Generate or edit one PNG using the active OpenAI Codex subscription login. Only generate when the user requests an image. Consumes Codex allowance. Optional reference_images uploads up to five PNG/JPEG/WebP files or public HTTPS images (10 MiB each). External local references are enabled by default, subject to file permissions and allowExternalReferences configuration. output_path must be a new .png inside the session directory. Describe dimensions/style in the prompt; exact model, quality and size are backend-controlled and unverified. No API-key fallback. Do not automatically retry failures: the backend may already have consumed quota.",
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 32_000, description: "Image description or editing instructions. Include the desired aspect ratio here." },
        output_path: { type: "string", minLength: 1, description: "New .png path inside the session directory, for example output/hero.png. Existing files are never overwritten." },
        reference_images: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 }, description: "Local paths or public HTTPS image URLs to upload as edit targets or references. External local paths require allowExternalReferences." },
        background: { type: "string", enum: ["opaque", "transparent"], description: "Requested background, default opaque." },
      },
      required: ["prompt", "output_path"],
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(value, call) {
      const input = parseInput(value)
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), timeoutMs)
      timer.unref()
      const signal = AbortSignal.any([call.signal, lifetime, deadline.signal])
      let submitted = false
      try {
        signal.throwIfAborted()
        const session = await waitFor(signal, () => ctx.session.get({ sessionID: call.sessionID }))
        const directory = session.location.directory
        const output = await resolveOutputPath(directory, input.output_path)
        const references = await Promise.all(input.reference_images.map(path => prepareReference(directory, path, allowExternalReferences)))
        const assert = (action: string, resources: string[], metadata?: Record<string, unknown>) => waitFor(signal, () => ctx.permission.assert({
          sessionID: call.sessionID,
          agent: call.agent,
          source: { type: "tool", messageID: call.messageID, id: call.id },
          action,
          resources,
          save: resources,
          ...(metadata === undefined ? {} : { metadata }),
        }))
        await assert("chatgpt_image", ["gpt-image-2"], { description: "Send prompt and reference images to OpenAI; consumes Codex allowance.", referenceCount: references.length, output_path: output })
        await assert("edit", [output])
        signal.throwIfAborted()
        const images: string[] = []
        for (const reference of references) {
          const image = await readReference(reference, signal, 10 * 1024 * 1024, assert)
          images.push(`data:${image.mime};base64,${image.bytes.toString("base64")}`)
        }
        const auth = await waitFor(signal, resolveAuth)
        signal.throwIfAborted()
        const checkLocation = async () => {
          signal.throwIfAborted()
          const current = await waitFor(signal, () => ctx.session.get({ sessionID: call.sessionID }))
          if (current.location.directory !== directory) {
            throw new Error("The session moved during image generation. No output was written; do not automatically retry.")
          }
          signal.throwIfAborted()
        }
        await checkLocation()
        await waitFor(signal, () => call.progress({ status: "generating", output_path: output }))
        submitted = true
        const result = await generateImage({ prompt: input.prompt, background: input.background, images }, auth, signal, fetcher)
        await checkLocation()
        await writeImage(directory, output, result.bytes, signal)
        return {
          content: [
            { type: "text", text: `Saved ${output}\nUsed the Codex subscription image backend. Effective image model and variant are unverified.${result.reported ? `\nReported settings: ${JSON.stringify(result.reported)}` : ""}${result.usage ? `\nReported usage: ${JSON.stringify(result.usage)}` : ""}` },
            { type: "file", uri: `data:image/png;base64,${result.bytes.toString("base64")}`, mime: "image/png", name: basename(output) },
          ],
          metadata: { output_path: output, requested_model: result.requestedModel, effective_model: result.effectiveModel, bytes: result.bytes.length, ...(result.reported ? { reported: result.reported } : {}), ...(result.usage ? { usage: result.usage } : {}) },
        }
      } catch (error) {
        if (deadline.signal.aborted || signal.aborted) throw new ImageRequestError(deadline.signal.aborted ? "timeout" : "cancelled", `Image generation ${deadline.signal.aborted ? "timed out" : "cancelled"}.`, {
          phase: submitted ? "dispatch" : "local", outcome: submitted ? "ambiguous" : "not_submitted",
        })
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
