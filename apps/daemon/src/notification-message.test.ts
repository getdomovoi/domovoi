import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { notificationMessage } from "./notification-message.js"

describe("notificationMessage", () => {
  it("sends a payload its protocol schema describes", () => {
    expect(JSON.parse(notificationMessage("workspace.changed", demoWorkspace).text)).toEqual({
      jsonrpc: "2.0",
      method: "workspace.changed",
      params: demoWorkspace,
    })
    expect(JSON.parse(notificationMessage("terminal.output", { terminalId: "terminal-1", data: "ls\n" }).text).params)
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

  // Names every object inherits must not pass as declared fields.
  it.each(["toString", "constructor", "__proto__"])("refuses an undeclared own field named %s, top level and nested", (name) => {
    const withField = (value: object) => Object.defineProperty({ ...value }, name, {
      value: "probe", enumerable: true, configurable: true, writable: true,
    })
    expect(() => notificationMessage("workspace.changed", withField(demoWorkspace) as never))
      .toThrow(new RegExp(`workspace\\.changed .*${name}`))
    expect(() => notificationMessage("workspace.changed", { ...demoWorkspace, machine: withField(demoWorkspace.machine) } as never))
      .toThrow(new RegExp(`machine\\.${name}`))
    expect(() => notificationMessage("terminal.output", withField({ terminalId: "terminal-1", data: "ls\n" }) as never))
      .toThrow(new RegExp(`terminal\\.output .*${name}`))
  })

  // JSON.stringify calls toJSON, so the object checked is not always the text
  // sent. The check reads the serialized payload back.
  it("checks the payload JSON.stringify produces, not the object before it", () => {
    const thread = Object.assign([], { toJSON: () => [{ undeclared: true }] })
    expect(() => notificationMessage("workspace.changed", { ...demoWorkspace, thread } as never)).toThrow()
  })

  it("refuses a payload its schema refuses", () => {
    expect(() => notificationMessage("terminal.output", { terminalId: "terminal-1", data: "" })).toThrow()
  })
})
