import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"
import * as store from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

// A newer daemon's state, opened by an older one, is left exactly as it is:
// not moved aside, not replaced by the seed. The older daemon says why and
// does not start, so running the newer daemon again finds its sessions.

const scratchDirectories: string[] = []
afterEach(async () => { await removeScratchDirectories(scratchDirectories) })

function ahead(version: string): string {
  const [major, minor] = version.split(".").map(Number)
  return `${major}.${minor! + 1}.0`
}

async function newerState() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-newer-state-"))
  scratchDirectories.push(scratch)
  const databasePath = join(scratch, "state.sqlite")
  const seeded = new store.SqliteWorkspaceStore(databasePath, demoWorkspace)
  await seeded.close()
  const newer = structuredClone(demoWorkspace) as unknown as Record<string, unknown>
  newer.protocolVersion = ahead(protocolVersion)
  ;(newer.sessions as Array<{ title: string }>)[0]!.title = "Written by a newer daemon"
  const written = JSON.stringify(newer)
  const database = new DatabaseSync(databasePath)
  database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run(written)
  database.close()
  return { scratch, databasePath, written }
}

async function unchanged(scratch: string, databasePath: string, written: string, bytes: Buffer) {
  const database = new DatabaseSync(databasePath)
  try {
    const row = database.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get() as { snapshot: string }
    expect(row.snapshot).toBe(written)
  } finally {
    database.close()
  }
  expect((await readdir(scratch)).filter((name) => name.includes("corrupt"))).toEqual([])
  expect((await readFile(databasePath)).equals(bytes)).toBe(true)
}

describe("state written by a newer daemon", () => {
  it("is refused by the store, with nothing on disk changed", async () => {
    const { scratch, databasePath, written } = await newerState()
    const bytes = await readFile(databasePath)
    let refusal: unknown
    try {
      new store.SqliteWorkspaceStore(databasePath, demoWorkspace)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(store.NewerWorkspaceStateError)
    expect(refusal).toMatchObject({ path: databasePath, storedProtocolVersion: ahead(protocolVersion), daemonProtocolVersion: protocolVersion })
    // The copy ruled 2026-09-23.
    const [major, minor] = ahead(protocolVersion).split(".")
    expect((refusal as Error).message).toBe(`Domovoi state at ${databasePath} was written by a newer daemon (protocol ${ahead(protocolVersion)}), and this daemon speaks protocol ${protocolVersion}. It was left as it is and this daemon did not start. Run the newer Domovoi again, or update this one to protocol ${major}.${minor} or later.`)
    await unchanged(scratch, databasePath, written, bytes)
  })

  it("stops the daemon before it starts, with nothing on disk changed", async () => {
    const { scratch, databasePath, written } = await newerState()
    const bytes = await readFile(databasePath)
    expect(() => new DomovoiDaemon({ port: 0, statePath: databasePath })).toThrow(store.NewerWorkspaceStateError)
    await unchanged(scratch, databasePath, written, bytes)
  })

  it("still opens state from this version and a patch ahead of it", async () => {
    const { databasePath } = await newerState()
    const database = new DatabaseSync(databasePath)
    const patch = structuredClone(demoWorkspace) as unknown as Record<string, unknown>
    patch.protocolVersion = protocolVersion.replace(/\d+$/, "9")
    ;(patch.sessions as Array<{ title: string }>)[0]!.title = "Written by a patch ahead"
    database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run(JSON.stringify(patch))
    database.close()
    const reopened = new store.SqliteWorkspaceStore(databasePath, demoWorkspace)
    try {
      expect(reopened.load().sessions[0]!.title).toBe("Written by a patch ahead")
    } finally {
      await reopened.close()
    }
  })
})
