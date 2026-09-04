import { describe, expect, it } from "vitest"

import { fleetSnapshotOverflowErrorCode, maximumFleetEntries, type FleetSnapshotOverflow } from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"
import { fleetListingOverflow, fleetOverflowNotice } from "./fleet-overflow.js"

const overflow: FleetSnapshotOverflow = {
  kind: "fleet-overflow",
  limit: maximumFleetEntries,
  totalEntries: maximumFleetEntries + 40,
  entriesNotShown: maximumFleetEntries + 40,
}

describe("fleetListingOverflow", () => {
  it("classifies by the daemon's own code and parses the typed data", () => {
    expect(fleetListingOverflow(new DaemonRpcError(fleetSnapshotOverflowErrorCode, "Fleet keyring exceeds the wire limit", overflow)))
      .toEqual(overflow)
  })

  it("never classifies by message text", () => {
    expect(fleetListingOverflow(new DaemonRpcError(-32603, "fleet-overflow", overflow))).toBeUndefined()
    expect(fleetListingOverflow(new Error("fleet-overflow"))).toBeUndefined()
  })

  it("refuses data the protocol does not describe", () => {
    expect(fleetListingOverflow(new DaemonRpcError(fleetSnapshotOverflowErrorCode, "overflow", { kind: "fleet-overflow" })))
      .toBeUndefined()
    expect(fleetListingOverflow(new DaemonRpcError(fleetSnapshotOverflowErrorCode, "overflow", undefined))).toBeUndefined()
  })
})

describe("fleetOverflowNotice", () => {
  const notice = fleetOverflowNotice(overflow)

  it("says the list is withheld, not partial, with the counts", () => {
    expect(notice.title).toBe("Fleet list withheld")
    expect(notice.detail).toContain(`${maximumFleetEntries + 40} fleet entries`)
    expect(notice.detail).toContain(`more than the ${maximumFleetEntries}`)
    expect(notice.detail).toContain(`${maximumFleetEntries + 40} entries are not shown`)
    expect(notice.detail).toContain("none of them rather than a shortened list")
    expect(notice.detail).toContain("This is not an empty fleet")
  })

  it("names the daemon's own CLI as the remedy, on the daemon's machine", () => {
    expect(notice.remedy).toContain("On the daemon's own machine")
    expect(notice.remedy).toContain("domovoid fleet-keychain list")
    expect(notice.remedy).toContain("domovoid fleet-keychain forget <machine-id> --confirm-daemon-stopped")
    expect(notice.remedy).toContain("does not revoke the credential on the target")
    expect(`${notice.title} ${notice.detail} ${notice.remedy}`).not.toMatch(/[!—]/u)
  })
})
