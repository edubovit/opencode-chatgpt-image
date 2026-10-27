import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readReferenceImage, resolveOutputPath, resolveReferencePath, writeImage } from "../src/files.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY/jPwPAfAAUAAf+mXJtdAAAAAElFTkSuQmCC", "base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==", "base64");
const webp = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA", "base64");
const signal = () => new AbortController().signal;

async function workspace(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "opencode-image-files-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "session");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root: await realpath(root), outside: await realpath(outside) };
}

async function link(t: TestContext, target: string, path: string, type: "dir" | "file" = "dir") {
  try {
    await symlink(target, path, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Creating symlinks is not supported in this environment");
      return false;
    }
    throw error;
  }
}

async function filePrototype(directory: string): Promise<FileHandle> {
  const path = join(directory, "prototype-probe");
  const handle = await open(path, "wx");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  await rm(path);
  return prototype;
}

test("resolving a nested output is non-mutating, accepts spaces and .PNG", async (t) => {
  const { root } = await workspace(t);
  const expected = join(root, "new folder", "nested", "my image.PNG");
  assert.equal(await resolveOutputPath(root, "new folder/nested/my image.PNG"), expected);
  assert.equal(await resolveOutputPath(root, expected), expected);
  await assert.rejects(lstat(dirname(expected)), { code: "ENOENT" });
  await writeImage(root, expected, png, signal());
  assert.deepEqual(await readFile(expected), png);
});

test("rejects outside paths, sibling prefixes, URLs and invalid output extensions", async (t) => {
  const { root, outside } = await workspace(t);
  for (const path of ["../outside/image.png", "..\\outside\\image.png", join(outside, "image.png"), `${root}-sibling/image.png`]) {
    await assert.rejects(resolveOutputPath(root, path), /within the session directory/);
    await assert.rejects(resolveReferencePath(root, path), /within the session directory/);
  }
  for (const path of ["image.jpeg", "image.png.bak", "image", "https://example.com/image.png"]) {
    await assert.rejects(resolveOutputPath(root, path));
  }
});

test("rejects empty, NUL, ADS, reserved Windows names and ambiguous filenames", async (t) => {
  const { root } = await workspace(t);
  const paths = ["", "   ", "bad\0name.png", "image.png:stream", "image:stream.png", "NUL.png", "con.PNG", "COM1.png", "lpt9.png", "COM¹.png", "NUL .png", "CONIN$.png", "folder./image.png", "folder /image.png", "file?.png", "file*.png", "file\".png", "file|.png", "file<.png", "C:relative.png", "\\\\?\\C:\\image.png", "\\\\.\\NUL"];
  for (const path of paths) {
    await assert.rejects(resolveOutputPath(root, path), path);
    await assert.rejects(resolveReferencePath(root, path), path);
  }
  assert.equal(await resolveOutputPath(root, "console.png"), join(root, "console.png"));
});

test("existing files and directories are rejected without overwriting or renaming", async (t) => {
  const { root } = await workspace(t);
  const path = join(root, "existing.png");
  await writeFile(path, "user content");
  await assert.rejects(resolveOutputPath(root, path), /already exists/);
  await assert.rejects(writeImage(root, path, png, signal()), /already exists/);
  assert.equal(await readFile(path, "utf8"), "user content");
  const directory = join(root, "directory.png");
  await mkdir(directory);
  await assert.rejects(resolveOutputPath(root, directory), /already exists/);
  assert.ok((await lstat(directory)).isDirectory());
});

test("concurrent output writers create exactly one file and never overwrite it", async (t) => {
  const { root } = await workspace(t);
  const path = await resolveOutputPath(root, "race/image.png");
  const inputs = Array.from({ length: 12 }, (_, i) => Buffer.from(`writer ${i}`));
  const results = await Promise.allSettled(inputs.map((bytes) => writeImage(root, path, bytes, signal())));
  const successful = results.flatMap((result, i) => result.status === "fulfilled" ? [i] : []);
  assert.equal(successful.length, 1);
  assert.deepEqual(await readFile(path), inputs[successful[0]!]);
  assert.equal(results.filter((result) => result.status === "rejected").length, 11);
});

