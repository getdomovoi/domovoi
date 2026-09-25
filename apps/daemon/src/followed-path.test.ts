import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, link, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { pathStaysInside } from "./execution-resolution.js"
import { fileTargetChanged, fileTargetHasOtherNames, fileTargetIdentity, followPath } from "./followed-path.js"

// Runs once, just before the next realpath call, so a test can change the
// filesystem between the walk and the spelling that follows it.
const beforeRealpath = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined }))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const run = beforeRealpath.run
      beforeRealpath.run = undefined
      if (run) await run()
      return actual.realpath(...args)
    },
  }
})

const scratch: string[] = []

afterEach(async () => {
  beforeRealpath.run = undefined
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

// Takes the current user's access to a directory away, and gives it back. On
// POSIX chmod does it. On Windows chmod only sets the read-only attribute and
// removes no access, so a deny entry for the user is added with icacls instead,
// inherited by what the directory holds so that a file in it cannot be read
// either (ruled 2026-09-24).
function windowsUser(): string {
  return process.env.USERNAME ?? userInfo().username
}

async function lockDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    execFileSync("icacls", [path, "/deny", `${windowsUser()}:(OI)(CI)(RX)`], { stdio: "ignore" })
  } else {
    await chmod(path, 0o000)
  }
}

async function unlockDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    execFileSync("icacls", [path, "/remove:d", windowsUser()], { stdio: "ignore" })
  } else {
    await chmod(path, 0o700)
  }
}

describe("followPath", () => {
  // Native realpath, which canonicalCwd uses for the worktree, writes a path
  // the way the filesystem stores it: a Windows 8.3 short name such as
  // RUNNER~1 in its long form, and a name on a case-insensitive filesystem in
  // its stored case. A followed path must be written the same way, or a file
  // in the worktree reads as outside it.
  it("writes the path the way native realpath writes it, missing tail included", async () => {
    const name = `domovoi-spelling-absent-${randomUUID()}`
    expect(await followPath(join(tmpdir(), name))).toBe(join(await realpath(tmpdir()), name))
    expect(await followPath(join(tmpdir(), name, "file.json"))).toBe(join(await realpath(tmpdir()), name, "file.json"))

    const workspace = await directory("domovoi-spelling-")
    const real = await realpath(workspace)
    await mkdir(join(workspace, "Mixed"))
    await writeFile(join(workspace, "Mixed", "Case.json"), "{}")
    expect(await followPath(join(workspace, "Mixed", "Case.json"))).toBe(join(real, "Mixed", "Case.json"))
    const caseInsensitive = await lstat(join(workspace, "mIXED")).then(() => true, () => false)
    if (caseInsensitive) {
      expect(await followPath(join(workspace, "mIXED", "cASE.json"))).toBe(join(real, "Mixed", "Case.json"))
      expect(await followPath(join(workspace, "mIXED", "absent", "file.json"))).toBe(join(real, "Mixed", "absent", "file.json"))
    }
  })

  // realpath follows links, so a directory swapped for a link after the walk
  // is followed. The path then leads where the link leads: out of the
  // worktree here, which leaves the request unresolved, and to a different
  // real path than an earlier reading, which refuses an Allow.
  it("fails closed when a link replaces a directory between the walk and the spelling", async () => {
    const workspace = await directory("domovoi-spelling-swap-")
    const outside = await directory("domovoi-spelling-swap-outside-")
    const root = await realpath(workspace)
    await mkdir(join(workspace, "dir"))
    await writeFile(join(workspace, "dir", "file.json"), "{}")
    await writeFile(join(outside, "file.json"), "{}")
    const swap = async () => {
      await rename(join(workspace, "dir"), join(workspace, "moved"))
      await symlink(outside, join(workspace, "dir"), "junction")
    }
    const restore = async () => {
      await rm(join(workspace, "dir"))
      await rename(join(workspace, "moved"), join(workspace, "dir"))
    }

    const before = await fileTargetIdentity(workspace, "dir/file.json", workspace)
    expect(before.realPath).toBe(join(root, "dir", "file.json"))
    beforeRealpath.run = swap
    const during = await fileTargetIdentity(workspace, "dir/file.json", workspace)
    expect(beforeRealpath.run).toBeUndefined()
    expect(during.realPath).toBe(join(await realpath(outside), "file.json"))
    expect(fileTargetChanged(before, during)).toBe(true)
    await restore()

    expect(await pathStaysInside(root, root, "dir/file.json")).toBe(true)
    beforeRealpath.run = swap
    expect(await pathStaysInside(root, root, "dir/file.json")).toBe(false)
    expect(beforeRealpath.run).toBeUndefined()
  })
})

