export type OutputFormat = "png" | "jpeg" | "webp"
export type ApiDefaults = Record<string, string | number>
export type PluginConfig =
  | { mode: "chatgpt"; apiKey?: string; defaults: ApiDefaults; allowExternalReferences?: boolean; enabledByDefault?: boolean }
  | { mode: "api"; apiKey: string; defaults: ApiDefaults; allowExternalReferences?: boolean; enabledByDefault?: boolean }

const models = [
  "gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2.5-flare", "gpt-image-2.5-flare-2026-09-08",
  "gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini",
]

type ParameterSchema = {
  type: "string" | "integer"
  description: string
  enum?: string[]
  minimum?: number
  maximum?: number
  maxLength?: number
}

export const apiParameterProperties: Record<string, ParameterSchema> = {
  model: { type: "string", enum: models, description: "Image model, including gpt-image-2.5-sunburst. Changing model may require overriding quality and size." },
  size: { type: "string", description: "GPT Image 2/2.5: auto or WIDTHxHEIGHT, multiples of 16, edges at most 3840, aspect ratio at most 3:1, and 655360–8294400 pixels. Above 3686400 pixels is experimental. Older models: auto, 1024x1024, 1536x1024 or 1024x1536." },
  orientation: { type: "string", enum: ["horizontal", "vertical", "square", "auto"], description: "Auto preserves size. Horizontal/vertical swap edges; square uses the shorter edge. An explicit size overrides configured orientation unless orientation is also supplied. Non-auto requires a concrete effective size; this field is not sent to OpenAI." },
  quality: { type: "string", enum: ["auto", "low", "medium", "high", "xhigh", "max"], description: "xhigh/max require GPT Image 2.5; other supported models accept auto, low, medium or high." },
  background: { type: "string", enum: ["auto", "opaque", "transparent"], description: "Transparent requires PNG or WebP; GPT Image 2 transparency is in preview." },
  n: { type: "integer", minimum: 1, maximum: 10, description: "Number of final images." },
  output_format: { type: "string", enum: ["png", "jpeg", "webp"], description: "Output format." },
  output_compression: { type: "integer", minimum: 0, maximum: 100, description: "Optional JPEG/WebP compression percentage, 0–100. Not supported for PNG." },
  moderation: { type: "string", enum: ["auto", "low"], description: "Optional generation-only moderation level. Not accepted for edits." },
  safety_identifier: { type: "string", maxLength: 128, description: "Optional stable safety identifier, at most 128 characters. Prefer a hash rather than personal information." },
  user: { type: "string", description: "Optional deprecated end-user identifier; prefer safety_identifier." },
  input_fidelity: { type: "string", enum: ["high", "low"], description: "Optional edit-only fidelity: high/low for GPT Image 1.5, low only for GPT Image 1 Mini. Unsupported for GPT Image 2/2.5." },
}

const baseline: ApiDefaults = {
  model: "gpt-image-2.5-sunburst",
  quality: "max",
  size: "3840x2160",
  output_format: "png",
  n: 1,
  background: "auto",
  orientation: "auto",
}

export const clearableApiParameters = ["output_compression", "moderation", "input_fidelity", "safety_identifier", "user"]

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message)
  return value as Record<string, unknown>
}

function knownParameters(value: unknown): Record<string, unknown> {
  const parameters = object(value, "Image parameters must be an object.")
  if (Object.keys(parameters).some(key => !Object.hasOwn(apiParameterProperties, key))) {
    throw new Error("Unknown image parameter. Credentials, mode, endpoint and streaming settings are not image parameters.")
  }
  return parameters
}

function validateValues(parameters: Record<string, unknown>): asserts parameters is ApiDefaults {
  for (const [name, value] of Object.entries(parameters)) {
    const schema = apiParameterProperties[name]!
    if (schema.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < schema.minimum! || value > schema.maximum!) {
        throw new Error(`${name} must be an integer from ${schema.minimum} to ${schema.maximum}.`)
      }
    } else if (typeof value !== "string" || (schema.enum && !schema.enum.includes(value)) || (schema.maxLength !== undefined && value.length > schema.maxLength)) {
      throw new Error(`${name} must be a supported string value${schema.maxLength === undefined ? "." : ` of at most ${schema.maxLength} characters.`}`)
    }
  }
}

function dimensions(size: string): [number, number] | undefined {
  if (size === "auto") return undefined
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(size)
  if (!match || match[0] !== size) throw new Error("size must be auto or positive integer WIDTHxHEIGHT dimensions.")
  return [Number(match[1]), Number(match[2])]
}

