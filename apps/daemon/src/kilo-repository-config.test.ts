import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { kiloRepositoryConfigNotice } from "./kilo-repository-config.js"

const roots: string[] = []

async function worktree(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "domovoi-kilo-config-"))
  roots.push(root)
  for (const file of files) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), "{}")
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("kiloRepositoryConfigNotice", () => {
  it("names each Kilo file that runs repository programs without a card", async () => {
    const root = await worktree([".kilo/mcp.json", ".kilocodemodes"])
    const notice = await kiloRepositoryConfigNotice("kilo", root)
    expect(notice?.body).toBe("Kilo will run programs this repository lists, with no approval card.")
    expect(notice?.detail).toMatch(/^This worktree has \.kilo\/mcp\.json, \.kilocodemodes\. /)
  })

  it("says nothing when the worktree has none of the files", async () => {
    expect(await kiloRepositoryConfigNotice("kilo", await worktree([]))).toBeUndefined()
  })

  it("says nothing for other providers", async () => {
    const root = await worktree([".kilocode/mcp.json"])
    expect(await kiloRepositoryConfigNotice("opencode", root)).toBeUndefined()
  })
})
