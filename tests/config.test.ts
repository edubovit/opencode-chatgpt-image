import assert from "node:assert/strict"
import { test } from "node:test"
import { apiParameterProperties, parseConfig, resolveApiParameters } from "../src/config.ts"

const base = {
  model: "gpt-image-2.5-sunburst", quality: "max", size: "3840x2160",
  output_format: "png", n: 1, background: "auto",
}
const oldModel = { model: "gpt-image-1.5", quality: "high", size: "1024x1024" }
const resolve = (overrides: Record<string, unknown> = {}, editing = false) => resolveApiParameters({}, overrides, editing)

test("defaults select ChatGPT without a key and define overridable API defaults", () => {
  assert.deepEqual(parseConfig(undefined), { mode: "chatgpt", defaults: { ...base, orientation: "auto" } })
  assert.deepEqual(parseConfig({}), parseConfig(undefined))
  assert.deepEqual(resolve(), { parameters: base, format: "png", n: 1 })
})

test("API config accepts a resolved key and preserves optional zero values", () => {
  const config = parseConfig({ mode: "api", apiKey: " sk-test ", defaults: { output_format: "jpeg", output_compression: 0, n: 3 } })
  assert.equal(config.mode, "api")
  assert.equal(config.apiKey, "sk-test")
  assert.equal(config.defaults.output_compression, 0)
  const resolved = resolveApiParameters(config.defaults, { output_format: "webp", n: 10 }, false)
  assert.equal(resolved.format, "webp")
  assert.equal(resolved.n, 10)
  assert.equal(resolved.parameters.output_compression, 0)
})

test("caller overrides every default without changing config or inputs", () => {
  const config = parseConfig({ defaults: { background: "transparent", orientation: "vertical" } })
  const before = structuredClone(config)
  const overrides = { ...oldModel, quality: "medium", size: "1536x1024", orientation: "horizontal", output_format: "jpeg", background: "opaque", n: 2 }
  const resolved = resolveApiParameters(config.defaults, overrides, false)
  assert.deepEqual(resolved.parameters, { model: "gpt-image-1.5", quality: "medium", size: "1536x1024", output_format: "jpeg", background: "opaque", n: 2 })
  assert.deepEqual(config, before)
  assert.equal(overrides.orientation, "horizontal")
})

test("ChatGPT mode ignores optional API keys, including unresolved and malformed ones", () => {
  for (const apiKey of [undefined, null, 42, "", "private\r\ncredential", "{env:UNRESOLVED}"]) {
    const config = parseConfig({ mode: "chatgpt", apiKey })
    assert.equal(config.mode, "chatgpt")
    assert.equal(Object.hasOwn(config, "apiKey"), false)
  }
})

test("API mode fails closed with static errors and never reads environment variables", () => {
  for (const apiKey of [undefined, null, true, 12, "", " \t ", "private-credential\r", "private-credential\n", "{env:OPENAI_API_KEY}", "private-credential{env:KEY}"]) {
    assert.throws(() => parseConfig({ mode: "api", apiKey }), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /API mode requires/)
      assert.doesNotMatch(error.message, /private-credential|OPENAI_API_KEY|\{env:/)
      return true
    })
  }
})

test("rejects invalid config shapes, modes and unknown options", () => {
  for (const value of [null, false, "api", [], new Date(), { mode: null }, { mode: "API" }, { mode: "private-credential" }, { baseURL: "https://example.test" }, { defaults: null }, { defaults: [] }, { defaults: "high" }]) {
    assert.throws(() => parseConfig(value), error => error instanceof Error && !error.message.includes("private-credential"))
  }
})

test("orientation uses configured dimensions without forcing caller sizes", () => {
  const defaults = parseConfig({ defaults: { orientation: "vertical" } }).defaults
  assert.equal(resolveApiParameters(defaults, {}, false).parameters.size, "2160x3840")
  assert.equal(resolveApiParameters(defaults, { size: "1536x1024" }, false).parameters.size, "1536x1024")
  assert.equal(resolveApiParameters(defaults, { size: "auto" }, false).parameters.size, "auto")
  assert.equal(resolveApiParameters(defaults, { orientation: "auto" }, false).parameters.size, "3840x2160")
  assert.equal(resolveApiParameters(defaults, { size: "1536x1024", orientation: "vertical" }, false).parameters.size, "1024x1536")
})

test("orientation swaps only edges, squares the shorter edge, and never goes on the wire", () => {
  for (const [orientation, size] of [["horizontal", "3840x2160"], ["vertical", "2160x3840"], ["square", "2160x2160"], ["auto", "2160x3840"]]) {
    const result = resolve({ size: "2160x3840", orientation })
    assert.equal(result.parameters.size, size)
    assert.equal(Object.hasOwn(result.parameters, "orientation"), false)
  }
  assert.equal(resolve({ ...oldModel, size: "1536x1024", orientation: "square" }).parameters.size, "1024x1024")
  assert.throws(() => resolve({ size: "1536x512", orientation: "square" }), /total pixels/)
  for (const orientation of ["horizontal", "vertical", "square"]) {
    assert.throws(() => resolve({ size: "auto", orientation }), /concrete size/)
    assert.throws(() => parseConfig({ defaults: { size: "auto", orientation } }), /concrete size/)
  }
})

