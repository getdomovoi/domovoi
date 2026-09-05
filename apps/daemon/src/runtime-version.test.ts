import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { SqliteWorkspaceStore } from "./store.js"
import { fleetProductionHarness, remote } from "./test-fleet-production.js"

vi.mock("@getdomovoi/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("@getdomovoi/protocol")>(),
  buildVersion: "9.8.7-test",
}))

const harness = fleetProductionHarness()
afterEach(harness.cleanup)

it("advertises this build in production workspace and fleet facts", async () => {
  const daemon = await harness.machine("current build")
  const workspace = await daemon.root.ok("workspace.get", {})
  expect(workspace.machine.version).toBe("9.8.7-test")
  expect(remote(await daemon.root.ok("fleet.list", {}), daemon.id).version).toBe("9.8.7-test")
})

it("refreshes persisted local build identity on restart without changing machine identity", async () => {
  const daemon = await harness.machine("upgraded build")
  const workspace = await daemon.root.ok("workspace.get", {})
  await daemon.handle.stop()
  const databasePath = join(daemon.homeDirectory, ".domovoi", "state.sqlite")
  const store = new SqliteWorkspaceStore(databasePath, workspace)
  const previous = store.load()
  previous.machine.version = "0.0.0-old"
  store.save(previous)
  await store.close()

  const restarted = await daemon.start()
  const current = await restarted.root.ok("workspace.get", {})
  expect(current.machine).toMatchObject({ id: daemon.id, version: "9.8.7-test" })
  expect(remote(await restarted.root.ok("fleet.list", {}), daemon.id).version).toBe("9.8.7-test")
  await restarted.handle.stop()
  const saved = new SqliteWorkspaceStore(databasePath, workspace)
  try { expect(saved.load().machine.version).toBe("9.8.7-test") } finally { await saved.close() }
})
