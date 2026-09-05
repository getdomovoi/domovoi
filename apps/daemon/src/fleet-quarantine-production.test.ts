import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { fleetEntrySchema, fleetSnapshotSchema, maximumFleetEntries } from "@getdomovoi/protocol"
import { afterEach, expect, it } from "vitest"
import { z } from "zod"

import { fleetProductionHarness } from "./test-fleet-production.js"

const { cleanup, machine, enroll } = fleetProductionHarness()
afterEach(cleanup)

// The previous wire shape was strict. An optional field in the new parser is
// not permission to send it to an old caller or through an old notification.
const legacySnapshot = z.object({ entries: z.array(fleetEntrySchema).max(maximumFleetEntries) }).strict()

it("keeps legacy fleet calls working and offers quarantine remedies only on explicit inspection", async () => {
  const source = await machine("source")
  const damaged = await machine("damaged")
  await enroll(source, damaged)
  await damaged.handle.stop()
  const database = new DatabaseSync(join(source.homeDirectory, ".domovoi", "state.sqlite"))
  try { database.prepare("UPDATE fleet_machines SET capabilities = '{damaged-secret' WHERE id = ?").run(damaged.id) }
  finally { database.close() }

  const legacy = legacySnapshot.parse(await source.root.ok("fleet.list", {}))
  expect(legacy.entries.map((entry) => entry.kind === "machine" ? entry.machine.id : entry.machineId)).toEqual([source.id])
  const inspected = fleetSnapshotSchema.parse(await source.root.ok("fleet.list", { includeQuarantined: true }))
  expect(inspected.registry).toMatchObject({ state: "degraded", quarantined: [{
    kind: "quarantined", machineId: damaged.id, reason: "invalid-json", recoveryAction: "forget-and-enroll",
  }] })
  expect(JSON.stringify(inspected)).not.toContain("damaged-secret")
  const ordinary = legacySnapshot.parse(await source.root.ok("fleet.list", { includeQuarantined: false }))
  expect(ordinary.entries).toMatchObject([{ kind: "machine", machine: { id: source.id } }])
  expect(ordinary.entries).toHaveLength(legacy.entries.length)

  // A real successful enrollment broadcasts while the damaged row remains.
  // Both its reply and all fleet.changed messages must still parse on an old
  // client, even after this connection opted into an inspection response.
  const healthy = await machine("healthy")
  source.root.notifications.length = 0
  const admitted = await enroll(source, healthy)
  if (admitted.outcome !== "enrolled") throw new Error("Expected enrollment")
  legacySnapshot.parse(admitted.fleet)
  await source.root.ok("workspace.get", {})
  const notices = source.root.notifications.filter((notice) => notice.method === "fleet.changed")
  expect(notices.length).toBeGreaterThan(0)
  for (const notice of notices) legacySnapshot.parse(notice.params)
  expect(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", { includeQuarantined: true })).registry?.quarantined).toHaveLength(1)

  // The old machine identity is sufficient for the existing forget workflow.
  // No usable route remains, so never claim remote revocation was confirmed.
  const forgotten = await source.root.ok("fleet.forget", { machineId: damaged.id, client: "cli" })
  expect(forgotten).toMatchObject({ outcome: "forgotten", remoteRevocation: "unconfirmed" })
  expect(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", { includeQuarantined: true })).registry).toBeUndefined()
  expect(source.credentials.forMachine(damaged.id)).toBeUndefined()
}, 15_000)
