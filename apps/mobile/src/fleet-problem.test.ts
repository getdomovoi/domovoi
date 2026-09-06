import { fleetSnapshotOverflowErrorCode, maximumFleetEntries } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { fleetProblem } from "./fleet-problem"
import { DaemonError } from "./lib/daemon"

const overflow = {
  kind: "fleet-overflow",
  limit: maximumFleetEntries,
  totalEntries: maximumFleetEntries + 40,
  entriesNotShown: maximumFleetEntries + 40,
}

describe("fleetProblem", () => {
  it("says the daemon withheld the list, with the counts, and that the fix is on its machine", () => {
    const problem = fleetProblem(new DaemonError("Fleet keyring exceeds the wire limit", fleetSnapshotOverflowErrorCode, overflow))
    expect(problem).toContain("withheld the fleet list")
    expect(problem).toContain(`${maximumFleetEntries + 40} entries`)
    expect(problem).toContain(`over the ${maximumFleetEntries}`)
    expect(problem).toContain("none are shown")
    expect(problem).toContain("not an empty fleet")
    expect(problem).toContain("on the daemon's machine")
    expect(problem).toContain("domovoid fleet-keychain list")
    expect(problem).not.toMatch(/[!—]/u)
  })

  it("classifies by the daemon's code, never by wording, and only with typed data", () => {
    expect(fleetProblem(new DaemonError("fleet-overflow", -32603, overflow))).toBe("fleet-overflow")
    expect(fleetProblem(new DaemonError("overflow", fleetSnapshotOverflowErrorCode, { kind: "fleet-overflow" }))).toBe("overflow")
    expect(fleetProblem(new Error("timed out"))).toBe("timed out")
    expect(fleetProblem("nonsense")).toBe("The fleet could not be listed")
  })
})
