import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
})
