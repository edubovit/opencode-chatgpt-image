import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

if (!process.argv.includes("--approved")) {
  throw new Error("This test spends Codex subscription quota. Get account-owner approval, then run with --approved.")
}

const root = fileURLToPath(new URL("../", import.meta.url))
const executable = process.env.OPENCODE_BIN ?? "opencode"
const temp = join(tmpdir(), "opencode")
await mkdir(temp, { recursive: true })
const directory = await mkdtemp(join(temp, "chatgpt-image-live-"))
await writeFile(join(directory, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugins: [pathToFileURL(root).href],
  agents: {
    "image-smoke": {
      mode: "primary",
      steps: 2,
      system: "Run exactly one authorized image smoke test. Call chatgpt_image once using the exact JSON supplied by the user. Do not use other tools, research, or retry. After the tool finishes or fails, report its outcome briefly. Never claim an effective image model or variant.",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "chatgpt_image", resource: "*", effect: "allow" },
        { action: "read", resource: directory.replaceAll("\\", "/") + "/**", effect: "allow" },
        { action: "edit", resource: directory.replaceAll("\\", "/") + "/**", effect: "allow" },
      ],
    },
  },
}, null, 2))

const activationDeadline = Date.now() + 30_000
while (true) {
  const catalog = JSON.parse(execFileSync(executable, ["api", "get", `/api/plugin?location[directory]=${encodeURIComponent(directory)}`], {
    cwd: directory, encoding: "utf8", timeout: 30_000, windowsHide: true,
  }))
  const plugin = catalog.data?.find((entry: { id?: string }) => entry.id === "opencode-chatgpt-image")
  if (plugin?.state?.status === "active") break
  if (plugin?.state?.status === "failed" || Date.now() >= activationDeadline) {
    throw new Error(`Plugin did not activate: ${JSON.stringify(plugin?.state ?? "not discovered")}`)
  }
  await delay(250)
}

async function run(input: Record<string, unknown>): Promise<void> {
  const args = ["run", "--format", "json", "--agent", "image-smoke", "--model", "openai/gpt-6-astra", "--title", "ChatGPT image live smoke", "--auto", JSON.stringify(input)]
  const child = spawn(executable, args, { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  let bytes = 0
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 100 * 1024 * 1024) child.kill()
    else chunks.push(chunk)
  })
  child.stderr.on("data", (chunk: Buffer) => { if (errors.reduce((sum, value) => sum + value.length, 0) < 16_384) errors.push(chunk) })
  const timer = setTimeout(() => child.kill(), 360_000)
  const code = await new Promise<number | null>((done, reject) => { child.on("exit", done); child.on("error", reject) }).finally(() => clearTimeout(timer))
  const text = Buffer.concat(chunks).toString("utf8")
  const events = text.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const output = resolve(directory, String(input.output_path))
  const image = await readFile(output).catch(() => undefined)
  if (!image) {
    const summaries = events.flatMap(event => {
      if (event.type === "text") return [String(event.part?.text ?? event.text ?? "").slice(0, 2000)]
      if (event.type === "error") return [JSON.stringify(event.error ?? "CLI error").slice(0, 2000)]
      return []
    })
    console.error(JSON.stringify({ exitCode: code, eventTypes: [...new Set(events.map(event => event.type))], summaries, stderr: Buffer.concat(errors).toString("utf8").slice(-2000) }))
    throw new Error("Live image test did not produce the expected output. No retry was attempted.")
  }
  if (!image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Live output is not a PNG.")
  console.log(JSON.stringify({ output, bytes: image.length, width: image.readUInt32BE(16), height: image.readUInt32BE(20), exitCode: code }))
}

console.log(`Live test directory: ${directory}`)
await run({ prompt: "A simple blue ceramic cup on a plain white background, soft studio light, square composition, no text.", output_path: "generated.png" })
await run({ prompt: "Change only the cup color to red. Keep its shape, lighting, background, and composition unchanged.", output_path: "edited.png", reference_images: ["generated.png"] })
console.log("Live generation and reference-image editing completed. Effective model remains unverified.")
