import { SaxesParser } from "saxes"

const svgNS = "http://www.w3.org/2000/svg"
const tags = new Set("svg g defs path rect circle ellipse line polyline polygon text tspan title desc linearGradient radialGradient stop clipPath mask pattern".split(" "))
const attributes = new Set("id viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity clip-path clip-rule mask font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing word-spacing dx dy rotate textLength lengthAdjust gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr patternUnits patternContentUnits patternTransform preserveAspectRatio version".split(" "))

export function validSvg(bytes: Buffer): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const parser = new SaxesParser({ xmlns: true })
    let depth = 0
    let nodes = 0
    const reject = () => { throw new Error("Unsupported SVG") }
    parser.on("error", reject)
    parser.on("doctype", reject)
    parser.on("processinginstruction", reject)
    parser.on("opentag", tag => {
      if (++depth > 128 || ++nodes > 100_000 || tag.uri !== svgNS || !tags.has(tag.local) || (nodes === 1 && tag.local !== "svg")) reject()
      for (const attr of Object.values(tag.attributes)) {
        if (attr.name === "xmlns" && attr.value === svgNS) continue
        if (attr.uri || attr.prefix || !attributes.has(attr.local)) reject()
        const value = attr.value
        if (/[\\\x00-\x1f\x7f]/.test(value)) reject()
        if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(value)) reject()
      }
    })
    parser.on("closetag", () => { depth-- })
    parser.write(text).close()
    return nodes > 0 && depth === 0
  } catch { return false }
}

export function validGif(bytes: Buffer): boolean {
  if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return false
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8)
  if (!width || !height || width > 3840 || height > 3840) return false
  let offset = 13 + (bytes[10]! & 128 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0)
  let frames = 0
  const blocks = () => {
    let data = 0
    while (offset < bytes.length) {
      const size = bytes[offset++]!
      if (!size) return data
      offset += size
      data += size
      if (offset > bytes.length) return -1
    }
    return -1
  }
  while (offset < bytes.length) {
    const kind = bytes[offset++]
    if (kind === 0x3b) return frames >= 2 && frames <= 64 && offset === bytes.length
    if (kind === 0x21) {
      const label = bytes[offset++]
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) return false
        offset += 6
      } else if (label === 0xff || label === 0xfe) {
        if (blocks() < 0) return false
      } else return false
    } else if (kind === 0x2c) {
      if (offset + 9 > bytes.length || ++frames > 64) return false
      const x = bytes.readUInt16LE(offset), y = bytes.readUInt16LE(offset + 2)
      const w = bytes.readUInt16LE(offset + 4), h = bytes.readUInt16LE(offset + 6)
      if (!w || !h || x + w > width || y + h > height) return false
      const packed = bytes[offset + 8]!
      offset += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0)
      const codeSize = bytes[offset++] ?? 0
      if (codeSize < 2 || codeSize > 8 || blocks() <= 0) return false
    } else return false
  }
  return false
}
