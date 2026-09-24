import { describe, expect, it, vi } from "vitest"

import { notificationMessage } from "./notification-message.js"
import { errorResponseMessage, responseMessage } from "./response-message.js"
import { RpcWriter } from "./rpc-writer.js"

class FakeSocket {
  readyState = 1
  bufferedAmount = 0
  readonly sent: string[] = []
  readonly close = vi.fn()

  send(message: string): void {
    this.sent.push(message)
  }
}

// The writer is the daemon's only way to an RPC client. A notification reaches
// the wire only as a frame notificationMessage built from notificationMethods,
// and a response only as a frame responseMessage or errorResponseMessage built.
describe("RpcWriter", () => {
  it("writes a response and a notification built from its schema", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()
    const frame = notificationMessage("terminal.output", { terminalId: "terminal-1", data: "ls\n" })

    expect(writer.respond(socket, responseMessage("device.revokeCurrent", 7, { revoked: true }))).toBe(true)
    expect(writer.respond(socket, errorResponseMessage(8, { code: -32602, message: "Session does not exist" }))).toBe(true)
    expect(writer.notify(socket, frame, () => undefined)).toBe(true)

    expect(socket.sent).toEqual([
      '{"jsonrpc":"2.0","id":7,"result":{"revoked":true}}',
      '{"jsonrpc":"2.0","id":8,"error":{"code":-32602,"message":"Session does not exist"}}',
      frame.text,
    ])
  })

  it.each([
    ["an id alone", { id: 1 }],
    ["a malformed error", { jsonrpc: "2.0", id: 1, error: { message: 1 } }],
    ["a result and an error", { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } }],
    ["a result its method refuses", { jsonrpc: "2.0", id: 1, result: { revoked: false } }],
    ["an undeclared envelope field", { jsonrpc: "2.0", id: 1, result: { revoked: true }, extra: true }],
    ["a well formed response", { jsonrpc: "2.0", id: 1, result: { revoked: true } }],
  ])("refuses a response object, %s, that no response builder issued", (_name, payload) => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()

    expect(() => writer.respond(socket, payload as never)).toThrow(/responseMessage/)
    expect(socket.sent).toEqual([])
  })

  it("refuses a response frame no response builder issued", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()
    const issued = responseMessage("device.revokeCurrent", 1, { revoked: true })
    const forged = { ...issued, text: '{"id":1}' }

    expect(() => writer.respond(socket, forged)).toThrow(/responseMessage/)
    expect(() => writer.respond(socket, notificationMessage("terminal.output", { terminalId: "t", data: "x" }) as never))
      .toThrow(/responseMessage/)
    expect(socket.sent).toEqual([])
  })

  it("refuses a raw send of a notification", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()

    expect(() => writer.respond(socket, { jsonrpc: "2.0", method: "unrecorded.notice", params: {} } as never))
      .toThrow(/responseMessage/)
    expect(() => writer.respond(socket, { jsonrpc: "2.0", id: 1, method: "unrecorded.notice", params: {} } as never))
      .toThrow(/responseMessage/)
    expect(socket.sent).toEqual([])
  })

  it("checks the envelope JSON.stringify produces, not the object before it", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()
    const disguised = {
      jsonrpc: "2.0",
      id: 1,
      result: {},
      toJSON: () => ({ jsonrpc: "2.0", method: "unrecorded.notice", params: {} }),
    }

    expect(() => writer.respond(socket, disguised as never)).toThrow(/responseMessage/)
    expect(socket.sent).toEqual([])
  })

  it("refuses a notification frame notificationMessage did not build", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()
    const forged = { method: "terminal.output", text: '{"jsonrpc":"2.0","method":"unrecorded.notice","params":{}}' } as const

    expect(() => writer.notify(socket, forged, () => undefined)).toThrow(/notificationMessage/)
    expect(socket.sent).toEqual([])
  })

  // The schema lookup coerces a method with toString while JSON.stringify
  // calls toJSON, so an object method could be checked as one name and sent
  // as another.
  it("refuses a method that is not a primitive string", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()
    const method = { toString: () => "terminal.output", toJSON: () => "unrecorded.notice" }

    expect(() => {
      const frame = notificationMessage(method as unknown as "terminal.output", { terminalId: "t", data: "x" })
      writer.notify(socket, frame, () => undefined)
    }).toThrow(/method/)
    expect(() => notificationMessage(new String("terminal.output") as unknown as "terminal.output", { terminalId: "t", data: "x" }))
      .toThrow(/method/)
    expect(socket.sent).toEqual([])
  })
})
