import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"

const unlinked = vi.hoisted(() => [] as string[])

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    unlinkSync: vi.fn((path: Parameters<typeof actual.unlinkSync>[0]) => {
      unlinked.push(String(path))
      actual.unlinkSync(path)
    }),
  }
})

const { SqliteWorkspaceStore, storedProtocolVersion } = await import("./store.js")

const scratchDirectories: string[] = []
afterEach(async () => {
  await removeScratchDirectories(scratchDirectories)
})

it("reads the stored version without creating or removing a sidecar", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-version-probe-"))
  scratchDirectories.push(scratch)
  const path = join(scratch, "state.sqlite")
  await new SqliteWorkspaceStore(path, demoWorkspace).close()
  const before = (await readdir(scratch)).sort()
  expect(before).toEqual(["state.sqlite"])
  unlinked.length = 0

  expect(storedProtocolVersion(path)).toBe(demoWorkspace.protocolVersion)
  expect(unlinked).toEqual([])
  expect((await readdir(scratch)).sort()).toEqual(before)
})
