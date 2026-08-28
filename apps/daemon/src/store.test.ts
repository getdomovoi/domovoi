import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
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
    const first = new SqliteWorkspaceStore(databasePath, demoWorkspace, {
      manageDirectoryPermissions: true,
    })
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
    const legacySnapshot = structuredClone(demoWorkspace)
    legacySnapshot.annotations = []
    const legacy = new SqliteWorkspaceStore(databasePath, legacySnapshot)
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

  it.skipIf(process.platform === "win32")("repairs private state and sidecar permissions", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    const stateDirectory = join(scratch, "state")
    const databasePath = join(stateDirectory, "state.sqlite")
    await mkdir(stateDirectory, { mode: 0o777 })

    const first = new SqliteWorkspaceStore(databasePath, demoWorkspace)
    first.close()
    await chmod(stateDirectory, 0o777)
    await chmod(databasePath, 0o666)

    const reopened = new SqliteWorkspaceStore(databasePath, demoWorkspace, {
      manageDirectoryPermissions: true,
    })
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600)

    const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`]
    for (const sidecar of sidecars) {
      await chmod(sidecar, 0o666)
    }
    reopened.save(demoWorkspace)
    for (const sidecar of sidecars) {
      expect((await stat(sidecar)).mode & 0o777).toBe(0o600)
    }
    reopened.close()
  })

  it.skipIf(process.platform === "win32")("does not chmod a caller-owned custom directory", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-store-"))
    scratchDirectories.push(scratch)
    await chmod(scratch, 0o777)

    const store = new SqliteWorkspaceStore(join(scratch, "state.sqlite"), demoWorkspace)

    expect((await stat(scratch)).mode & 0o777).toBe(0o777)
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    store.close()
  })
})
