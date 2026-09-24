import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { notificationMessage } from "./notification-message.js"

describe("notificationMessage", () => {
  it("sends a payload its protocol schema describes", () => {
    expect(JSON.parse(notificationMessage("workspace.changed", demoWorkspace))).toEqual({
      jsonrpc: "2.0",
      method: "workspace.changed",
      params: demoWorkspace,
    })
    expect(JSON.parse(notificationMessage("terminal.output", { terminalId: "terminal-1", data: "ls\n" })).params)
      .toEqual({ terminalId: "terminal-1", data: "ls\n" })
  })

  // The wire record fingerprints the notification schemas. A field the daemon
  // adds only to the payload would change the wire without moving the record.
  it("refuses a payload field its schema does not describe, at any depth", () => {
    expect(() => notificationMessage("workspace.changed", { ...demoWorkspace, extra: true } as never))
      .toThrow(/workspace\.changed .*extra/)
    expect(() => notificationMessage("workspace.changed", {
      ...demoWorkspace,
      machine: { ...demoWorkspace.machine, extra: true },
    } as never)).toThrow(/machine\.extra/)
    expect(() => notificationMessage("terminal.output", { terminalId: "terminal-1", data: "ls\n", extra: 1 } as never))
      .toThrow(/terminal\.output .*extra/)
  })

  it("refuses a payload its schema refuses", () => {
    expect(() => notificationMessage("terminal.output", { terminalId: "terminal-1", data: "" })).toThrow()
  })
})
