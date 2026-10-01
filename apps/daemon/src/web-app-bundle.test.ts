import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { maximumWebBundleFileBytes, maximumWebBundleManifestBytes, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"
import { loadWebAppBundle, type WebAppBundleFileSystem } from "./web-app-bundle.js"

const posix = process.platform !== "win32"
const scratch: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratch)
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "domovoi-web-bundle-"))
  scratch.push(path)
  await chmod(path, 0o755)
  return path
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

const defaultFiles: Record<string, string> = {
  "index.html": "<!doctype html><title>Domovoi</title>",
  "sw.js": "self.addEventListener(\"install\", () => {})",
  "manifest.webmanifest": "{\"name\":\"Domovoi\"}",
  "assets/index-abc123.js": "console.log(1)",
  "assets/index-abc123.css": "body{}",
}

type ManifestOverrides = {
  protocolVersion?: string
  files?: Record<string, { sha256: string, bytes: number }>
}

// Writes the files and a manifest naming exactly them, with modes set so the
// fixture does not depend on this machine's umask.
async function bundle(files: Record<string, string> = defaultFiles, overrides: ManifestOverrides = {}): Promise<string> {
  const root = join(await directory(), "web")
  await mkdir(root, { mode: 0o755 })
  await chmod(root, 0o755)
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"))
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    await writeFile(target, content, { mode: 0o644 })
    await chmod(target, 0o644)
  }
  const listed = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { sha256: sha256(content), bytes: Buffer.byteLength(content) }]))
  await writeManifest(root, {
    format: 1,
    version: "0.0.1",
    protocolVersion: overrides.protocolVersion ?? protocolVersion,
    files: overrides.files ?? listed,
  })
  return root
}

async function writeManifest(root: string, value: unknown): Promise<void> {
  const path = join(root, "domovoi-web.json")
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o644 })
  await chmod(path, 0o644)
}

async function profile(): Promise<string> {
  const path = join(await directory(), "profile")
  await mkdir(path, { mode: 0o700 })
  return path
}

async function load(root: string, options: { profileDirectory?: string, daemonProtocolVersion?: string, fileSystem?: WebAppBundleFileSystem } = {}) {
  return await loadWebAppBundle({
    root,
    profileDirectory: options.profileDirectory ?? await profile(),
    ...(options.daemonProtocolVersion === undefined ? {} : { daemonProtocolVersion: options.daemonProtocolVersion }),
    ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
  })
}

function refusal(result: Awaited<ReturnType<typeof load>>) {
  if (result.state === "loaded") return { state: result.state }
  return { state: result.state, reason: result.reason, ...(result.path === undefined ? {} : { path: result.path }) }
}

