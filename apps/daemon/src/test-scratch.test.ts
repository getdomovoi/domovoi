import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { removeScratchDirectories, scratchRemovalRetries } from "./test-scratch.js"

describe("removeScratchDirectories", () => {
  it("removes every directory it is given", async () => {
    const first = await mkdtemp(join(tmpdir(), "domovoi-scratch-"))
    const second = await mkdtemp(join(tmpdir(), "domovoi-scratch-"))
    await writeFile(join(first, "held.txt"), "content")

    await removeScratchDirectories([first, second])

    await expect(stat(first)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(second)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("ignores a directory that is already gone", async () => {
    await expect(removeScratchDirectories([join(tmpdir(), "domovoi-scratch-missing")]))
      .resolves.toBeUndefined()
  })

  it("retries removal, because Windows holds handles briefly after a test", () => {
    expect(scratchRemovalRetries).toBeGreaterThan(0)
  })
})
