import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { chooseDirectory, type DesktopPlatform } from "./desktop-platform.js"

// Walk finding F5: a project under /private/tmp reached the daemon as /System.
// The folder the dialog returns is resolved with the real file system and
// handed on as that folder's own path, through the macOS links /tmp and /var
// and through a link the person made. Nothing here rewrites a path, so a
// folder can only arrive as itself, and one that cannot be resolved is
// refused rather than replaced.
const fileSystem = { realpath, stat }
const platform = process.platform as DesktopPlatform
const picked = (path: string) => ({ showOpenDirectory: async () => ({ canceled: false, filePaths: [path] }) })

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "domovoi-picked-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("a folder picked through a link", () => {
  it("arrives as the folder it names", async () => {
    const project = join(root, "walk-repo")
    await mkdir(project)
    const link = join(root, "link-to-walk-repo")
    await symlink(project, link, "dir")

    const direct = await chooseDirectory(picked(project), fileSystem, platform)
    const linked = await chooseDirectory(picked(link), fileSystem, platform)

    expect(direct).toEqual({ status: "selected", path: await realpath(project) })
    expect(linked).toEqual(direct)
  })

  it("is refused when its link leads nowhere", async () => {
    const link = join(root, "dangling")
    await symlink(join(root, "gone"), link, "dir")

    await expect(chooseDirectory(picked(link), fileSystem, platform)).rejects.toThrow("Domovoi could not use the selected folder")
  })
})

describe.runIf(process.platform === "darwin")("a folder under the macOS /tmp and /var links", () => {
  it("arrives under /private whichever spelling the dialog returns", async () => {
    const name = `domovoi-picked-${basename(root)}`
    const underTmp = join("/tmp", name)
    await mkdir(underTmp)
    try {
      for (const spelling of [underTmp, join("/private/tmp", name)]) {
        await expect(chooseDirectory(picked(spelling), fileSystem, "darwin"))
          .resolves.toEqual({ status: "selected", path: join("/private/tmp", name) })
      }
    } finally {
      await rm(underTmp, { recursive: true, force: true })
    }
  })

  it("keeps a /var temporary folder as itself under /private/var", async () => {
    const project = join(root, "repo")
    await mkdir(project)
    const result = await chooseDirectory(picked(project), fileSystem, "darwin")
    expect(result).toEqual({ status: "selected", path: await realpath(project) })
    if (project.startsWith("/var/")) expect(result).toEqual({ status: "selected", path: `/private${project}` })
  })
})
