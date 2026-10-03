import { describe, expect, it } from "vitest"

import * as protocol from "./index.js"

describe("notificationMethods", () => {
  it("maps each notification the daemon sends to its exported params schema", () => {
    // Strict: toEqual would pass a key whose expected schema is undefined.
    expect(protocol.notificationMethods).toStrictEqual({
      "workspace.changed": protocol.workspaceSnapshotSchema,
      "workspace.delta": protocol.workspaceDeltaSchema,
      "terminal.output": protocol.terminalOutputNotificationSchema,
      "terminal.closed": protocol.terminalClosedNotificationSchema,
      "terminal.ownership": protocol.terminalOwnershipNotificationSchema,
      "fleet.changed": protocol.fleetChangedNotificationSchema,
      "system.emergencyStopped": protocol.systemEmergencyStoppedNotificationSchema,
      "device.codeOutcome": protocol.deviceCodeOutcomeNotificationSchema,
    })
  })
})
