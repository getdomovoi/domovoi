import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { protocolVersion } from "@getdomovoi/protocol"

import { openClaimConnection } from "./claim-socket.js"
import { Deadline, DeadlineExceededError } from "./deadline.js"

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
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = NativeWebSocket
    vi.useRealTimers()
  })

  it("answers the reply that carries the request id", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", Deadline.start(10_000))
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    const connection = await connecting

    const claiming = connection.call("device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad", machineId: `machine-${"b".repeat(32)}` })
    const sent = JSON.parse(socket.sent[0]!) as { id: number; method: string }
    socket.receive({ jsonrpc: "2.0", id: sent.id + 1, result: { wrong: true } })
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { claimed: true } })

    await expect(claiming).resolves.toEqual({ claimed: true })
    expect(sent.method).toBe("device.claim")
  })

  it("reports the refusal a machine sends back", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", Deadline.start(10_000))
    FakeWebSocket.instances[0]!.open()
    const connection = await connecting

    const claiming = connection.call("device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad", machineId: `machine-${"b".repeat(32)}` })
    const sent = JSON.parse(FakeWebSocket.instances[0]!.sent[0]!) as { id: number }
    FakeWebSocket.instances[0]!.receive({
      jsonrpc: "2.0",
      id: sent.id,
      error: { code: -32600, message: "That pairing code is not valid" },
    })

    await expect(claiming).rejects.toThrow("That pairing code is not valid")
  })

  it("fails a claim left open by a machine that hangs up", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", Deadline.start(10_000))
    FakeWebSocket.instances[0]!.open()
    const connection = await connecting

    const claiming = connection.call("device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad", machineId: `machine-${"b".repeat(32)}` })
    FakeWebSocket.instances[0]!.close()

    await expect(claiming).rejects.toThrow("The machine closed the connection")
  })

  it("gives up on a socket that never opens", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", Deadline.start(5_000))
    const outcome = connecting.catch((cause: unknown) => cause)
    let settled = false
    void outcome.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(outcome).resolves.toBeInstanceOf(DeadlineExceededError)
    await expect(outcome).resolves.toMatchObject({
      stage: "open",
      target: "wss://workshop.tailnet:47831/rpc",
      budgetMs: 5_000,
    })
    expect(FakeWebSocket.instances[0]!.closed).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("fails a call the machine never answers at the deadline the open already spent", async () => {
    const deadline = Deadline.start(1_000)
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", deadline)
    const socket = FakeWebSocket.instances[0]!
    await vi.advanceTimersByTimeAsync(600)
    socket.open()
    const connection = await connecting

    const claiming = connection.call("device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad", machineId: `machine-${"b".repeat(32)}` })
    const outcome = claiming.catch((cause: unknown) => cause)
    let settled = false
    void outcome.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(399)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(outcome).resolves.toBeInstanceOf(DeadlineExceededError)
    await expect(outcome).resolves.toMatchObject({ stage: "device.claim", budgetMs: 1_000 })
    expect(String(await outcome)).not.toContain("hearth-quiet-ember-42")
    expect(socket.closed).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    const sent = JSON.parse(socket.sent[0]!) as { id: number }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { late: true } })
    await expect(connection.call("system.hello", { client: "machine", clientVersion: "0.0.1", protocolVersion, authToken: "n".repeat(43) }))
      .rejects.toBeInstanceOf(DeadlineExceededError)
    expect(socket.sent).toHaveLength(1)
  })

  it("fails a claim in flight when the socket errors after opening", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", Deadline.start(10_000))
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    const connection = await connecting

    const claiming = connection.call("device.claim", { code: "hearth-quiet-ember-42", label: "studio-ipad", machineId: `machine-${"b".repeat(32)}` })
    socket.dispatchEvent(new Event("error"))

    await expect(claiming).rejects.toThrow("The machine closed the connection")
    expect(socket.closed).toBe(1)
  })

  it("refuses to open once the deadline has passed", async () => {
    const deadline = Deadline.start(100)
    await vi.advanceTimersByTimeAsync(100)

    await expect(openClaimConnection("wss://workshop.tailnet:47831/rpc", deadline))
      .rejects.toMatchObject({ name: "DeadlineExceededError", stage: "open" })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it("stops the deadline listening once the connection is closed", async () => {
    const deadline = Deadline.start(1_000)
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", deadline)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    const connection = await connecting

    connection.close()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(socket.closed).toBe(1)
    expect(deadline.expired).toBe(true)
  })

  it("fails to open when the machine cannot be reached", async () => {
    const connecting = openClaimConnection("wss://workshop.tailnet:47831/rpc", Deadline.start(10_000))
    FakeWebSocket.instances[0]!.dispatchEvent(new Event("error"))

    await expect(connecting).rejects.toThrow("Cannot reach wss://workshop.tailnet:47831/rpc")
  })
})
