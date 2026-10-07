import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { build } from "vite"

import { parseWebBundleManifest, protocolVersion, webBundleManifestFileName } from "@getdomovoi/protocol"

import { webBundleManifest, writeWebBundleManifest } from "./web-bundle-manifest"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "domovoi-web-manifest-"))
  scratch.push(directory)
  return directory
}

async function put(root: string, relative: string, contents: string | Buffer): Promise<void> {
  const file = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents)
}

async function readManifest(directory: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(directory, webBundleManifestFileName), "utf8")) as unknown
}

function digest(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}

// What a vite build of apps/web leaves in dist/: the entry, the public files
// copied as they are, and content-hashed assets.
const emitted: Record<string, string | Buffer> = {
  "index.html": "<!doctype html><title>Domovoi</title>",
  "manifest.webmanifest": "{\"name\":\"Domovoi\"}",
  "sw.js": "self.addEventListener(\"install\", () => self.skipWaiting())",
  "icons/app-icon-192.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  "assets/index-B0V_-a_P.js": "console.log(1)",
  "assets/index-Ab12Cd34.css": "body{margin:0}",
  "assets/empty-C9d8E7f6.js": "",
}

describe("the web bundle manifest", () => {
  it("lists every emitted file with its digest and size, and never itself", async () => {
    const dist = await scratchDirectory()
    for (const [relative, contents] of Object.entries(emitted)) await put(dist, relative, contents)
    // A manifest left by an earlier build is replaced, not listed.
    await put(dist, webBundleManifestFileName, "{\"stale\":true}")

    await writeWebBundleManifest(dist, "0.0.1")

    const manifest = await readManifest(dist)
    expect(manifest).toEqual({
      format: 1,
      version: "0.0.1",
      protocolVersion,
      files: Object.fromEntries(Object.entries(emitted).map(([relative, contents]) => [
        relative,
        { sha256: digest(contents), bytes: Buffer.byteLength(contents) },
      ])),
    })
    expect(Object.keys((manifest as { files: object }).files)).not.toContain(webBundleManifestFileName)
    // The daemon reads it with the same schema.
    expect(parseWebBundleManifest(manifest)).toMatchObject({ success: true })
  })

  it("writes the files in a stable order, so the same output gives the same manifest", async () => {
    const dist = await scratchDirectory()
    for (const [relative, contents] of Object.entries(emitted).reverse()) await put(dist, relative, contents)

    await writeWebBundleManifest(dist, "0.0.1")

    const { files } = await readManifest(dist) as { files: object }
    expect(Object.keys(files)).toEqual(Object.keys(emitted).sort())
  })

  it("fails the build for a file the daemon would refuse, and writes no manifest", async () => {
    const dist = await scratchDirectory()
    await put(dist, "index.html", "<!doctype html>")
    await put(dist, "assets/index-B0V_-a_P.js.map", "{}")

    await expect(writeWebBundleManifest(dist, "0.0.1")).rejects.toThrow("assets/index-B0V_-a_P.js.map")
    await expect(stat(path.join(dist, webBundleManifestFileName))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.skipIf(process.platform === "win32")("fails the build for a link in the output, which the daemon never serves", async () => {
    const dist = await scratchDirectory()
    await put(dist, "index.html", "<!doctype html>")
    await symlink(path.join(dist, "index.html"), path.join(dist, "copy.html"))

    await expect(writeWebBundleManifest(dist, "0.0.1")).rejects.toThrow("copy.html")
    await expect(stat(path.join(dist, webBundleManifestFileName))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("is written by a vite build after the public files are copied", async () => {
    const root = await scratchDirectory()
    await put(root, "package.json", JSON.stringify({ name: "fixture", version: "1.2.3" }))
    await put(root, "index.html", "<!doctype html><script type=\"module\" src=\"/main.js\"></script>")
    await put(root, "main.js", "document.title = \"fixture\"\n")
    await put(root, "public/sw.js", "self.addEventListener(\"install\", () => self.skipWaiting())\n")

    await build({ root, configFile: false, logLevel: "silent", plugins: [webBundleManifest()] })

    const dist = path.join(root, "dist")
    const manifest = await readManifest(dist) as { version: string; protocolVersion: string; files: Record<string, { sha256: string; bytes: number }> }
    expect(manifest.version).toBe("1.2.3")
    expect(manifest.protocolVersion).toBe(protocolVersion)
    const listed = Object.keys(manifest.files)
    expect(listed).toEqual(expect.arrayContaining(["index.html", "sw.js"]))
    expect(listed.some((relative) => /^assets\/index-[A-Za-z0-9_-]{8}\.js$/.test(relative))).toBe(true)
    expect(listed).not.toContain(webBundleManifestFileName)
    for (const [relative, entry] of Object.entries(manifest.files)) {
      const contents = await readFile(path.join(dist, ...relative.split("/")))
      expect(entry).toEqual({ sha256: digest(contents), bytes: contents.byteLength })
    }
  })
})
