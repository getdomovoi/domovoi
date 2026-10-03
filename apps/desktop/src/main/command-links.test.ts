import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { commandLinks, type CommandLinkEnvironment } from "./command-links.js"

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
    expect(await commandLinks("status", environment())).toEqual({ report: { available: false } })
    expect(await commandLinks("link", environment())).toEqual({ report: { available: false } })
    await writeFile(launcher, "#!/bin/sh\n", { mode: 0o755 })
    expect(await commandLinks("link", environment({ platform: "win32" }))).toEqual({ report: { available: false } })
    await expect(lstat(bin())).rejects.toThrow()
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

  it("writes nothing when ~/.local or ~/.local/bin is a link to another directory", async () => {
    const elsewhere = join(root, "dotfiles", "bin")
    await mkdir(elsewhere, { recursive: true })
    await mkdir(join(home, ".local"))
    await symlink(elsewhere, bin())
    const refused = await commandLinks("link", environment())
    expect(refused.refused).toBe("~/.local/bin is a link to another directory, so Domovoi wrote nothing there.")
    await expect(lstat(join(elsewhere, "domovoid"))).rejects.toThrow()

    await rm(join(home, ".local"), { recursive: true })
    await symlink(join(root, "dotfiles"), join(home, ".local"))
    expect((await commandLinks("link", environment())).refused).toBe("~/.local is a link to another directory, so Domovoi wrote nothing there.")
    await expect(lstat(join(root, "dotfiles", "bin", "domovoid"))).rejects.toThrow()
  })

  it("refuses an action it does not know", async () => {
    await expect(commandLinks("remove-everything", environment())).rejects.toThrow("Command link request is invalid")
  })
})