describe("a valid bundle", () => {
  it("loads every listed file into memory, keyed by URL path", async () => {
    const root = await bundle()
    await writeFile(join(root, "unlisted.js"), "secret()", { mode: 0o644 })
    const result = await load(root)
    if (result.state !== "loaded") throw new Error(`expected loaded, got ${JSON.stringify(result)}`)

    expect(result.root).toBe(await realpath(root))
    expect(result.version).toBe("0.0.1")
    expect(result.protocolVersion).toBe(protocolVersion)
    expect([...result.files.keys()].sort()).toEqual([
      "/assets/index-abc123.css",
      "/assets/index-abc123.js",
      "/index.html",
      "/manifest.webmanifest",
      "/sw.js",
    ])
    const index = result.files.get("/index.html")!
    expect(index.bytes.toString("utf8")).toBe(defaultFiles["index.html"])
    expect(index.contentType).toBe("text/html; charset=utf-8")
    expect(index.sha256).toBe(sha256(defaultFiles["index.html"]!))
    expect(index.etag).toBe(`"${sha256(defaultFiles["index.html"]!)}"`)
    expect(index.cacheClass).toBe("entry")
    expect(result.files.get("/sw.js")!.cacheClass).toBe("entry")
    expect(result.files.get("/manifest.webmanifest")!.contentType).toBe("application/manifest+json")
    const script = result.files.get("/assets/index-abc123.js")!
    expect(script.cacheClass).toBe("hashed")
    expect(script.contentType).toBe("text/javascript; charset=utf-8")
    expect(result.files.has("/domovoi-web.json")).toBe(false)
    expect(result.files.has("/unlisted.js")).toBe(false)
    expect(Object.isFrozen(index)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it("serves what was read, not what the disk holds later", async () => {
    const root = await bundle()
    const result = await load(root)
    await writeFile(join(root, "index.html"), "changed")
    if (result.state !== "loaded") throw new Error("expected loaded")
    expect(result.files.get("/index.html")!.bytes.toString("utf8")).toBe(defaultFiles["index.html"])
  })

  it("loads a bundle whose protocol differs only in patch", async () => {
    const [major, minor] = protocolVersion.split(".")
    const root = await bundle(defaultFiles, { protocolVersion: `${major}.${minor}.99` })
    expect((await load(root)).state).toBe("loaded")
  })

  it.skipIf(!posix)("follows a root that is itself a symbolic link, once", async () => {
    const root = await bundle()
    const link = join(await directory(), "current")
    await symlink(root, link)
    const result = await load(link)
    expect(result.state).toBe("loaded")
    expect(result.root).toBe(await realpath(root))
  })
})

describe("absence", () => {
  it("is absent when the directory does not exist", async () => {
    const root = join(await directory(), "missing")
    expect(refusal(await load(root))).toEqual({ state: "absent", reason: "root-missing" })
  })

  it("is absent when the directory holds no manifest", async () => {
    const root = await bundle()
    await rm(join(root, "domovoi-web.json"))
    expect(refusal(await load(root))).toEqual({ state: "absent", reason: "manifest-missing" })
  })
})

describe("refusals", () => {
  it("refuses a root that is not a directory", async () => {
    const root = join(await directory(), "file")
    await writeFile(root, "x", { mode: 0o644 })
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "root-not-directory" })
  })

  it("refuses a manifest over its size bound without parsing it", async () => {
    const root = await bundle()
    await writeManifest(root, " ".repeat(maximumWebBundleManifestBytes + 1))
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "manifest-too-large", path: "domovoi-web.json" })
  })

  it("refuses a manifest that is not JSON", async () => {
    const root = await bundle()
    await writeManifest(root, "{format: 1")
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "manifest-not-json", path: "domovoi-web.json" })
  })

  it("refuses a manifest that is not UTF-8", async () => {
    const root = await bundle()
    await writeFile(join(root, "domovoi-web.json"), Buffer.from([0x7b, 0xff, 0x7d]))
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "manifest-not-json", path: "domovoi-web.json" })
  })

  it("refuses a manifest that fails the schema", async () => {
    const root = await bundle()
    await writeManifest(root, { format: 2, version: "0.0.1", protocolVersion, files: {} })
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "manifest-schema" })
  })

  it("reports the incompatible protocol with both versions", async () => {
    const [major, minor] = protocolVersion.split(".")
    const other = `${major}.${Number(minor) + 1}.0`
    const root = await bundle(defaultFiles, { protocolVersion: other })
    const result = await load(root)
    expect(result).toMatchObject({ state: "incompatible", reason: "protocol-incompatible", bundleProtocolVersion: other, daemonProtocolVersion: protocolVersion })
    expect((await load(root, { daemonProtocolVersion: other })).state).toBe("loaded")
  })

  it.each([
    ["path-malformed", "../outside.js"],
    ["path-malformed", "assets//a.js"],
    ["path-malformed", "assets\\a.js"],
    ["path-reserved", "artifacts/a.html"],
    ["path-reserved", "rpc/a.js"],
    ["path-reserved", "healthz"],
    ["path-reserved", "domovoi-web.json"],
    ["path-extension", "notes.txt"],
  ])("refuses %s for %s, before reading any file", async (reason, path) => {
    const root = await bundle()
    await writeManifest(root, {
      format: 1, version: "0.0.1", protocolVersion,
      files: { "index.html": { sha256: sha256(defaultFiles["index.html"]!), bytes: Buffer.byteLength(defaultFiles["index.html"]!) }, [path]: { sha256: sha256("x"), bytes: 1 } },
    })
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason, path })
  })

  it("refuses a manifest with no index.html", async () => {
    const root = await bundle({ "sw.js": "x" })
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "missing-index" })
  })

  it("refuses a manifest past the file size bound", async () => {
    const root = await bundle(defaultFiles, { files: { "index.html": { sha256: sha256("x"), bytes: maximumWebBundleFileBytes + 1 } } })
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "file-too-large", path: "index.html" })
  })

  it("refuses a listed file that is missing", async () => {
    const root = await bundle()
    await rm(join(root, "assets", "index-abc123.js"))
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "file-missing", path: "assets/index-abc123.js" })
  })

  it("refuses a file whose size differs from the manifest", async () => {
    const root = await bundle()
    await writeFile(join(root, "sw.js"), `${defaultFiles["sw.js"]}\n`)
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "size-mismatch", path: "sw.js" })
  })

  it("refuses a file whose digest differs from the manifest", async () => {
    const root = await bundle()
    const content = defaultFiles["sw.js"]!
    await writeFile(join(root, "sw.js"), content.replace("install", "INSTALL"))
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "digest-mismatch", path: "sw.js" })
  })

  it("refuses a listed path that is a directory", async () => {
    const root = await bundle()
    await rm(join(root, "sw.js"))
    await mkdir(join(root, "sw.js"), { mode: 0o755 })
    expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "not-regular-file", path: "sw.js" })
  })

  it("refuses a listed path below a file", async () => {
    const root = await bundle()
    await rm(join(root, "assets"), { recursive: true })
    await writeFile(join(root, "assets"), "x", { mode: 0o644 })
    expect(refusal(await load(root))).toMatchObject({ state: "invalid", reason: "not-a-directory" })
  })

  it("refuses a root inside the profile directory", async () => {
    const home = await profile()
    const root = await bundle()
    const inside = join(home, "worktrees", "agent", "web")
    await mkdir(dirname(inside), { recursive: true, mode: 0o755 })
    await rename(root, inside)
    expect(refusal(await load(inside, { profileDirectory: home }))).toEqual({ state: "invalid", reason: "root-in-profile" })
  })

  it("refuses the profile directory itself as the root", async () => {
    const root = await bundle()
    expect(refusal(await load(root, { profileDirectory: root }))).toEqual({ state: "invalid", reason: "root-in-profile" })
  })

  it("refuses a root that holds the profile directory", async () => {
    const root = await bundle()
    const home = join(root, ".domovoi")
    await mkdir(home, { mode: 0o700 })
    expect(refusal(await load(root, { profileDirectory: home }))).toEqual({ state: "invalid", reason: "root-in-profile" })
  })

  it("compares the profile by its real path, even before it exists", async () => {
    const root = await bundle()
    // The profile does not exist yet. Its path is compared through the real
    // path of its nearest existing ancestor, so a temporary directory reached
    // through a link (/var on macOS) still matches the root's real path.
    expect(refusal(await load(root, { profileDirectory: join(root, "not-yet", "profile") })))
      .toEqual({ state: "invalid", reason: "root-in-profile" })
    expect((await load(root, { profileDirectory: join(dirname(root), "not-yet") })).state).toBe("loaded")
  })

  describe.skipIf(!posix)("on POSIX", () => {
    it("refuses the profile reached through a symbolic link", async () => {
      const home = await profile()
      const link = join(await directory(), "profile-link")
      await symlink(home, link)
      const root = await bundle()
      const inside = join(home, "web")
      await rename(root, inside)
      expect(refusal(await load(inside, { profileDirectory: link }))).toEqual({ state: "invalid", reason: "root-in-profile" })
    })

    it("refuses a leaf that is a symbolic link, even to a matching file", async () => {
      const root = await bundle()
      const outside = join(await directory(), "sw.js")
      await writeFile(outside, defaultFiles["sw.js"]!, { mode: 0o644 })
      await rm(join(root, "sw.js"))
      await symlink(outside, join(root, "sw.js"))
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "symbolic-link", path: "sw.js" })
    })

    it("refuses a symbolic link as an intermediate directory", async () => {
      const root = await bundle()
      const outside = join(await directory(), "assets")
      await rename(join(root, "assets"), outside)
      await symlink(outside, join(root, "assets"))
      expect(refusal(await load(root))).toMatchObject({ state: "invalid", reason: "symbolic-link" })
    })

    it("refuses a manifest that is a symbolic link", async () => {
      const root = await bundle()
      const outside = join(await directory(), "domovoi-web.json")
      await rename(join(root, "domovoi-web.json"), outside)
      await symlink(outside, join(root, "domovoi-web.json"))
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "symbolic-link", path: "domovoi-web.json" })
    })

    it("refuses a FIFO as a leaf without blocking on it", async () => {
      const root = await bundle()
      await rm(join(root, "sw.js"))
      execFileSync("mkfifo", [join(root, "sw.js")])
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "not-regular-file", path: "sw.js" })
    })

    it("refuses a root writable by group or others", async () => {
      const root = await bundle()
      await chmod(root, 0o775)
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "root-writable" })
      await chmod(root, 0o757)
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "root-writable" })
    })

    it("refuses a listed file writable by group or others", async () => {
      const root = await bundle()
      await chmod(join(root, "index.html"), 0o664)
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "file-writable", path: "index.html" })
      await chmod(join(root, "index.html"), 0o646)
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "file-writable", path: "index.html" })
    })

    it("refuses a writable manifest", async () => {
      const root = await bundle()
      await chmod(join(root, "domovoi-web.json"), 0o666)
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "file-writable", path: "domovoi-web.json" })
    })

    it("refuses a writable directory between the root and a file", async () => {
      const root = await bundle()
      await chmod(join(root, "assets"), 0o777)
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "directory-writable", path: "assets" })
    })

    it.skipIf(process.getuid?.() === 0)("refuses a listed file it cannot read", async () => {
      const root = await bundle()
      await chmod(join(root, "sw.js"), 0o000)
      expect(refusal(await load(root))).toEqual({ state: "invalid", reason: "file-unreadable", path: "sw.js" })
    })

    it("refuses a symbolic link swapped in after the check, rather than following it", async () => {
      const root = await bundle()
      const target = join(await realpath(root), "assets", "index-abc123.js")
      const outside = join(await directory(), "same.js")
      await writeFile(outside, defaultFiles["assets/index-abc123.js"]!, { mode: 0o644 })
      let swapped = false
      const fileSystem: WebAppBundleFileSystem = {
        lstat, realpath,
        open: async (path, flags) => {
          if (path === target && !swapped) {
            swapped = true
            await rm(target)
            await symlink(outside, target)
          }
          return await open(path, flags)
        },
      }
      expect(refusal(await load(root, { fileSystem }))).toEqual({ state: "invalid", reason: "symbolic-link", path: "assets/index-abc123.js" })
      expect(swapped).toBe(true)
    })

    it("refuses a FIFO swapped in after the check, without blocking on it", async () => {
      const root = await bundle()
      const target = join(await realpath(root), "sw.js")
      const fileSystem: WebAppBundleFileSystem = {
        lstat, realpath,
        open: async (path, flags) => {
          if (path === target) {
            await rm(target)
            execFileSync("mkfifo", [target])
          }
          return await open(path, flags)
        },
      }
      expect(refusal(await load(root, { fileSystem }))).toEqual({ state: "invalid", reason: "file-changed", path: "sw.js" })
    })

    it("refuses an intermediate directory swapped for a link after the file opened", async () => {
      const root = await bundle()
      const target = join(await realpath(root), "assets", "index-abc123.js")
      const outside = join(await directory(), "assets")
      let opened = false
      const fileSystem: WebAppBundleFileSystem = {
        lstat, realpath,
        open: async (path, flags) => {
          const handle = await open(path, flags)
          if (path === target && !opened) {
            opened = true
            await rename(join(root, "assets"), outside)
            await symlink(outside, join(root, "assets"))
          }
          return handle
        },
      }
      expect(refusal(await load(root, { fileSystem }))).toMatchObject({ state: "invalid", reason: "symbolic-link" })
    })

    it("opens leaves without following links", async () => {
      const root = await bundle()
      const flags: number[] = []
      const fileSystem: WebAppBundleFileSystem = {
        lstat, realpath,
        open: async (path, flag) => {
          flags.push(flag)
          return await open(path, flag)
        },
      }
      expect((await load(root, { fileSystem })).state).toBe("loaded")
      expect(flags.length).toBeGreaterThan(0)
      for (const flag of flags) {
        expect(flag & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
        expect(flag & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
      }
    })
  })
})
