import { execFileSync } from "node:child_process"
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fileTargetChanged, fileTargetHasOtherNames, fileTargetIdentity } from "./followed-path.js"

const scratch: string[] = []

afterEach(async () => {
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
