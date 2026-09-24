import { describe, expect, it, jest } from "@jest/globals"

import { protocolCompatibility } from "@getdomovoi/protocol"

import { redeemPairingCode } from "./redeem-pairing-code"
import { protocolVersionForClient } from "./protocol-facts"

const payload = { v: 1 as const, url: "wss://machine.example.ts.net:47831/rpc", code: "hearth-quiet-ember-42", label: "machine" }

// A fake socket the test drives, standing in for the one call a phone makes
// before it holds any credential.
function fakeSocket() {
  const sent: string[] = []
  const socket = {
    sent,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((event: never) => void) | null,
    onclose: null as ((event: never) => void) | null,
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
    await expect(pending).resolves.toEqual({ url: payload.url, token: "t".repeat(43), client: "phone" })
    expect(socket.closed).toBe(true)
  })

  it("carries the platform's own reason when the socket fails", async () => {
    const socket = fakeSocket()
    const pending = redeemPairingCode(payload, "iPhone", () => socket as unknown as WebSocket)
    socket.onerror!({ message: "The certificate for this server is invalid" } as never)
    await expect(pending).rejects.toThrow(/The phone reported: The certificate for this server is invalid/)
  })

  it("says so plainly when the platform gives no reason", async () => {
    const socket = fakeSocket()
    const pending = redeemPairingCode(payload, "iPhone", () => socket as unknown as WebSocket)
    socket.onerror!({} as never)
    await expect(pending).rejects.toThrow(/gave no reason/)
  })

  it("carries a close code and reason", async () => {
    const socket = fakeSocket()
    const pending = redeemPairingCode(payload, "iPhone", () => socket as unknown as WebSocket)
    socket.onclose!({ code: 1006, reason: "abnormal closure" } as never)
    await expect(pending).rejects.toThrow(/\(1006: abnormal closure\)/)
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

  function answered(reply: unknown) {
    const socket = fakeSocket()
    const pending = redeemPairingCode(payload, "iPad", () => socket as unknown as WebSocket)
    socket.onopen!()
    socket.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply as object }) })
    return pending
  }

  function paired(client: string) {
    return { result: {
      token: "t".repeat(43),
      device: { id: `device-${"a".repeat(32)}`, label: "iPad", pairedAt: "2026-09-16T12:00:00.000Z", binding: { kind: "client", client } },
    } }
  }

  it("keeps a tablet code's kind, so the app greets as the tablet it was paired as", async () => {
    await expect(answered(paired("tablet"))).resolves.toEqual({ url: payload.url, token: "t".repeat(43), client: "tablet" })
  })

  it("refuses a code issued for a desktop and says which kind to show instead", async () => {
    await expect(answered(paired("desktop"))).rejects.toThrow(/issued for a desktop.*phone or tablet/)
  })

  it("says the protocols differ and that the code was not used, rather than calling it spent", async () => {
    const daemonProtocolVersion = "99.0.0"
    const pending = answered({ error: {
      code: -32012,
      message: "Client and daemon protocol versions are incompatible",
      data: {
        kind: "protocol-mismatch",
        daemonProtocolVersion,
        clientProtocolVersion: protocolVersionForClient,
        compatibility: protocolCompatibility(daemonProtocolVersion, protocolVersionForClient),
      },
    } })
    await expect(pending).rejects.toThrow(new RegExp(`protocol ${protocolVersionForClient}.*protocol 99\\.0\\.0.*not used`))
    await expect(pending).rejects.not.toThrow(/may already have been used/)
  })

  it("says the machine has too many paired devices rather than calling the code spent", async () => {
    const pending = answered({ error: { code: -32013, message: "The paired device limit is reached" } })
    await expect(pending).rejects.toThrow(/too many paired devices/)
    await expect(pending).rejects.not.toThrow(/may already have been used/)
  })

  it("carries any other refusal's own reason", async () => {
    const pending = answered({ error: { code: -32603, message: "Device pairing is unavailable" } })
    await expect(pending).rejects.toThrow(/Device pairing is unavailable/)
    await expect(pending).rejects.not.toThrow(/may already have been used/)
  })
})
