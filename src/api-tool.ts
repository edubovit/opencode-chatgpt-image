import { basename, extname } from "node:path"
import type { Info } from "@opencode/plugin/promise/tool"
import { apiParameterProperties, clearableApiParameters, resolveApiParameters, type PluginConfig } from "./config.ts"
import { generateApiImages, type ImageUpload } from "./openai.ts"
import { readReferenceFile, resolveOutputPath, resolveReferencePath, writeImage } from "./files.ts"
import { waitFor, type ImageContext } from "./tool.ts"

type ApiConfig = Extract<PluginConfig, { mode: "api" }>
const fileFields = ["prompt", "output_path", "reference_images", "mask", "markup"]

function parseInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected image tool arguments.")
  const input = value as Record<string, unknown>
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 32_000) throw new Error("prompt must contain 1–32000 characters.")
  if (typeof input.output_path !== "string" || !input.output_path.trim()) throw new Error("output_path is required.")
  const references = input.reference_images === undefined ? [] : input.reference_images
  if (!Array.isArray(references) || references.length > 16 || references.some(path => typeof path !== "string" || !path.trim())) throw new Error("reference_images must contain at most sixteen nonempty local paths.")
  for (const field of ["mask", "markup"]) {
    if (input[field] !== undefined && (typeof input[field] !== "string" || !input[field].trim())) throw new Error(`${field} must be a nonempty local PNG path.`)
  }
  if (input.mask !== undefined && input.markup !== undefined) throw new Error("mask and markup are mutually exclusive.")
  if (!references.length && (input.mask !== undefined || input.markup !== undefined)) throw new Error("mask and markup require reference_images.")
  return {
    prompt: input.prompt, output_path: input.output_path, references: references as string[],
    mask: input.mask as string | undefined, markup: input.markup as string | undefined,
    overrides: Object.fromEntries(Object.entries(input).filter(([key]) => !fileFields.includes(key))),
  }
}

