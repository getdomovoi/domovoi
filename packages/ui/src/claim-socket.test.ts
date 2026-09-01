import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { openClaimConnection } from "./claim-socket.js"

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  closed = 0

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed += 1
    this.dispatchEvent(new Event("close"))
  }

  open(): void {
    this.dispatchEvent(new Event("open"))
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
  }
}

describe("openClaimConnection", () => {
  const NativeWebSocket = globalThis.WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = NativeWebSocket
  })

  it("answers the reply that carries the request id", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc")
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    const connection = await connecting

    const claiming = connection.call("device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad" })
    const sent = JSON.parse(socket.sent[0]!) as { id: number; method: string }
    socket.receive({ jsonrpc: "2.0", id: sent.id + 1, result: { wrong: true } })
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { claimed: true } })

    await expect(claiming).resolves.toEqual({ claimed: true })
    expect(sent.method).toBe("device.claim")
  })

  it("reports the refusal a machine sends back", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc")
    FakeWebSocket.instances[0]!.open()
    const connection = await connecting

    const claiming = connection.call("device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad" })
    const sent = JSON.parse(FakeWebSocket.instances[0]!.sent[0]!) as { id: number }
    FakeWebSocket.instances[0]!.receive({
      jsonrpc: "2.0",
      id: sent.id,
      error: { code: -32600, message: "That pairing code is not valid" },
    })

    await expect(claiming).rejects.toThrow("That pairing code is not valid")
  })

  it("fails a claim left open by a machine that hangs up", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc")
    FakeWebSocket.instances[0]!.open()
    const connection = await connecting

    const claiming = connection.call("device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad" })
    FakeWebSocket.instances[0]!.close()

    await expect(claiming).rejects.toThrow("The machine closed the connection")
  })

  it("gives up on a socket that never opens", async () => {
    vi.useFakeTimers()
    try {
      const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", { openTimeoutMs: 5_000 })
      const settled = expect(connecting).rejects.toThrow("Cannot reach wss://workshop.tailnet:47831/rpc")
      await vi.advanceTimersByTimeAsync(5_000)
      await settled
      expect(FakeWebSocket.instances[0]!.closed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails to open when the machine cannot be reached", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc")
    FakeWebSocket.instances[0]!.dispatchEvent(new Event("error"))

    await expect(connecting).rejects.toThrow("Cannot reach wss://workshop.tailnet:47831/rpc")
  })
})
