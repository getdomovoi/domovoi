import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { commandLinks, type CommandLinkEnvironment } from "./command-links.js"

// A hook run right after one read, to change the file system between the
// module's read and its write, as another process could.
const race = vi.hoisted(() => ({ afterRead: undefined as ((call: "lstat" | "readlink", path: string) => Promise<void>) | undefined }))
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  const hooked = async <T>(call: "lstat" | "readlink", path: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await read()
    } finally {
      const hook = race.afterRead
      if (hook) await hook(call, path)
    }
  }
  return {
    ...actual,
    lstat: ((path: string) => hooked("lstat", path, () => actual.lstat(path))) as typeof actual.lstat,
    readlink: ((path: string) => hooked("readlink", path, () => actual.readlink(path))) as typeof actual.readlink,
  }
})
afterEach(() => { race.afterRead = undefined })

// Every test runs against a temporary home and a temporary resources
// directory. The real ~/.local/bin is never read or written.
let root: string
let home: string
let resources: string
let launcher: string

function environment(overrides: Partial<CommandLinkEnvironment> = {}): CommandLinkEnvironment {
  return { home, resourcesPath: resources, platform: "darwin", path: "/usr/bin:/bin", ...overrides }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "domovoi-command-links-"))
  home = join(root, "home")
  resources = join(root, "Domovoi.app", "Contents", "Resources")
  launcher = join(resources, "daemon-runtime", "bin", "domovoid")
  await mkdir(home)
  await mkdir(join(resources, "daemon-runtime", "bin"), { recursive: true })
  await writeFile(launcher, "#!/bin/sh\n", { mode: 0o755 })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const bin = () => join(home, ".local", "bin")

