import { basename } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Info } from "@opencode/plugin/promise/tool"
import { createAuthResolver, type Connections } from "./auth.ts"
import { generateImage } from "./codex.ts"
import { readReferenceImage, resolveOutputPath, resolveReferencePath, writeImage } from "./files.ts"

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

function waitFor<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
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
    throw new Error("reference_images must contain at most five nonempty local paths.")
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
): Info {
  const resolveAuth = createAuthResolver(ctx.integration.connection)
  return {
    name: "chatgpt_image",
    description: "Generate or edit one PNG using the active OpenAI Codex subscription login. Consumes Codex allowance. Optional reference_images uploads up to five local PNG/JPEG/WebP files (10 MiB each). All paths must stay inside the session directory; output_path must be a new .png file. Describe dimensions/style in the prompt; exact model, quality and size are backend-controlled and unverified. No API-key fallback. Do not automatically retry failures: the backend may already have consumed quota.",
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 32_000, description: "Image description or editing instructions. Include the desired aspect ratio here." },
        output_path: { type: "string", minLength: 1, description: "New .png path inside the session directory, for example output/hero.png. Existing files are never overwritten." },
        reference_images: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 }, description: "Local images inside the session directory to upload as edit targets or visual references." },
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
      try {
        signal.throwIfAborted()
        const session = await waitFor(signal, () => ctx.session.get({ sessionID: call.sessionID }))
        const directory = session.location.directory
        const output = await resolveOutputPath(directory, input.output_path)
        const references = await Promise.all(input.reference_images.map(path => resolveReferencePath(directory, path)))
        const assert = (action: string, resources: string[], metadata?: Record<string, unknown>) => waitFor(signal, () => ctx.permission.assert({
          sessionID: call.sessionID,
          agent: call.agent,
          source: { type: "tool", messageID: call.messageID, id: call.id },
          action,
          resources,
          save: resources,
          ...(metadata === undefined ? {} : { metadata }),
        }))
        await assert("chatgpt_image", [output], { description: "Send prompt and reference images to OpenAI; consumes Codex allowance.", referenceImages: references })
        if (references.length) await assert("read", references)
        await assert("edit", [output])
        signal.throwIfAborted()
        const auth = await waitFor(signal, resolveAuth)
        signal.throwIfAborted()
        const images: string[] = []
        for (const path of references) images.push(await readReferenceImage(path, signal))
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
        const result = await generateImage({ prompt: input.prompt, background: input.background, images }, auth, signal, fetcher)
        await checkLocation()
        await writeImage(directory, output, result.bytes, signal)
        return {
          content: [
            { type: "text", text: `Saved ${output}\nUsed the Codex subscription image backend. Effective image model and variant are unverified.` },
            { type: "file", uri: `data:image/png;base64,${result.bytes.toString("base64")}`, mime: "image/png", name: basename(output) },
          ],
          metadata: { output_path: output, requested_model: result.requestedModel, effective_model: result.effectiveModel, bytes: result.bytes.length },
        }
      } catch (error) {
        if (deadline.signal.aborted) throw new Error("Image generation timed out. The backend may still consume quota; do not automatically retry.")
        if (signal.aborted) throw new Error("Image generation cancelled. The backend may still consume quota; do not automatically retry.")
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