test("output and reference resolution reject symlink/junction escapes", async (t) => {
  const { root, outside } = await workspace(t);
  await writeFile(join(outside, "reference.png"), png);
  const escape = join(root, "escape");
  if (!(await link(t, outside, escape))) return;
  await assert.rejects(resolveOutputPath(root, "escape/new/deep/image.png"), /within the session directory/);
  await assert.rejects(resolveReferencePath(root, "escape/reference.png"), /within the session directory/);
  await assert.rejects(writeImage(root, "escape/image.png", png, signal()), /within the session directory/);
  await assert.rejects(lstat(join(outside, "image.png")), { code: "ENOENT" });
});

test("in-tree links and a linked session directory use canonical paths", async (t) => {
  const { root, outside } = await workspace(t);
  const actual = join(root, "actual");
  await mkdir(actual);
  await writeFile(join(actual, "reference.data"), png);
  if (!(await link(t, actual, join(root, "alias")))) return;
  assert.equal(await resolveOutputPath(root, "alias/new/image.png"), join(actual, "new", "image.png"));
  assert.equal(await resolveReferencePath(root, "alias/reference.data"), join(actual, "reference.data"));
  const session = join(outside, "session-alias");
  if (!(await link(t, root, session))) return;
  const target = await resolveOutputPath(session, "image.png");
  assert.equal(target, join(root, "image.png"));
  await writeImage(session, target, png, signal());
  assert.deepEqual(await readFile(target), png);
});

test("writer revalidates when an output ancestor changes after resolution", async (t) => {
  const { root, outside } = await workspace(t);
  const path = await resolveOutputPath(root, "new/nested/image.png");
  if (!(await link(t, outside, join(root, "new")))) return;
  await assert.rejects(writeImage(root, path, png, signal()), /within the session directory/);
  await assert.rejects(lstat(join(outside, "nested")), { code: "ENOENT" });
});

test("existing and dangling output symlinks are never replaced", async (t) => {
  const { root } = await workspace(t);
  const target = join(root, "target");
  await writeFile(target, "user file");
  if (!(await link(t, target, join(root, "existing.png"), "file"))) return;
  if (!(await link(t, join(root, "missing"), join(root, "dangling.png"), "file"))) return;
  for (const path of ["existing.png", "dangling.png"]) {
    await assert.rejects(resolveOutputPath(root, path), /already exists/);
    await assert.rejects(writeImage(root, path, png, signal()), /already exists/);
    assert.ok((await lstat(join(root, path))).isSymbolicLink());
  }
  assert.equal(await readFile(target, "utf8"), "user file");
});

test("reference MIME types come from decodable PNG, JPEG and WebP bytes, not extensions", async (t) => {
  const { root } = await workspace(t);
  for (const [name, bytes, mime] of [["png.txt", png, "image/png"], ["jpeg.png", jpeg, "image/jpeg"], ["webp.jpg", webp, "image/webp"]] as const) {
    const path = join(root, name);
    await writeFile(path, bytes);
    assert.equal(await resolveReferencePath(root, name), path);
    assert.equal(await readReferenceImage(path, signal()), `data:${mime};base64,${bytes.toString("base64")}`);
  }
});

test("reference images must be regular supported image files", async (t) => {
  const { root } = await workspace(t);
  await assert.rejects(resolveReferencePath(root, "."), /regular file/);
  await assert.rejects(readReferenceImage(root, signal()), /regular file/);
  await assert.rejects(resolveReferencePath(root, "missing.png"), { code: "ENOENT" });
  for (const bytes of [Buffer.alloc(0), Buffer.from("secret raw image data"), Buffer.from("GIF89a"), png.subarray(0, 8), jpeg.subarray(0, 10), webp.subarray(0, 20)]) {
    const path = join(root, "invalid.png");
    await writeFile(path, bytes);
    await assert.rejects(readReferenceImage(path, signal()), (error: Error) => {
      assert.match(error.message, /PNG, JPEG, or WebP/);
      assert.doesNotMatch(error.message, /secret raw image data/);
      return true;
    });
  }
});