test("all supported model aliases and 2.5 snapshots validate", () => {
  for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst-2026-09-08", "gpt-image-2.5-flare-2026-09-08"]) {
    assert.equal(resolve({ model }).parameters.model, model)
  }
  assert.equal(resolve({ model: "gpt-image-2", quality: "high" }).parameters.model, "gpt-image-2")
  for (const model of ["gpt-image-1.5", "gpt-image-1-mini"]) {
    for (const size of ["auto", "1024x1024", "1536x1024", "1024x1536"]) {
      assert.equal(resolve({ ...oldModel, model, size }).parameters.size, size)
    }
  }
})

test("unsupported, retired and unverified model identifiers are rejected", () => {
  for (const model of ["gpt-image-1", "dall-e-2", "dall-e-3", "chatgpt-image-latest", "gpt-image-2.5", "gpt-image-2.5-sunburst-2099-01-01", "", null]) {
    assert.throws(() => resolve({ model }), /model/)
  }
})

test("changing model never silently lowers incompatible quality or dimensions", () => {
  assert.throws(() => resolve({ model: "gpt-image-1.5" }), /Override size/)
  assert.throws(() => resolve({ model: "gpt-image-1.5", size: "1024x1024" }), /Override quality/)
  assert.throws(() => resolve({ model: "gpt-image-2" }), /Override quality/)
  for (const model of ["gpt-image-1.5", "gpt-image-1-mini", "gpt-image-2"]) {
    for (const quality of ["xhigh", "max"]) assert.throws(() => resolve({ ...oldModel, model, quality }), /quality/)
  }
  for (const quality of ["auto", "low", "medium", "high", "xhigh", "max"]) assert.equal(resolve({ quality }).parameters.quality, quality)
  assert.throws(() => parseConfig({ defaults: { model: "gpt-image-1.5" } }), /Override size/)
})

test("modern sizes enforce exact edge, pixel and aspect ratio boundaries", () => {
  for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"]) {
    for (const size of ["auto", "1024x640", "640x1024", "1536x512", "512x1536", "3840x2160", "2160x3840", "2880x2880"]) {
      assert.equal(resolve({ model, quality: "high", size }).parameters.size, size)
    }
    for (const size of ["1024x624", "512x512", "1568x512", "512x1568", "3856x1024", "1024x3856", "3840x2176", "2176x3840", "2896x2896", "1025x1024", "0x1024", "-1024x1024", "1024.0x1024", "1024X1024", "1024x1024 ", "1024x1024\n", "1024x1024\r\n", "1e3x1024", "999999999999999999999999x1024"]) {
      assert.throws(() => resolve({ model, quality: "high", size }), /size/)
    }
  }
})

test("formats and compression enforce compatibility and preserve zero", () => {
  for (const output_format of ["jpeg", "webp"]) {
    for (const output_compression of [0, 100]) assert.equal(resolve({ output_format, output_compression }).parameters.output_compression, output_compression)
  }
  assert.throws(() => resolve({ output_compression: 0 }), /requires jpeg or webp/)
  assert.throws(() => resolve({ output_format: "jpeg", background: "transparent" }), /Transparent/)
  for (const output_format of ["png", "webp"]) assert.equal(resolve({ output_format, background: "transparent" }).parameters.background, "transparent")
  assert.equal(resolve({ model: "gpt-image-2", quality: "high", background: "transparent" }).parameters.background, "transparent")
  assert.throws(() => parseConfig({ defaults: { output_format: "jpeg", background: "transparent" } }), /Transparent/)
  assert.throws(() => parseConfig({ defaults: { output_compression: 0 } }), /output_compression/)
})

test("unknown and transport-level fields are rejected in both defaults and caller overrides", () => {
  for (const name of ["key", "apiKey", "mode", "baseURL", "stream", "partial_images", "response_format", "prompt", "__proto__", "constructor", "toString"]) {
    assert.throws(() => resolve({ [name]: "private-credential" }), /Unknown image parameter/)
    assert.throws(() => parseConfig({ defaults: { [name]: "private-credential" } }), /Unknown image parameter/)
    assert.throws(() => resolveApiParameters({ [name]: "private-credential" }, {}, false), /Unknown image parameter/)
  }
})

