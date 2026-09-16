import { describe, expect, it, jest } from "@jest/globals"

import { redeemPairingCode } from "./redeem-pairing-code"

const payload = { v: 1 as const, url: "wss://machine.example.ts.net:47831/rpc", code: "hearth-quiet-ember-42", label: "machine" }

// A fake socket the test drives, standing in for the one call a phone makes
// before it holds any credential.
function fakeSocket() {
  const sent: string[] = []
  const socket = {
    sent,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as (() => void) | null,
    onclose: null as (() => void) | null,
    closed: false,
    send: (text: string) => { sent.push(text) },
    close: () => { socket.closed = true },
  }
  return socket
}

describe("spending a pairing code", () => {
  it("asks the machine named in the code and returns the credential it mints", async () => {
    const socket = fakeSocket()
    const pending = redeemPairingCode(payload, "iPhone", () => socket as unknown as WebSocket)
    socket.onopen!()
    const request = JSON.parse(socket.sent[0]!) as { method: string, params: Record<string, unknown> }
    expect(request.method).toBe("device.redeemCode")
    expect(request.params).toMatchObject({ code: payload.code, label: "iPhone" })
    // The phone never says which kind it is: the code decides that.
    expect(request.params).not.toHaveProperty("targetClient")
    expect(request.params).not.toHaveProperty("client")
    socket.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      token: "t".repeat(43),
      device: { id: `device-${"a".repeat(32)}`, label: "iPhone", pairedAt: "2026-09-16T12:00:00.000Z", binding: { kind: "client", client: "phone" } },
    } }) })
    await expect(pending).resolves.toEqual({ url: payload.url, token: "t".repeat(43) })
    expect(socket.closed).toBe(true)
  })

  it("turns the machine's uniform refusal into what to do next", async () => {
    const socket = fakeSocket()
    const pending = redeemPairingCode(payload, "iPhone", () => socket as unknown as WebSocket)
    socket.onopen!()
    socket.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Pairing was refused" } }) })
    await expect(pending).rejects.toThrow(/may already have been used/)
    expect(socket.closed).toBe(true)
  })

  it("refuses a nameless phone before opening a socket", async () => {
    const open = jest.fn()
    await expect(redeemPairingCode(payload, "   ", open as unknown as (url: string) => WebSocket)).rejects.toThrow(/name the machine can show/)
    expect(open).not.toHaveBeenCalled()
  })

  it("says the machine never answered rather than waiting forever", async () => {
    jest.useFakeTimers()
    try {
      const socket = fakeSocket()
      const pending = redeemPairingCode(payload, "iPhone", () => socket as unknown as WebSocket)
      socket.onopen!()
      const settled = expect(pending).rejects.toThrow(/did not answer/)
      jest.advanceTimersByTime(10_000)
      await settled
    } finally {
      jest.useRealTimers()
    }
  })
})
