import { readFile } from "node:fs/promises"
import { arch, platform } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { buildVersion, fleetSnapshotSchema, workspaceSnapshotSchema } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { fleetProductionHarness, remote } from "./test-fleet-production.js"
import { waitForDaemon } from "./test-wait-for.js"

const runtime = vi.hoisted(() => ({ previous: false }))
// Substitute only the external OS and build facts for the first executable.
// The production factory creates and persists every workspace row itself.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return {
    ...actual,
    platform: () => runtime.previous ? "previous-platform" : actual.platform(),
    arch: () => runtime.previous ? "previous-architecture" : actual.arch(),
  }
})
vi.mock("@getdomovoi/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@getdomovoi/protocol")>()
  return { ...actual, get buildVersion() { return runtime.previous ? "0.0.0-previous" : actual.buildVersion } }
})

const { cleanup, machine, enroll } = fleetProductionHarness()
afterEach(async () => { runtime.previous = false; await cleanup() })

function persistedMachine(homeDirectory: string) {
  const database = new DatabaseSync(join(homeDirectory, ".domovoi", "state.sqlite"), { readOnly: true })
  try {
    const row = database.prepare("SELECT snapshot FROM workspace_state WHERE id = 1").get()
    return workspaceSnapshotSchema.parse(JSON.parse(String(row?.snapshot))).machine
  } finally { database.close() }
}

it("refreshes platform, architecture and version across a production profile restart and peer heartbeat", async () => {
  const source = await machine("source studio")
  runtime.previous = true
  const target = await machine("target studio")
  runtime.previous = false
  const previous = { platform: "previous-platform", arch: "previous-architecture", version: "0.0.0-previous" }
  const current = { platform: platform(), arch: arch(), version: buildVersion }
  expect(current.platform).not.toBe(previous.platform)
  expect(current.arch).not.toBe(previous.arch)
  expect(current.version).not.toBe(previous.version)
  await enroll(source, target)
  expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id)).toMatchObject(previous)
  const identityPath = join(target.homeDirectory, ".domovoi", "machine.json")
  const identity = await readFile(identityPath, "utf8")
  target.root.socket.close()
  await target.handle.stop()
  // Positive persistence witness from the real first boot, with no store seeding.
  expect(persistedMachine(target.homeDirectory)).toMatchObject({ id: target.id, ...previous })
  await waitForDaemon(async () => {
    expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id).health).toBe("reconnecting")
  })
  const restarted = await target.start({ port: target.address.port })
  expect(restarted.id).toBe(target.id)
  expect(await readFile(identityPath, "utf8")).toBe(identity)
  expect(workspaceSnapshotSchema.parse(await restarted.root.ok("workspace.get", {})).machine)
    .toMatchObject({ id: target.id, ...current })
  expect(remote(fleetSnapshotSchema.parse(await restarted.root.ok("fleet.list", {})), target.id))
    .toMatchObject({ id: target.id, ...current })
  await waitForDaemon(async () => {
    expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id))
      .toMatchObject({ id: target.id, health: "healthy", ...current })
  })
  restarted.root.socket.close()
  await restarted.handle.stop()
  expect(persistedMachine(target.homeDirectory)).toMatchObject({ id: target.id, ...current })
}, 30_000)