describe("fileTargetHasOtherNames", () => {
  // Ruled 2026-09-24: a file with another name is never released, since a move
  // of that name leaves every field of the reading as it was.
  it("marks a file with another name, wherever that name moves, and nothing else", async () => {
    const workspace = await directory("domovoi-identity-names-")
    const outside = await directory("domovoi-identity-names-outside-")
    await writeFile(join(workspace, "single.json"), "{}")
    await writeFile(join(workspace, "twin.json"), "{}")
    await link(join(workspace, "twin.json"), join(workspace, "other.json"))
    await mkdir(join(workspace, "folder"))
    // A directory junction, which Windows makes without admin rights.
    await symlink(workspace, join(workspace, "through"), "junction")

    expect(fileTargetHasOtherNames(await fileTargetIdentity(workspace, "single.json", workspace))).toBe(false)
    expect(fileTargetHasOtherNames(await fileTargetIdentity(workspace, "absent.json", workspace))).toBe(false)
    expect(fileTargetHasOtherNames(await fileTargetIdentity(workspace, "folder", workspace))).toBe(false)
    const before = await fileTargetIdentity(workspace, "twin.json", workspace)
    expect(fileTargetHasOtherNames(before)).toBe(true)
    // Through a link, the file it leads to is the one counted.
    expect(fileTargetHasOtherNames(await fileTargetIdentity(workspace, join("through", "twin.json"), workspace))).toBe(true)
    expect(fileTargetHasOtherNames(await fileTargetIdentity(workspace, join("through", "single.json"), workspace))).toBe(false)

    await rename(join(workspace, "other.json"), join(outside, "other.json"))
    const after = await fileTargetIdentity(workspace, "twin.json", workspace)
    expect(fileTargetChanged(before, after)).toBe(false)
    expect(fileTargetHasOtherNames(after)).toBe(true)
  })
})

describe("fileTargetChanged", () => {
  it("keeps an unchanged file and a path that stays empty, and counts a new entry as a change", async () => {
    const workspace = await directory("domovoi-identity-same-")
    await writeFile(join(workspace, "kept.json"), "{}")
    const kept = await fileTargetIdentity(workspace, "kept.json", workspace)
    expect(kept.target.kind).toBe("regular")
    expect(fileTargetChanged(kept, await fileTargetIdentity(workspace, "kept.json", workspace))).toBe(false)

    const empty = await fileTargetIdentity(workspace, join(workspace, "absent", "file"))
    expect(empty.entry.kind).toBe("missing")
    expect(fileTargetChanged(empty, await fileTargetIdentity(workspace, join(workspace, "absent", "file")))).toBe(false)
    await mkdir(join(workspace, "absent"))
    await writeFile(join(workspace, "absent", "file"), "{}")
    expect(fileTargetChanged(empty, await fileTargetIdentity(workspace, join(workspace, "absent", "file")))).toBe(true)
  })

  // A card with no reading kept, such as one saved before a restart.
  it("stands on a regular file or an empty path when no earlier reading was kept", async () => {
    const workspace = await directory("domovoi-identity-unkept-")
    await writeFile(join(workspace, "file.json"), "{}")
    await mkdir(join(workspace, "folder"))
    expect(fileTargetChanged(undefined, await fileTargetIdentity(workspace, "file.json", workspace))).toBe(false)
    expect(fileTargetChanged(undefined, await fileTargetIdentity(workspace, "absent.json", workspace))).toBe(false)
    expect(fileTargetChanged(undefined, await fileTargetIdentity(workspace, "folder", workspace))).toBe(true)
  })

  // Two unreadable readings match field for field, whatever was replaced
  // beneath them.
  it("counts a target that cannot be read as changed, even against a matching reading", async () => {
    const workspace = await directory("domovoi-identity-unreadable-")
    const locked = join(workspace, "locked")
    await mkdir(join(locked, "inner"), { recursive: true })
    await writeFile(join(locked, "file.json"), "{}")
    await writeFile(join(workspace, "outside.json"), "{}")
    await lockDirectory(locked)
    try {
      const beneath = await fileTargetIdentity(workspace, "locked/file.json", workspace)
      expect(beneath).toMatchObject({ entry: { kind: "unreadable" }, realPath: undefined, target: { kind: "unreadable" } })
      expect(fileTargetChanged(beneath, await fileTargetIdentity(workspace, "locked/file.json", workspace))).toBe(true)
      expect(fileTargetChanged(undefined, beneath)).toBe(true)

      // The walk passes through the locked directory and leaves it again: what
      // "inner" is cannot be read, so where the path leads is not known.
      const through = await fileTargetIdentity(workspace, "locked/inner/../../outside.json", workspace)
      expect(through.realPath).toBeUndefined()
      expect(fileTargetChanged(through, await fileTargetIdentity(workspace, "locked/inner/../../outside.json", workspace))).toBe(true)
    } finally {
      await unlockDirectory(locked)
    }
  })
})
