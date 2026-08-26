import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEmptyWorkspace, demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { SqliteWorkspaceStore } from "./store.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("SqliteWorkspaceStore", () => {
  it("restores daemon-owned workspace state after reopening", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const first = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    const changed = structuredClone(demoWorkspace)
    changed.machine.name = "workstation"
    changed.sessions[0]!.runtime.model = "gpt-5.6-sol"
    changed.approvalRules.push({
      id: "rule-1",
      projectId: changed.project!.id,
      operation: "Run tests",
      command: "pnpm test",
      createdBy: "desktop",
      createdAt: "2026-08-26T06:00:00.000Z",
    })

    first.save(changed)
    first.close()

    const reopened = new SqliteWorkspaceStore(
      databasePath,
      createEmptyWorkspace(demoWorkspace.machine),
      { legacySnapshots: [demoWorkspace] },
    )
    expect(reopened.load()).toEqual(changed)
    reopened.close()
  })

  it("replaces only the untouched legacy demo seed", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const legacy = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    legacy.close()

    const empty = createEmptyWorkspace({
      ...demoWorkspace.machine,
      name: "workstation",
      platform: "linux",
      arch: "x64",
    })
    const upgraded = new SqliteWorkspaceStore(databasePath, empty, {
      legacySnapshots: [demoWorkspace],
    })

    expect(upgraded.load()).toEqual(empty)
    upgraded.close()
  })
})
