import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { demoWorkspace, workspaceSnapshotSchema } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await removeScratchDirectories(scratchDirectories)
})

async function storedWorkspace(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-load-once-"))
  scratchDirectories.push(scratch)
  const path = join(scratch, "state.sqlite")
  await new SqliteWorkspaceStore(path, demoWorkspace).close()
  return path
}

describe("reading stored state", () => {
  it("hands the snapshot the constructor migrated to the first load", async () => {
    const store = new SqliteWorkspaceStore(await storedWorkspace(), demoWorkspace)
    try {
      const parse = vi.spyOn(workspaceSnapshotSchema, "parse")
      const first = store.load()
      expect(parse).toHaveBeenCalledTimes(1)
      expect(first).toEqual(demoWorkspace)
      parse.mockClear()
      expect(store.load()).toEqual(first)
      expect(parse).toHaveBeenCalledTimes(2)
    } finally { await store.close() }
  })

  it("reads the stored row again once anything was written", async () => {
    const store = new SqliteWorkspaceStore(await storedWorkspace(), demoWorkspace)
    try {
      const renamed = structuredClone(demoWorkspace)
      renamed.sessions[0]!.title = "Renamed before the first load"
      store.save(renamed)
      expect(store.load().sessions[0]!.title).toBe("Renamed before the first load")
    } finally { await store.close() }
  })

  it("opens a project without reading the whole workspace for its machine", async () => {
    const store = new SqliteWorkspaceStore(await storedWorkspace(), demoWorkspace)
    try {
      const load = vi.spyOn(store, "load")
      const project = store.loadProject(demoWorkspace.project!.id, demoWorkspace.machine)
      expect(project?.project.id).toBe(demoWorkspace.project!.id)
      expect(project?.sessions).toEqual(demoWorkspace.sessions)
      expect(load).not.toHaveBeenCalled()
    } finally { await store.close() }
  })
})