function validateSize(size: string, model: string): void {
  const edges = dimensions(size)
  if (!edges) return
  if (!model.startsWith("gpt-image-2")) {
    if (!["1024x1024", "1536x1024", "1024x1536"].includes(size)) {
      throw new Error("This model requires size auto, 1024x1024, 1536x1024 or 1024x1536. Override size when changing model.")
    }
    return
  }
  const [width, height] = edges
  if (edges.some(edge => !Number.isSafeInteger(edge) || edge % 16 !== 0 || edge > 3840) || Math.max(width, height) > 3 * Math.min(width, height) || width * height < 655_360 || width * height > 8_294_400) {
    throw new Error("size requires multiples of 16, edges at most 3840, aspect ratio at most 3:1, and 655360–8294400 total pixels.")
  }
}

function resolveParameters(defaults: Record<string, unknown>, overrides: Record<string, unknown>, editing?: boolean) {
  const merged = { ...baseline, ...knownParameters(defaults), ...knownParameters(overrides) }
  for (const name of clearableApiParameters) {
    if (Object.hasOwn(overrides, name) && overrides[name] === null) delete merged[name]
  }
  validateValues(merged)
  const parameters = { ...merged }
  const model = parameters.model as string
  const format = parameters.output_format as OutputFormat
  const n = parameters.n as number
  const orientation = Object.hasOwn(overrides, "size") && !Object.hasOwn(overrides, "orientation") ? "auto" : parameters.orientation
  const size = parameters.size as string
  validateSize(size, model)
  const edges = dimensions(size)
  if (orientation !== "auto") {
    if (!edges) throw new Error("Non-auto orientation requires a concrete size, not auto.")
    const short = Math.min(...edges)
    const long = Math.max(...edges)
    parameters.size = orientation === "square" ? `${short}x${short}` : orientation === "vertical" ? `${short}x${long}` : `${long}x${short}`
    validateSize(parameters.size, model)
  }
  delete parameters.orientation
  if (!model.startsWith("gpt-image-2.5-") && ["xhigh", "max"].includes(parameters.quality as string)) {
    throw new Error("quality xhigh/max require GPT Image 2.5. Override quality when changing model.")
  }
  if (format === "jpeg" && parameters.background === "transparent") throw new Error("Transparent backgrounds require png or webp output_format.")
  if (parameters.output_compression !== undefined && format === "png") throw new Error("output_compression requires jpeg or webp output_format.")
  if (parameters.input_fidelity !== undefined) {
    if (model !== "gpt-image-1.5" && model !== "gpt-image-1-mini") throw new Error("input_fidelity is only supported for GPT Image 1.5 and GPT Image 1 Mini.")
    if (model === "gpt-image-1-mini" && parameters.input_fidelity !== "low") throw new Error("GPT Image 1 Mini only supports low input_fidelity.")
    if (editing === false) throw new Error("input_fidelity is only supported for edits.")
  }
  if (editing === true && parameters.moderation !== undefined) throw new Error("moderation is only supported for generation, not edits.")
  return { parameters, format, n }
}

export function parseConfig(value: unknown): PluginConfig {
  const options = object(value === undefined ? {} : value, "Plugin options must be an object.")
  if (Object.keys(options).some(key => !["mode", "apiKey", "defaults", "allowExternalReferences", "enabledByDefault"].includes(key))) throw new Error("Unknown plugin option.")
  if (options.allowExternalReferences !== undefined && typeof options.allowExternalReferences !== "boolean") throw new Error("allowExternalReferences must be a boolean.")
  if (options.enabledByDefault !== undefined && typeof options.enabledByDefault !== "boolean") throw new Error("enabledByDefault must be a boolean.")
  const mode = options.mode === undefined ? "chatgpt" : options.mode
  if (mode !== "chatgpt" && mode !== "api") throw new Error("Plugin mode must be chatgpt or api.")
  let apiKey: string | undefined
  if (mode === "api") {
    if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || /\{env:[^}]*\}/i.test(options.apiKey)) {
      throw new Error("API mode requires a nonempty apiKey without line breaks. Host environment placeholders must be resolved before plugin setup.")
    }
    apiKey = options.apiKey.trim()
  }
  const defaults = { ...baseline, ...knownParameters(options.defaults === undefined ? {} : options.defaults) }
  validateValues(defaults)
  resolveParameters(defaults, {})
  const references = { allowExternalReferences: options.allowExternalReferences ?? true, enabledByDefault: options.enabledByDefault ?? true }
  return mode === "api" ? { mode, apiKey: apiKey!, defaults, ...references } : { mode, defaults, ...references }
}

export function resolveApiParameters(defaults: ApiDefaults, overrides: Record<string, unknown>, editing: boolean): {
  parameters: Record<string, string | number>
  format: OutputFormat
  n: number
} {
  return resolveParameters(defaults, overrides, editing)
}
