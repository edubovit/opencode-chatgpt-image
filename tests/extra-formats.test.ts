import assert from "node:assert/strict"
import { test } from "node:test"
import { validSvg, validGif } from "../src/extra-formats.ts"
import { parseConfig, resolveApiParameters } from "../src/config.ts"
import { generateApiImages } from "../src/openai.ts"

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><path fill="url(#g)" d="M0 0h16v16z"/></svg>')
const frame = "21f90400140000002c0000000001000100000202440100"
const gif = Buffer.from("47494638396101000100800000000000ffffff" + frame + frame + "3b", "hex")
const defaults = parseConfig({}).defaults

test("complexity and animation controls validate, merge, clear and round without changing defaults", () => {
  for (const complexity of ["low", "medium", "high"]) assert.equal(resolveApiParameters(defaults, { complexity }, true).parameters.complexity, complexity)
  assert.equal(resolveApiParameters(defaults, {}, true).parameters.complexity, undefined)
  const configured = parseConfig({ defaults: { output_format: "gif", frame_count: 9, frame_duration_ms: 205, complexity: "low", size: "auto" } }).defaults
  assert.equal(resolveApiParameters(configured, {}, false).parameters.frame_duration_ms, 210)
  assert.equal(resolveApiParameters(configured, { output_format: "png", frame_count: null, frame_duration_ms: null, complexity: null }, false).parameters.complexity, undefined)
  for (const size of ["auto", "16x16", "512x512"]) assert.equal(resolveApiParameters(defaults, { output_format: "gif", size }, false).format, "gif")
})

test("invalid combinations fail before dispatch", () => {
  for (const input of [
    { complexity: "auto" }, { model: "gpt-image-2.5-flare", complexity: "low" },
    { output_format: "svg", n: 2 }, { output_format: "gif", model: "gpt-image-2.5-flare" },
    { output_format: "gif", frame_count: 1 }, { output_format: "gif", frame_count: 65 },
    { output_format: "gif", frame_count: 2.5 }, { output_format: "gif", frame_duration_ms: 2001 },
    { output_format: "gif", frame_duration_ms: 19 }, { output_format: "gif", size: "15x16" },
    { output_format: "gif", output_compression: 80 }, { output_format: "svg", output_compression: 0 },
    { frame_count: 9 }, { frame_duration_ms: 200 },
  ]) assert.throws(() => resolveApiParameters(defaults, input, false))
  for (const output_format of ["svg", "gif"]) assert.throws(() => resolveApiParameters(defaults, { output_format }, true), /generation-only/)
})

test("SVG accepts static vectors and rejects active, malformed and external content", () => {
  assert.equal(validSvg(svg), true)
  for (const text of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://example.com)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:red"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(x);</style></svg>',
    '<!DOCTYPE svg [<!ENTITY x "secret">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    '<?xml-stylesheet href="https://example.com"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>', '<svg/>',
    '<html xmlns="http://www.w3.org/1999/xhtml"/>',
  ]) assert.equal(validSvg(Buffer.from(text)), false, text)
  assert.equal(validSvg(Buffer.from([0xff])), false)
  assert.equal(validSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">' + '<g>'.repeat(130) + '</g>'.repeat(130) + '</svg>')), false)
})

test("GIF checks complete frames, bounds, sub-blocks and trailer", () => {
  assert.equal(validGif(gif), true)
  for (const bytes of [gif.subarray(0, -1), gif.subarray(0, 20), Buffer.concat([gif, Buffer.from([0])]), svg]) assert.equal(validGif(bytes), false)
  const invalid = Buffer.from(gif); invalid.writeUInt16LE(0, 6); assert.equal(validGif(invalid), false)
  const outside = Buffer.from(gif); outside.writeUInt16LE(10, 32); assert.equal(validGif(outside), false)
})

for (const [format, bytes, mime] of [["svg", svg, "image/svg+xml"], ["gif", gif, "image/gif"]] as const) {
  test(`${format} transport passes controls and returns validated bytes with correct MIME`, async () => {
    const parameters = resolveApiParameters(defaults, { output_format: format, complexity: "low", ...(format === "gif" ? { frame_count: 2, frame_duration_ms: 200, size: "auto" } : {}) }, false).parameters
    let calls = 0
    const result = await generateApiImages({ ...parameters, prompt: "synthetic" }, [], {}, "synthetic", new AbortController().signal, async (_, init) => {
      calls++; assert.equal(JSON.parse(String(init?.body)).complexity, "low")
      return Response.json({ data: [{ b64_json: bytes.toString("base64") }], output_format: format })
    })
    assert.equal(calls, 1); assert.deepEqual(result[0]?.bytes, bytes); assert.equal(result[0]?.mime, mime)
    assert.equal(result[0]?.reported?.output_format, format)
    await assert.rejects(generateApiImages(parameters, [], {}, "synthetic", new AbortController().signal, async () => Response.json({ data: [{ b64_json: Buffer.from('private unsafe content').toString('base64') }] })), error => error instanceof Error && !error.message.includes('private unsafe content'))
  })
}
