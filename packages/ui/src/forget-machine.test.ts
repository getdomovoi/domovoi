import { describe, expect, it } from "vitest"

import { fleetForgetRefusalSchema, fleetRemoteRevocationSchema } from "@getdomovoi/protocol"

import { forgetMachineNotice, forgetRefusalMessage, remoteRevocationNote } from "./forget-machine.js"

const machineId = `machine-${"b".repeat(32)}`
const operation = {
  kind: "pending" as const,
  id: "3d5b7a2e-4c1f-4a6b-9e2d-8f7c6b5a4d3e",
  machineId,
  operation: "forget" as const,
  startedAt: "2026-09-04T12:00:00.000Z",
}

describe("forgetMachineNotice", () => {
  it("says the target revoked this machine only when the daemon confirmed it", () => {
    const notice = forgetMachineNotice(
      { outcome: "forgotten", machineId, remoteRevocation: "confirmed", fleet: { entries: [] } },
      "studio",
    )
    expect(notice.title).toBe("Forgot studio")
    expect(notice.detail).toContain("studio revoked this machine's credential")
    expect(notice.detail).not.toContain("Devices list")
  })

  it("tells the operator where to revoke this machine when nothing confirmed it", () => {
    const notice = forgetMachineNotice(
      { outcome: "forgotten", machineId, remoteRevocation: "unconfirmed", fleet: { entries: [] } },
      "studio",
    )
    expect(notice.detail).toContain("studio did not confirm revoking this machine")
    expect(notice.detail).toContain("Revoke this machine in the Devices list on studio")
    expect(notice.detail).not.toContain("revoked this machine's credential")
  })

  it("names a pending forget as the daemon's to finish, and still says who revokes", () => {
    const notice = forgetMachineNotice(
      { outcome: "pending", operation, remoteRevocation: "unconfirmed", fleet: { entries: [operation] } },
      "studio",
    )
    expect(notice.title).toBe("Forgetting studio")
    expect(notice.detail).toContain("This daemon resumes it on its own")
    expect(notice.detail).toContain("Revoke this machine in the Devices list on studio")
  })

  it("turns every refusal and every revocation verdict into words", () => {
    for (const reason of fleetForgetRefusalSchema.options) {
      const notice = forgetMachineNotice({ outcome: "refused", reason }, "studio")
      expect(notice.detail).toBe(forgetRefusalMessage[reason])
      expect(notice.detail).not.toMatch(/[!—]/u)
    }
    for (const verdict of fleetRemoteRevocationSchema.options) {
      expect(remoteRevocationNote[verdict]("studio")).not.toMatch(/[!—]/u)
    }
  })
})
