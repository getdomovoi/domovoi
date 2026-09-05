import { expect, it } from "vitest"

import { fleetSnapshotSchema, maximumFleetEntries } from "./fleet.js"
import { rpcMethods } from "./rpc.js"

const quarantined = {
  kind: "quarantined", id: "e179e148-c911-4a59-ae64-04c325ab5890",
  machineId: `machine-${"b".repeat(32)}`, reason: "invalid-json",
  detectedAt: "2026-09-05T12:00:00.000Z", recoveryAction: "forget-and-enroll",
}
const degraded = (entries: unknown[]) => ({ entries: [], registry: { state: "degraded", quarantined: entries } })

it("reports quarantined facts separately from never-enrolled credentials", () => {
  const snapshot = degraded([quarantined])
  expect(fleetSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  expect(fleetSnapshotSchema.parse({ entries: [] })).toEqual({ entries: [] })
})

it("requires an explicit fleet list opt-in without changing heartbeat params", () => {
  expect(rpcMethods["fleet.list"].params.parse({ includeQuarantined: true })).toEqual({ includeQuarantined: true })
  expect(rpcMethods["fleet.list"].params.parse({})).toEqual({})
  expect(rpcMethods["fleet.heartbeat"].params.safeParse({ includeQuarantined: true }).success).toBe(false)
})

it("requires offline repair rather than inventing a corrupt machine identity", () => {
  const entry = { ...quarantined }
  Reflect.deleteProperty(entry, "machineId")
  expect(fleetSnapshotSchema.safeParse(degraded([entry])).success).toBe(false)
  expect(fleetSnapshotSchema.parse(degraded([{ ...entry, recoveryAction: "repair-registry-offline" }])))
    .toEqual(degraded([{ ...entry, recoveryAction: "repair-registry-offline" }]))
  expect(fleetSnapshotSchema.safeParse(degraded([{ ...quarantined, machineId: "broken-id" }])).success).toBe(false)
})

it("refuses raw damaged values and unclassified failure text on the wire", () => {
  for (const extra of [{ payload: "secret" }, { message: "parse error: secret" }, { reason: "secret" }]) {
    expect(fleetSnapshotSchema.safeParse(degraded([{ ...quarantined, ...extra }])).success).toBe(false)
  }
})

it("bounds recovery rows and forbids duplicate lifecycle identities", () => {
  expect(fleetSnapshotSchema.safeParse(degraded([])).success).toBe(false)
  expect(fleetSnapshotSchema.safeParse(degraded([quarantined, quarantined])).success).toBe(false)
  expect(fleetSnapshotSchema.safeParse({
    ...degraded([quarantined]), entries: [{ kind: "unenrolled", machineId: quarantined.machineId }],
  }).success).toBe(false)
  expect(fleetSnapshotSchema.safeParse(degraded(Array.from({ length: maximumFleetEntries + 1 }, () => quarantined))).success).toBe(false)
})

it("cannot report a successful forget while retaining that machine's quarantine", () => {
  const result = { outcome: "forgotten", machineId: quarantined.machineId, remoteRevocation: "unconfirmed", fleet: degraded([quarantined]) }
  expect(rpcMethods["fleet.forget"].result.safeParse(result).success).toBe(false)
  expect(rpcMethods["fleet.forget"].result.parse({ ...result, machineId: `machine-${"c".repeat(32)}` }))
    .toEqual({ ...result, machineId: `machine-${"c".repeat(32)}` })
})