test("rejects null, non-scalars, wrong types, NaN and out-of-range values", () => {
  const invalid: Record<string, unknown[]> = {
    model: [null, 1, {}, undefined], size: [null, 1024, [], undefined],
    orientation: [null, "portrait", true, undefined], quality: [null, "MAX", "standard", 1, undefined],
    background: [null, "none", 0, undefined], n: [null, 0, 11, 1.1, NaN, Infinity, "1", undefined],
    output_format: [null, "jpg", "PNG", 1, undefined], output_compression: [-1, 101, 0.1, NaN, Infinity, "0", undefined],
    moderation: ["high", false, undefined], safety_identifier: [1, "x".repeat(129), undefined],
    user: [1, {}, undefined], input_fidelity: ["auto", 1, undefined],
  }
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) assert.throws(() => resolve({ [name]: value }), new RegExp(name))
  }
  assert.equal(resolve({ safety_identifier: "x".repeat(128), user: "" }).parameters.safety_identifier, "x".repeat(128))
  assert.equal(resolve({ safety_identifier: "" }).parameters.safety_identifier, "")
  assert.equal(resolve({ n: 10 }).n, 10)
})

test("request validation applies to the merged combination", () => {
  const config = parseConfig({ defaults: { output_format: "webp", output_compression: 50 } })
  assert.throws(() => resolveApiParameters(config.defaults, { output_format: "png" }, false), /output_compression/)
  assert.throws(() => resolveApiParameters({ n: NaN }, {}, false), /n must/)
  assert.equal(resolveApiParameters({ n: NaN }, { n: 2 }, false).n, 2)
})

test("caller null clears optional configured defaults without sending null to OpenAI", () => {
  const config = parseConfig({ defaults: { output_format: "webp", output_compression: 50, moderation: "low", safety_identifier: "fixture", user: "fixture" } })
  const result = resolveApiParameters(config.defaults, { output_format: "png", output_compression: null, moderation: null, safety_identifier: null, user: null }, true)
  for (const key of ["output_compression", "moderation", "safety_identifier", "user"]) assert.equal(Object.hasOwn(result.parameters, key), false)
  const editConfig = parseConfig({ defaults: { ...oldModel, input_fidelity: "high" } })
  assert.equal(Object.hasOwn(resolveApiParameters(editConfig.defaults, { input_fidelity: null }, false).parameters, "input_fidelity"), false)
  assert.throws(() => parseConfig({ defaults: { moderation: null } }), /moderation/)
})

test("moderation is generation-only, including when inherited from config", () => {
  for (const moderation of ["auto", "low"]) {
    const config = parseConfig({ defaults: { moderation } })
    assert.equal(resolveApiParameters(config.defaults, {}, false).parameters.moderation, moderation)
    assert.throws(() => resolveApiParameters(config.defaults, {}, true), /moderation.*generation/)
    assert.throws(() => resolve({ moderation }, true), /moderation.*generation/)
  }
  assert.equal(Object.hasOwn(resolve({}, true).parameters, "moderation"), false)
})

test("input_fidelity is edit-only and limited to verified models", () => {
  for (const input_fidelity of ["high", "low"]) {
    const config = parseConfig({ defaults: { ...oldModel, input_fidelity } })
    assert.equal(resolveApiParameters(config.defaults, {}, true).parameters.input_fidelity, input_fidelity)
    assert.throws(() => resolveApiParameters(config.defaults, {}, false), /only supported for edits/)
  }
  assert.equal(resolve({ ...oldModel, model: "gpt-image-1-mini", input_fidelity: "low" }, true).parameters.input_fidelity, "low")
  assert.throws(() => resolve({ ...oldModel, model: "gpt-image-1-mini", input_fidelity: "high" }, true), /only supports low/)
  for (const model of ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]) {
    assert.throws(() => resolve({ model, quality: "high", input_fidelity: "low" }, true), /input_fidelity is only supported/)
    assert.throws(() => parseConfig({ defaults: { model, quality: "high", input_fidelity: "low" } }), /input_fidelity is only supported/)
  }
  assert.equal(Object.hasOwn(resolve({}, true).parameters, "input_fidelity"), false)
})

test("configuration defers operation-specific gating until a request", () => {
  const config = parseConfig({ defaults: { ...oldModel, input_fidelity: "high", moderation: "auto" } })
  assert.throws(() => resolveApiParameters(config.defaults, {}, false), /input_fidelity/)
  assert.throws(() => resolveApiParameters(config.defaults, {}, true), /moderation/)
})

test("parameter schema contains only supported scalar image parameters and no credentials", () => {
  assert.deepEqual(Object.keys(apiParameterProperties).sort(), ["model", "size", "orientation", "quality", "background", "n", "output_format", "output_compression", "moderation", "safety_identifier", "user", "input_fidelity"].sort())
  for (const property of Object.values(apiParameterProperties)) {
    assert.ok(["string", "integer"].includes(property.type))
    assert.ok(property.description.length > 0)
  }
  assert.match(apiParameterProperties.model!.description, /gpt-image-2.5-sunburst/)
  assert.match(apiParameterProperties.orientation!.description, /not sent/)
})
