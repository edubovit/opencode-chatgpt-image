import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const referenceLimit = 10 * 1024 * 1024;
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

function within(directory: string, path: string): boolean {
  const difference = relative(directory, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

function assertWithin(directory: string, path: string): void {
  if (!within(directory, path)) throw new Error(`Path must stay within the session directory: ${path}`);
}

function validateInput(input: string): string {
  if (!input.trim()) throw new Error("Image path must not be empty");
  if (input.includes("\0")) throw new Error("Image path must not contain NUL characters");
  if (/^[/\\]{2}[?.][/\\]/.test(input) || /^[a-z]:(?![/\\])/i.test(input)) {
    throw new Error(`Unsupported image path: ${input}`);
  }
  const path = input.replace(/[/\\]/g, sep);
  for (const part of path.slice(parse(path).root.length).split(sep)) {
    if (!part || part === "." || part === "..") continue;
    if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:[ .]|$)/i.test(part)) {
      throw new Error(`Unsupported image filename: ${part}`);
    }
  }
  return path;
}

async function existing(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function sessionPath(directory: string, input: string): Promise<{ root: string; path: string }> {
  const value = validateInput(input);
  const base = resolve(directory);
  const root = await realpath(base);
  if (!(await stat(root)).isDirectory()) throw new Error(`Session directory is not a directory: ${directory}`);
  const path = resolve(base, value);
  if (!within(base, path)) assertWithin(root, path);
  return { root, path };
}

export async function resolveOutputPath(directory: string, input: string, format = "png"): Promise<string> {
  const { root, path } = await sessionPath(directory, input);
  const extensions = format === "jpeg" ? [".jpg", ".jpeg"] : [`.${format}`];
  if (!extensions.includes(extname(path).toLowerCase())) throw new Error(`Output path must end in ${extensions.join(" or ")}: ${input}`);
  let ancestor = dirname(path);
  while (!(await existing(ancestor))) ancestor = dirname(ancestor);
  const canonical = await realpath(ancestor);
  assertWithin(root, canonical);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Output parent is not a directory: ${ancestor}`);
  const target = join(canonical, relative(ancestor, path));
  assertWithin(root, target);
  if (await existing(target)) throw new Error(`Output already exists; choose a different path: ${target}`);
  return target;
}

export async function resolveReferencePath(directory: string, input: string): Promise<string> {
  const { root, path } = await sessionPath(directory, input);
  const canonical = await realpath(path);
  assertWithin(root, canonical);
  if (!(await stat(canonical)).isFile()) throw new Error(`Reference image must be a regular file: ${path}`);
  return canonical;
}

function imageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 57 && bytes.subarray(0, 8).equals(pngSignature) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("latin1", 12, 16) === "IHDR" &&
      bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
      bytes.subarray(-12, -4).equals(Buffer.from("0000000049454e44", "hex"))) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    return "image/jpeg";
  }
  if (bytes.length >= 26 && bytes.toString("latin1", 0, 4) === "RIFF" &&
      bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString("latin1", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("latin1", 12, 16)) &&
      bytes.readUInt32LE(16) > 0 && bytes.readUInt32LE(16) <= bytes.length - 20) {
    return "image/webp";
  }
  return undefined;
}

export async function readReferenceFile(path: string, signal: AbortSignal, limit = referenceLimit): Promise<{ bytes: Buffer; mime: string }> {
  signal.throwIfAborted();
  const before = await lstat(path, { bigint: true });
  if (!before.isFile()) throw new Error(`Reference image must be a regular file: ${path}`);
  signal.throwIfAborted();
  const file = await open(path, "r");
  try {
    const info = await file.stat({ bigint: true });
    signal.throwIfAborted();
    if (!info.isFile()) throw new Error(`Reference image must be a regular file: ${path}`);
    if (info.dev !== before.dev || info.ino !== before.ino) throw new Error(`Reference image changed before it could be read: ${path}`);
    if (info.size > limit) throw new Error(`Reference image exceeds the ${limit / 1024 / 1024} MiB limit: ${path}`);
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - size));
      const { bytesRead } = await file.read(buffer);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > limit) throw new Error(`Reference image exceeds the ${limit / 1024 / 1024} MiB limit: ${path}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if ((await file.stat()).size > limit) throw new Error(`Reference image exceeds the ${limit / 1024 / 1024} MiB limit: ${path}`);
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    const type = imageType(bytes);
    if (!type) throw new Error(`Reference image must be a valid PNG, JPEG, or WebP image: ${path}`);
    return { bytes, mime: type };
  } finally {
    await file.close();
  }
}

export async function readReferenceImage(path: string, signal: AbortSignal): Promise<string> {
  const image = await readReferenceFile(path, signal);
  return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
}

export async function writeImage(directory: string, path: string, bytes: Buffer, signal: AbortSignal, format = "png"): Promise<void> {
  signal.throwIfAborted();
  const resolved = await resolveOutputPath(directory, path, format);
  signal.throwIfAborted();
  await mkdir(dirname(resolved), { recursive: true });
  signal.throwIfAborted();
  const target = await resolveOutputPath(directory, resolved, format);
  signal.throwIfAborted();
  const file = await open(target, "wx");
  let identity: BigIntStats | undefined;
  let failed = true;
  try {
    identity = await file.stat({ bigint: true });
    signal.throwIfAborted();
    await file.writeFile(bytes, { signal });
    signal.throwIfAborted();
    failed = false;
  } finally {
    try {
      await file.close();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (failed && identity) {
        const current = await existing(target);
        if (current?.isFile() && current.dev === identity.dev && current.ino === identity.ino) {
          try {
            await unlink(target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    }
  }
}
