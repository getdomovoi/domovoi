import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { errorResponseMessage, responseMessage } from "./response-message.js"

const invalidParams = -32602

describe("responseMessage", () => {
  it("sends a result its method's protocol schema describes", () => {
    const frame = responseMessage("workspace.get", 7, demoWorkspace)
    expect(JSON.parse(frame.text)).toEqual({ jsonrpc: "2.0", id: 7, result: demoWorkspace })
    expect(JSON.parse(responseMessage("device.revokeCurrent", "request-1", { revoked: true }).text))
      .toEqual({ jsonrpc: "2.0", id: "request-1", result: { revoked: true } })
    expect(Object.isFrozen(frame)).toBe(true)
  })

  it("refuses a response with no result", () => {
    expect(() => responseMessage("workspace.get", 1, undefined as never)).toThrow()
  })

  it("refuses a result its method's schema refuses", () => {
    expect(() => responseMessage("device.revokeCurrent", 1, { revoked: false } as never)).toThrow()
    expect(() => responseMessage("device.revokeCurrent", 1, { revoked: true, extra: 1 } as never)).toThrow()
    expect(() => responseMessage("workspace.get", 1, { revoked: true } as never)).toThrow()
  })

  it("refuses a result field its schema does not describe, at any depth", () => {
    expect(() => responseMessage("workspace.get", 1, { ...demoWorkspace, extra: true } as never))
      .toThrow(/workspace\.get .*extra/)
    expect(() => responseMessage("workspace.get", 1, {
      ...demoWorkspace,
      machine: { ...demoWorkspace.machine, extra: true },
    } as never)).toThrow(/machine\.extra/)
  })

  it("refuses an id a response may not carry", () => {
    for (const id of [null, 1.5, "", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => responseMessage("device.revokeCurrent", id as never, { revoked: true })).toThrow()
    }
  })

  it("refuses a method that is not a primitive string naming a protocol method", () => {
    const method = { toString: () => "device.revokeCurrent", toJSON: () => "workspace.get" }
    expect(() => responseMessage(method as never, 1, { revoked: true })).toThrow(/method/)
    expect(() => responseMessage("unrecorded.method" as never, 1, { revoked: true })).toThrow(/method/)
    expect(() => responseMessage("toString" as never, 1, { revoked: true })).toThrow(/method/)
  })

  // JSON.stringify calls toJSON, so the object checked is not always the text
  // sent. The check reads the serialized envelope back.
  it("checks the result JSON.stringify produces, not the object before it", () => {
    const disguised = { revoked: true, toJSON: () => ({ revoked: true, extra: 1 }) }
    expect(() => responseMessage("device.revokeCurrent", 1, disguised as never)).toThrow()
    const thread = Object.assign([], { toJSON: () => [{ undeclared: true }] })
    expect(() => responseMessage("workspace.get", 1, { ...demoWorkspace, thread } as never)).toThrow()
    const id = { toJSON: () => 2 }
    expect(() => responseMessage("device.revokeCurrent", id as never, { revoked: true })).toThrow()
    const vanishing = { toJSON: () => undefined }
    expect(() => responseMessage("workspace.get", 1, vanishing as never)).toThrow()
  })
})

describe("errorResponseMessage", () => {
  it("sends a JSON-RPC 2.0 error", () => {
    expect(JSON.parse(errorResponseMessage(1, { code: invalidParams, message: "Session does not exist" }).text))
      .toEqual({ jsonrpc: "2.0", id: 1, error: { code: invalidParams, message: "Session does not exist" } })
    expect(JSON.parse(errorResponseMessage(null, { code: invalidParams, message: "Request is not valid JSON" }).text))
      .toEqual({ jsonrpc: "2.0", id: null, error: { code: invalidParams, message: "Request is not valid JSON" } })
    const data = { kind: "session-attachment-refused", reason: "invalid-image" } as const
    expect(JSON.parse(errorResponseMessage("r", { code: invalidParams, message: "Refused", data }).text).error.data)
      .toEqual(data)
    expect(Object.isFrozen(errorResponseMessage(1, { code: invalidParams, message: "x" }))).toBe(true)
  })

  it.each([
    ["no code", { message: "x" }],
    ["no message", { code: invalidParams }],
    ["a fractional code", { code: 1.5, message: "x" }],
    ["a string code", { code: "-32602", message: "x" }],
    ["an unsafe code", { code: Number.MAX_SAFE_INTEGER + 1, message: "x" }],
    ["a non-string message", { code: invalidParams, message: 1 }],
    ["an undeclared field", { code: invalidParams, message: "x", extra: true }],
    ["a null error", null],
    ["an array error", [invalidParams, "x"]],
  ])("refuses an error with %s", (_name, error) => {
    expect(() => errorResponseMessage(1, error as never)).toThrow()
  })

  it("refuses error data the protocol does not declare", () => {
    expect(() => errorResponseMessage(1, { code: invalidParams, message: "x", data: { kind: "unrecorded" } } as never))
      .toThrow(/data/)
    expect(() => errorResponseMessage(1, { code: invalidParams, message: "x", data: "text" } as never)).toThrow(/data/)
    expect(() => errorResponseMessage(1, {
      code: invalidParams,
      message: "x",
      data: { kind: "session-attachment-refused", reason: "unrecorded" },
    } as never)).toThrow()
    expect(() => errorResponseMessage(1, {
      code: invalidParams,
      message: "x",
      data: { kind: "session-attachment-refused", reason: "invalid-image", extra: 1 },
    } as never)).toThrow()
  })

  it("refuses an id an error response may not carry", () => {
    for (const id of [1.5, "", { toJSON: () => 2 }, undefined]) {
      expect(() => errorResponseMessage(id as never, { code: invalidParams, message: "x" })).toThrow()
    }
  })

  it("checks the error JSON.stringify produces, not the object before it", () => {
    const disguised = { code: invalidParams, message: "x", toJSON: () => ({ code: invalidParams }) }
    expect(() => errorResponseMessage(1, disguised)).toThrow()
    const data = { kind: "session-attachment-refused", reason: "invalid-image", toJSON: () => ({ kind: "unrecorded" }) }
    expect(() => errorResponseMessage(1, { code: invalidParams, message: "x", data } as never)).toThrow()
  })
})
