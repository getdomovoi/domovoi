import { describe, expect, it, vi } from "vitest"

import { notificationMessage } from "./notification-message.js"
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
// the wire only as a frame notificationMessage built from notificationMethods.
describe("RpcWriter", () => {
  it("writes a response and a notification built from its schema", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()
    const frame = notificationMessage("terminal.output", { terminalId: "terminal-1", data: "ls\n" })

    expect(writer.respond(socket, { jsonrpc: "2.0", id: 7, result: { ok: true } })).toBe(true)
    expect(writer.notify(socket, frame, () => undefined)).toBe(true)

    expect(socket.sent).toEqual(['{"jsonrpc":"2.0","id":7,"result":{"ok":true}}', frame.text])
  })

  it("refuses a raw send of a notification", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()

    expect(() => writer.respond(socket, { jsonrpc: "2.0", method: "unrecorded.notice", params: {} }))
      .toThrow(/unrecorded\.notice/)
    expect(() => writer.respond(socket, { jsonrpc: "2.0", id: 1, method: "unrecorded.notice", params: {} }))
      .toThrow(/unrecorded\.notice/)
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

    expect(() => writer.respond(socket, disguised)).toThrow(/unrecorded\.notice/)
    expect(socket.sent).toEqual([])
  })

  it("refuses a notification frame notificationMessage did not build", () => {
    const socket = new FakeSocket()
    const writer = new RpcWriter()
    const forged = { method: "terminal.output", text: '{"jsonrpc":"2.0","method":"unrecorded.notice","params":{}}' } as const

    expect(() => writer.notify(socket, forged, () => undefined)).toThrow(/notificationMessage/)
    expect(socket.sent).toEqual([])
  })
})
