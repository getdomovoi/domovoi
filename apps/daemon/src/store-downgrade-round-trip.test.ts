import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"

// 0.9 writes state, an older build (0.8) opens it and refuses, and 0.9 opens
// it again and finds the sessions it wrote. The older build is this store
// loaded against a protocol that says 0.8.0, so it exercises the refusal an
// 0.8 daemon carries; it cannot exercise 0.8's older schema.

const scratchDirectories: string[] = []
afterEach(async () => {
  vi.doUnmock("@getdomovoi/protocol")
  vi.resetModules()
  await removeScratchDirectories(scratchDirectories)
})

async function storeSpeaking(version: string | undefined) {
  vi.resetModules()
  if (version === undefined) {
    vi.doUnmock("@getdomovoi/protocol")
  } else {
    vi.doMock("@getdomovoi/protocol", async (importOriginal) => ({
      ...await importOriginal<typeof import("@getdomovoi/protocol")>(),
      protocolVersion: version,
    }))
  }
  return await import("./store.js")
}

describe("a downgrade and back", () => {
  it("keeps 0.9 state through a 0.8 daemon that refuses it", async () => {
    expect(protocolVersion).toBe("0.9.0")
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-downgrade-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")

    const current = await storeSpeaking(undefined)
    const written = structuredClone(demoWorkspace)
    written.sessions[0]!.title = "Written by 0.9"
    const first = new current.SqliteWorkspaceStore(databasePath, written)
    expect(first.load().sessions[0]!.title).toBe("Written by 0.9")
    await first.close()

    const older = await storeSpeaking("0.8.0")
    const before = await readFile(databasePath)
    expect(() => new older.SqliteWorkspaceStore(databasePath, demoWorkspace)).toThrow(older.NewerWorkspaceStateError)
    expect((await readFile(databasePath)).equals(before)).toBe(true)
    expect((await readdir(scratch)).filter((name) => name.includes("corrupt"))).toEqual([])

    const again = await storeSpeaking(undefined)
    const reopened = new again.SqliteWorkspaceStore(databasePath, demoWorkspace)
    try {
      expect(reopened.recovery).toBeUndefined()
      expect(reopened.load().sessions.map(({ title }) => title)).toEqual(written.sessions.map(({ title }) => title))
    } finally {
      await reopened.close()
    }
  })
})
