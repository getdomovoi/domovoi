import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fileTargetChanged, fileTargetIdentity } from "./followed-path.js"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

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
  // beneath them. On Windows chmod removes no access, so the case cannot be
  // made there with it.
  it.skipIf(process.platform === "win32")("counts a target that cannot be read as changed, even against a matching reading", async () => {
    const workspace = await directory("domovoi-identity-unreadable-")
    const locked = join(workspace, "locked")
    await mkdir(join(locked, "inner"), { recursive: true })
    await writeFile(join(locked, "file.json"), "{}")
    await writeFile(join(workspace, "outside.json"), "{}")
    await chmod(locked, 0o000)
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
      await chmod(locked, 0o700)
    }
  })
})