test("oversized reference files are rejected before reading image data", async (t) => {
  const { root } = await workspace(t);
  const path = join(root, "large.png");
  const handle = await open(path, "wx");
  await handle.truncate(10 * 1024 * 1024 + 1);
  await handle.close();
  const prototype = await filePrototype(root);
  const read = t.mock.method(prototype, "read", async () => { throw new Error("Should not read oversized files"); });
  await assert.rejects(readReferenceImage(path, signal()), /10 MiB/);
  assert.equal(read.mock.callCount(), 0);
});

test("reference reads enforce the limit even when the file grows after stat", async (t) => {
  const { root } = await workspace(t);
  const path = join(root, "growing.png");
  await writeFile(path, png);
  const prototype = await filePrototype(root);
  const original = prototype.read;
  let grew = false;
  t.mock.method(prototype, "read", async function (this: FileHandle, ...args: unknown[]) {
    if (!grew) {
      grew = true;
      await appendFile(path, Buffer.alloc(10 * 1024 * 1024));
    }
    return Reflect.apply(original, this, args);
  });
  await assert.rejects(readReferenceImage(path, signal()), /10 MiB/);
});

test("already-aborted operations do not read or create files or directories", async (t) => {
  const { root } = await workspace(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readReferenceImage(join(root, "missing.png"), controller.signal), { name: "AbortError" });
  await assert.rejects(writeImage(root, "new/image.png", png, controller.signal), { name: "AbortError" });
  await assert.rejects(lstat(join(root, "new")), { code: "ENOENT" });
});

test("reference cancellation is honored between read chunks", async (t) => {
  const { root } = await workspace(t);
  const path = join(root, "image.png");
  await writeFile(path, png);
  const prototype = await filePrototype(root);
  const original = prototype.read;
  const controller = new AbortController();
  t.mock.method(prototype, "read", async function (this: FileHandle, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    controller.abort();
    return result;
  });
  await assert.rejects(readReferenceImage(path, controller.signal), { name: "AbortError" });
  assert.deepEqual(await readFile(path), png);
});

test("write cancellation removes only the newly-created partial output", async (t) => {
  const { root } = await workspace(t);
  const existing = join(root, "existing.png");
  await writeFile(existing, "keep me");
  const path = join(root, "cancelled.png");
  const controller = new AbortController();
  t.mock.method(await filePrototype(root), "writeFile", async function (this: FileHandle) {
    await this.write(Buffer.from("partial"));
    controller.abort();
  });
  await assert.rejects(writeImage(root, path, png, controller.signal), { name: "AbortError" });
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal(await readFile(existing, "utf8"), "keep me");
});

test("write failures remove the partial file without hiding the failure", async (t) => {
  const { root } = await workspace(t);
  const path = join(root, "failed.png");
  const failure = new Error("Simulated disk write failure");
  t.mock.method(await filePrototype(root), "writeFile", async function (this: FileHandle) {
    await this.write(Buffer.from("partial"));
    throw failure;
  });
  await assert.rejects(writeImage(root, path, png, signal()), (error) => error === failure);
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("cleanup preserves a user file that replaces the partial output", async (t) => {
  const { root } = await workspace(t);
  const path = join(root, "replaced.png");
  const controller = new AbortController();
  t.mock.method(await filePrototype(root), "writeFile", async function (this: FileHandle) {
    await this.write(Buffer.from("partial"));
    await rename(path, join(root, "moved-partial.png"));
    await writeFile(path, "replacement user file");
    controller.abort();
  });
  await assert.rejects(writeImage(root, path, png, controller.signal), { name: "AbortError" });
  assert.equal(await readFile(path, "utf8"), "replacement user file");
});