export function createApiImageTool(ctx: ImageContext, lifetime: AbortSignal, config: ApiConfig, timeoutMs = 300_000, fetcher: typeof fetch = fetch): Info {
  const properties = Object.fromEntries(Object.entries(apiParameterProperties).map(([key, schema]) => [key, {
    ...(clearableApiParameters.includes(key) ? {
      anyOf: [schema, { type: "null" as const }], description: `${schema.description} Pass null to clear a configured default.`,
    } : schema),
    ...(config.defaults[key] === undefined ? {} : {
      default: config.defaults[key], description: `${schema.description} Configured default: ${JSON.stringify(config.defaults[key])}.${clearableApiParameters.includes(key) ? " Pass null to clear it." : ""}`,
    }),
  }]))
  return {
    name: "openai_image",
    description: "Generate or edit images using the paid OpenAI Images API, not ChatGPT subscription allowance. Caller parameters override configured defaults. Returns all images as new local files and attachments. All paths must stay inside the session directory. Supports up to 16 reference images, masks or markup, and PNG/JPEG/WebP outputs. For n>1, output_path is the first file; others add -2, -3, etc. Existing files are never overwritten. No automatic retries or subscription fallback. Streaming previews are not supported.",
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 32_000 },
        output_path: { type: "string", minLength: 1, description: "New output path; extension must match output_format (PNG by default)." },
        reference_images: { type: "array", maxItems: 16, items: { type: "string", minLength: 1 }, description: "Local PNG/JPEG/WebP references; each less than 50 MB. References select the editing endpoint." },
        mask: { type: "string", minLength: 1, description: "Optional PNG mask, less than 4 MB, first-reference dimensions; transparent pixels select edits. Exclusive with markup." },
        markup: { type: "string", minLength: 1, description: "Optional transparent PNG annotation overlay for GPT Image 2.5 edits, first-reference dimensions. Exclusive with mask." },
        ...properties,
      },
      required: ["prompt", "output_path"], additionalProperties: false,
    },
    options: { codemode: false },
    async execute(value, call) {
      const input = parseInput(value)
      const { parameters, format, n } = resolveApiParameters(config.defaults, input.overrides, input.references.length > 0)
      if (input.markup && !String(parameters.model).startsWith("gpt-image-2.5-")) throw new Error("markup requires a GPT Image 2.5 model.")
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), timeoutMs)
      timer.unref()
      const signal = AbortSignal.any([call.signal, lifetime, deadline.signal])
      const saved: string[] = []
      try {
        const session = await waitFor(signal, () => ctx.session.get({ sessionID: call.sessionID }))
        const directory = session.location.directory
        const extension = extname(input.output_path)
        const paths = Array.from({ length: n }, (_, i) => i === 0 ? input.output_path : `${input.output_path.slice(0, -extension.length)}-${i + 1}${extension}`)
        const outputs = await Promise.all(paths.map(path => resolveOutputPath(directory, path, format)))
        const references = await Promise.all(input.references.map(path => resolveReferencePath(directory, path)))
        const mask = input.mask ? await resolveReferencePath(directory, input.mask) : undefined
        const markup = input.markup ? await resolveReferencePath(directory, input.markup) : undefined
        const reads = [...references, ...[mask, markup].filter((path): path is string => path !== undefined)]
        const assert = (action: string, resources: string[]) => waitFor(signal, () => ctx.permission.assert({
          sessionID: call.sessionID, agent: call.agent, source: { type: "tool", messageID: call.messageID, id: call.id },
          action, resources, save: resources,
          ...(action === "openai_image" ? { metadata: { description: "Billed OpenAI API image request.", model: parameters.model, quality: parameters.quality, size: parameters.size, n } } : {}),
        }))
        await assert("openai_image", outputs)
        if (reads.length) await assert("read", reads)
        await assert("edit", outputs)
        const images: ImageUpload[] = []
        const overlays: { mask?: ImageUpload; markup?: ImageUpload } = {}
        let uploadBytes = 0
        const upload = async (path: string, limit: number) => {
          const current = await resolveReferencePath(directory, path)
          if (current !== path) throw new Error("Reference image path changed after permission approval.")
          const image = await readReferenceFile(path, signal, limit)
          uploadBytes += image.bytes.length
          if (uploadBytes > 200 * 1024 * 1024) throw new Error("Combined image uploads exceed the 200 MiB limit.")
          return { ...image, name: basename(path) }
        }
        for (const path of references) images.push(await upload(path, 49_999_999))
        for (const [kind, path] of [["mask", mask], ["markup", markup]] as const) {
          if (!path) continue
          const image = await upload(path, kind === "mask" ? 3_999_999 : 49_999_999)
          if (image.mime !== "image/png") throw new Error(`${kind} must be PNG.`)
          overlays[kind] = image
        }
        const checkLocation = async () => {
          const current = await waitFor(signal, () => ctx.session.get({ sessionID: call.sessionID }))
          if (current.location.directory !== directory) throw new Error("The session moved. No further output will be written; do not automatically retry.")
          signal.throwIfAborted()
        }
        await checkLocation()
        await waitFor(signal, () => call.progress({ status: "generating", output_paths: outputs }))
        const results = await generateApiImages({ ...parameters, prompt: input.prompt }, images, overlays, config.apiKey, signal, fetcher)
        for (const [i, image] of results.entries()) {
          await checkLocation()
          await writeImage(directory, outputs[i]!, image.bytes, signal, format)
          saved.push(outputs[i]!)
        }
        return {
          content: [
            { type: "text", text: `Saved ${saved.join(", ")}\nBilled to the OpenAI API. Requested model: ${parameters.model}; quality: ${parameters.quality}; size: ${parameters.size}.` },
            ...results.map((image, i) => ({ type: "file" as const, uri: `data:${image.mime};base64,${image.bytes.toString("base64")}`, mime: image.mime, name: basename(outputs[i]!) })),
          ],
          metadata: { output_paths: saved, requested_model: parameters.model, quality: parameters.quality, size: parameters.size, n, output_format: format },
        }
      } catch (error) {
        const partial = saved.length ? ` Files already saved: ${saved.join(", ")}.` : ""
        if (deadline.signal.aborted) throw new Error(`Image generation timed out. API charges may still apply; do not automatically retry.${partial}`)
        if (signal.aborted) throw new Error(`Image generation cancelled. API charges may still apply; do not automatically retry.${partial}`)
        if (saved.length) throw new Error(`Could not save all generated images. Do not automatically retry.${partial}`)
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
