import { describe, expect, it } from "vitest"

import { deviceLabelMismatchErrorCode, type DeviceLabelMismatch, type PairedDeviceSummary } from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"
import { deviceLabelMismatch, renamedElsewhereNotice } from "./rename-device.js"

const device: PairedDeviceSummary = {
  id: `device-${"d".repeat(32)}`,
  label: "desk-ipad",
  pairedAt: "2026-08-20T09:00:00.000Z",
  binding: { kind: "client", client: "tablet" },
}

const mismatch: DeviceLabelMismatch = { kind: "device-label-mismatch", device }

describe("deviceLabelMismatch", () => {
  it("classifies by the daemon's own code and parses the typed data", () => {
    expect(deviceLabelMismatch(new DaemonRpcError(deviceLabelMismatchErrorCode, "Paired device is called desk-ipad", mismatch)))
      .toEqual(mismatch)
  })

  it("never classifies by message text", () => {
    expect(deviceLabelMismatch(new DaemonRpcError(-32603, "device-label-mismatch", mismatch))).toBeUndefined()
    expect(deviceLabelMismatch(new Error("device-label-mismatch"))).toBeUndefined()
  })

  it("refuses data the protocol does not describe", () => {
    expect(deviceLabelMismatch(new DaemonRpcError(deviceLabelMismatchErrorCode, "mismatch", { kind: "device-label-mismatch" })))
      .toBeUndefined()
    expect(deviceLabelMismatch(new DaemonRpcError(deviceLabelMismatchErrorCode, "mismatch", { ...mismatch, token: "secret" })))
      .toBeUndefined()
    expect(deviceLabelMismatch(new DaemonRpcError(deviceLabelMismatchErrorCode, "mismatch", undefined))).toBeUndefined()
  })
})

describe("renamedElsewhereNotice", () => {
  it("says the name was changed elsewhere and shows the current one", () => {
    const notice = renamedElsewhereNotice("kitchen-ipad", device)
    expect(notice).toContain("changed elsewhere")
    expect(notice).toContain("kitchen-ipad")
    expect(notice).toContain("desk-ipad")
    expect(notice).not.toMatch(/[—!]/)
  })
})