describe("command links", () => {
  it("reports the launcher this app ships and no link before one is made", async () => {
    expect(await commandLinks("status", environment())).toEqual({
      report: { available: true, directory: "~/.local/bin", onPath: false, commands: [{ name: "domovoid", launcher, state: "absent" }] },
    })
  })

  it("is unavailable where the app ships no launcher, and links nothing on Windows", async () => {
    await rm(launcher)
    const noLauncher = { available: false, reason: "This build ships no domovoid launcher, so there is nothing to link." }
    expect(await commandLinks("status", environment())).toEqual({ report: noLauncher })
    expect(await commandLinks("link", environment())).toEqual({ report: noLauncher })
    await writeFile(launcher, "#!/bin/sh\n", { mode: 0o755 })
    expect(await commandLinks("link", environment({ platform: "win32" }))).toEqual({ report: { available: false, reason: "Domovoi links no commands on Windows." } })
    await expect(lstat(bin())).rejects.toThrow()
  })

  it("makes nothing when it only reads or unlinks", async () => {
    expect((await commandLinks("status", environment())).report).toMatchObject({ commands: [{ state: "absent" }] })
    expect((await commandLinks("unlink", environment())).report).toMatchObject({ commands: [{ state: "absent" }] })
    await expect(lstat(join(home, ".local"))).rejects.toThrow()
  })

  it("links domovoid into ~/.local/bin, making the directory, and unlinks only that link", async () => {
    const linked = await commandLinks("link", environment())
    expect(linked).toEqual({ report: { available: true, directory: "~/.local/bin", onPath: false, commands: [{ name: "domovoid", launcher, state: "linked" }] } })
    expect(await readlink(join(bin(), "domovoid"))).toBe(launcher)
    await writeFile(join(bin(), "other-tool"), "keep me")
    expect(await commandLinks("unlink", environment())).toEqual({ report: { available: true, directory: "~/.local/bin", onPath: false, commands: [{ name: "domovoid", launcher, state: "absent" }] } })
    await expect(lstat(join(bin(), "domovoid"))).rejects.toThrow()
    expect(await readFile(join(bin(), "other-tool"), "utf8")).toBe("keep me")
  })

  it("says when ~/.local/bin is on this app's PATH", async () => {
    expect((await commandLinks("status", environment({ path: `/usr/bin:${bin()}/` }))).report).toMatchObject({ onPath: true })
    expect((await commandLinks("status", environment({ path: `${bin()}x:/usr/bin` }))).report).toMatchObject({ onPath: false })
  })

  it("never overwrites or removes a domovoid it did not link", async () => {
    await mkdir(bin(), { recursive: true })
    await writeFile(join(bin(), "domovoid"), "#!/bin/sh\necho mine\n")
    const refused = await commandLinks("link", environment())
    expect(refused.report).toMatchObject({ commands: [{ name: "domovoid", state: "other" }] })
    expect(refused.refused).toBe("~/.local/bin/domovoid is not a link Domovoi made, so it was left as it is.")
    expect(await readFile(join(bin(), "domovoid"), "utf8")).toBe("#!/bin/sh\necho mine\n")
    expect((await commandLinks("unlink", environment())).refused).toBe("~/.local/bin/domovoid is not a link Domovoi made, so it was left as it is.")
    expect(await readFile(join(bin(), "domovoid"), "utf8")).toBe("#!/bin/sh\necho mine\n")

    await rm(join(bin(), "domovoid"))
    await symlink("/opt/homebrew/bin/domovoid", join(bin(), "domovoid"))
    expect((await commandLinks("link", environment())).report).toMatchObject({ commands: [{ state: "other" }] })
    expect(await readlink(join(bin(), "domovoid"))).toBe("/opt/homebrew/bin/domovoid")
  })

  it("replaces its own link to a launcher the app no longer ships from", async () => {
    await mkdir(bin(), { recursive: true })
    const moved = join(root, "Old Place", "Domovoi.app", "Contents", "Resources", "daemon-runtime", "bin", "domovoid")
    await symlink(moved, join(bin(), "domovoid"))
    expect((await commandLinks("status", environment())).report).toMatchObject({ commands: [{ state: "stale" }] })
    expect((await commandLinks("link", environment())).report).toMatchObject({ commands: [{ state: "linked" }] })
    expect(await readlink(join(bin(), "domovoid"))).toBe(launcher)
  })

  // Review P3-1: a link to another Domovoi install that still exists is that
  // install's, not a stale one of ours.
  it("leaves a link to another live Domovoi install alone", async () => {
    await mkdir(bin(), { recursive: true })
    const other = join(root, "Other", "Domovoi.app", "Contents", "Resources", "daemon-runtime", "bin", "domovoid")
    await mkdir(join(other, ".."), { recursive: true })
    await writeFile(other, "#!/bin/sh\n", { mode: 0o755 })
    await symlink(other, join(bin(), "domovoid"))
    expect((await commandLinks("status", environment())).report).toMatchObject({ commands: [{ state: "other" }] })
    expect((await commandLinks("link", environment())).refused).toBe("~/.local/bin/domovoid is not a link Domovoi made, so it was left as it is.")
    expect((await commandLinks("unlink", environment())).refused).toBe("~/.local/bin/domovoid is not a link Domovoi made, so it was left as it is.")
    expect(await readlink(join(bin(), "domovoid"))).toBe(other)
  })

  // Review P3-2: what was read is read again right before the write, so a
  // change in between is never removed or written through.
  it("does not unlink a link that changed after it was read", async () => {
    await commandLinks("link", environment())
    const command = join(bin(), "domovoid")
    let swapped = false
    race.afterRead = async (call, path) => {
      if (swapped || call !== "readlink" || path !== command) return
      swapped = true
      race.afterRead = undefined
      await rm(command)
      await symlink("/opt/mine/domovoid", command)
    }
    const result = await commandLinks("unlink", environment())
    expect(result.refused).toBe("~/.local/bin/domovoid changed while Domovoi was reading it, so it was left as it is.")
    expect(await readlink(command)).toBe("/opt/mine/domovoid")
  })

  it("does not link through a ~/.local/bin that became a link after it was read", async () => {
    await mkdir(bin(), { recursive: true })
    const elsewhere = join(root, "dotfiles", "bin")
    await mkdir(elsewhere, { recursive: true })
    const command = join(bin(), "domovoid")
    race.afterRead = async (call, path) => {
      if (call !== "lstat" || path !== command) return
      race.afterRead = undefined
      await rm(bin(), { recursive: true })
      await symlink(elsewhere, bin())
    }
    const result = await commandLinks("link", environment())
    expect(result.refused).toBe("~/.local/bin is a link to another directory, so Domovoi does not read or write there.")
    await expect(lstat(join(elsewhere, "domovoid"))).rejects.toThrow()
  })

  // Review P3-3: a path whose parent is not a directory answers ENOTDIR; that
  // is the not-a-directory refusal, not a thrown error.
  it("refuses, rather than throws, when a parent is not a directory", async () => {
    await rm(home, { recursive: true })
    await writeFile(home, "a file where home should be")
    const reason = "~/.local is not a directory, so Domovoi does not read or write there."
    expect(await commandLinks("status", environment())).toEqual({ report: { available: false, reason } })
    expect((await commandLinks("link", environment())).refused).toBe(reason)
    await rm(home)
    await mkdir(home)
    race.afterRead = async (call, path) => {
      if (call !== "lstat" || path !== bin()) return
      race.afterRead = undefined
      await rm(join(home, ".local"), { recursive: true })
      await writeFile(join(home, ".local"), "now a file")
    }
    expect((await commandLinks("link", environment())).refused).toBe(reason)
    expect(await readFile(join(home, ".local"), "utf8")).toBe("now a file")
  })

  // Review P2-2: a ~/.local/bin that is a link (a stow-folded dotfiles
  // directory, say) is not read, written or cleaned through, for any action.
  it("reads, writes and removes nothing through a ~/.local or ~/.local/bin that is a link", async () => {
    const elsewhere = join(root, "dotfiles", "bin")
    await mkdir(elsewhere, { recursive: true })
    // The person's own link in their dotfiles, which happens to name this launcher.
    await symlink(launcher, join(elsewhere, "domovoid"))
    await mkdir(join(home, ".local"))
    await symlink(elsewhere, bin())
    const binLinked = "~/.local/bin is a link to another directory, so Domovoi does not read or write there."
    const unavailable = { report: { available: false, reason: binLinked } }
    expect(await commandLinks("status", environment())).toEqual(unavailable)
    expect(await commandLinks("unlink", environment())).toEqual({ ...unavailable, refused: binLinked })
    expect(await commandLinks("link", environment())).toEqual({ ...unavailable, refused: binLinked })
    expect(await readlink(join(elsewhere, "domovoid"))).toBe(launcher)

    await rm(join(home, ".local"), { recursive: true })
    await symlink(join(root, "dotfiles"), join(home, ".local"))
    const localLinked = "~/.local is a link to another directory, so Domovoi does not read or write there."
    expect(await commandLinks("status", environment())).toEqual({ report: { available: false, reason: localLinked } })
    expect((await commandLinks("unlink", environment())).refused).toBe(localLinked)
    expect((await commandLinks("link", environment())).refused).toBe(localLinked)
    expect(await readlink(join(elsewhere, "domovoid"))).toBe(launcher)
  })

  it("refuses a ~/.local/bin that is not a directory, for every action", async () => {
    await mkdir(join(home, ".local"))
    await writeFile(bin(), "not a directory")
    const reason = "~/.local/bin is not a directory, so Domovoi does not read or write there."
    expect(await commandLinks("status", environment())).toEqual({ report: { available: false, reason } })
    expect((await commandLinks("unlink", environment())).refused).toBe(reason)
    expect((await commandLinks("link", environment())).refused).toBe(reason)
    expect(await readFile(bin(), "utf8")).toBe("not a directory")
  })

  it("refuses an action it does not know", async () => {
    await expect(commandLinks("remove-everything", environment())).rejects.toThrow("Command link request is invalid")
  })
})
