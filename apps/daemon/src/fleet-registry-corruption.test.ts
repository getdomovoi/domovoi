import { DatabaseSync } from "node:sqlite"

import { protocolVersion, type FleetMachineFacts } from "@getdomovoi/protocol"
import { expect, it } from "vitest"

import { SqliteFleetRegistry } from "./fleet-registry.js"

const selfId = `machine-${"a".repeat(32)}`
const corruptId = `machine-${"b".repeat(32)}`
const healthyId = `machine-${"c".repeat(32)}`
const credentialDigest = `sha256:${"d".repeat(64)}`
const receivedAt = Date.parse("2026-09-05T12:00:00.000Z")

function facts(id: string): FleetMachineFacts {
  return {
    id, label: "studio", platform: "linux", arch: "x64", version: "0.0.1",
    connection: "direct", capabilities: ["sessions"], protocolVersion,
    transports: [], verifiedRoute: {
      endpoint: "ws://127.0.0.1:47831/rpc", lastAuthenticatedAt: new Date(receivedAt).toISOString(),
    },
  }
}

for (const corruption of ["{malformed-json", '["invalid-capability"]']) {
  for (const reader of ["snapshot", "enrolled", "lookupMachine"] as const) {
    it(`${reader} isolates ${corruption.startsWith("{") ? "malformed JSON" : "invalid facts"} to the damaged machine`, () => {
      const database = new DatabaseSync(":memory:")
      const registry = new SqliteFleetRegistry(database)
      try {
        for (const id of [corruptId, healthyId]) {
          const operation = registry.stageEnrollment(facts(id), credentialDigest, receivedAt)
          expect(registry.completeEnrollment(operation.id, credentialDigest)).toBe(true)
        }
        database.prepare("UPDATE fleet_machines SET capabilities = ? WHERE id = ?").run(corruption, corruptId)
        switch (reader) {
          case "snapshot":
            expect(registry.snapshot(selfId, receivedAt).entries.flatMap((entry) => entry.kind === "machine" ? [entry.machine.id] : []))
              .toEqual([healthyId])
            break
          case "enrolled":
            expect(registry.enrolled().map((entry) => entry.facts.id)).toEqual([healthyId])
            break
          case "lookupMachine":
            expect(registry.lookupMachine(corruptId, selfId, receivedAt)).toBeUndefined()
            expect(registry.lookupMachine(healthyId, selfId, receivedAt)?.id).toBe(healthyId)
            break
        }
      } finally { database.close() }
    })
  }
}
