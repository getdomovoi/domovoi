import { mkdtemp, writeFile } from "node:fs/promises"
import { removeScratchDirectories } from "./test-scratch.js"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { readBoundedArtifactContent } from "./artifact-content.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

describe("readBoundedArtifactContent", () => {
  it("reads through the byte limit and rejects content that grows beyond it", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-preview-budget-"))
    scratchDirectories.push(root)
    const path = join(root, "preview.html")
    await writeFile(path, "1234567890abcdef")
    await expect(readBoundedArtifactContent(path, 16)).resolves.toBe("1234567890abcdef")

    await writeFile(path, "1234567890abcdefg")
    await expect(readBoundedArtifactContent(path, 16)).rejects.toThrow("Preview exceeds 16 bytes")
  })
})
