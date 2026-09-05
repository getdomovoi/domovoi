import { describe, expect, it, vi } from "vitest"

import {
  maximumRpcWebSocketBackpressurePolls,
  retryableSlowClientCloseCode,
  retryableSlowClientCloseReason,
  RpcOutboundBackpressure,
} from "./rpc-outbound.js"

class FakeSocket {
  readyState = 1
  bufferedAmount = 0
  readonly sent: string[] = []
  readonly close = vi.fn((code: number, reason: string) => {
    this.readyState = 2
    void code
    void reason
  })

  send(message: string): void {
    this.sent.push(message)
  }
}

function manualScheduler() {
  const pending: Array<() => void> = []
  return {
    pending,
    schedule: (callback: () => void) => {
      pending.push(callback)
      return callback
    },
    cancel: (timer: unknown) => {
      const index = pending.indexOf(timer as () => void)
      if (index >= 0) pending.splice(index, 1)
    },
    runNext: () => pending.shift()?.(),
  }
}

describe("RpcOutboundBackpressure", () => {
  it("preserves healthy frames and response order", () => {
    const socket = new FakeSocket()
    const policy = new RpcOutboundBackpressure({ highWaterBytes: 100, lowWaterBytes: 25 })

    expect(policy.send(socket, "response-1")).toBe(true)
    expect(policy.send(socket, "response-2")).toBe(true)
    expect(policy.notify(socket, "workspace.changed", "snapshot-1", () => "resync")).toBe(true)

    expect(socket.sent).toEqual(["response-1", "response-2", "snapshot-1"])
    expect(socket.close).not.toHaveBeenCalled()
  })

  it("closes at the response high-water boundary without retaining a response queue", () => {
    const socket = new FakeSocket()
    socket.bufferedAmount = 100
    const policy = new RpcOutboundBackpressure({ highWaterBytes: 100, lowWaterBytes: 25 })

    expect(policy.send(socket, "response-at-boundary")).toBe(false)

    expect(socket.sent).toEqual([])
    expect(socket.close).toHaveBeenCalledWith(
      retryableSlowClientCloseCode,
      retryableSlowClientCloseReason,
    )
    expect(policy.retainedClientCount).toBe(0)
  })

  it("includes UTF-8 frame bytes in the response high-water decision", () => {
    const socket = new FakeSocket()
    const policy = new RpcOutboundBackpressure({ highWaterBytes: 10, lowWaterBytes: 2 })

    expect(policy.send(socket, "é".repeat(5))).toBe(false)

    expect(socket.sent).toEqual([])
    expect(socket.close).toHaveBeenCalledWith(
      retryableSlowClientCloseCode,
      retryableSlowClientCloseReason,
    )
  })

  it("coalesces workspace bursts into one latest resync without retaining payloads", () => {
    const scheduler = manualScheduler()
    const socket = new FakeSocket()
    socket.bufferedAmount = 100
    let revision = 1
    const resync = vi.fn(() => `snapshot-${revision}`)
    const policy = new RpcOutboundBackpressure({
      highWaterBytes: 100,
      lowWaterBytes: 25,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    })

    for (revision = 1; revision <= 1_000; revision += 1) {
      expect(policy.notify(socket, "workspace.delta", `delta-${revision}`, resync)).toBe(false)
    }

    expect(socket.sent).toEqual([])
    expect(resync).not.toHaveBeenCalled()
    expect(policy.retainedClientCount).toBe(1)
    expect(scheduler.pending).toHaveLength(1)

    revision = 1_001
    socket.bufferedAmount = 25
    scheduler.runNext()

    expect(socket.sent).toEqual(["snapshot-1001"])
    expect(resync).toHaveBeenCalledOnce()
    expect(policy.retainedClientCount).toBe(0)
    expect(scheduler.pending).toHaveLength(0)
  })

  it("closes after the bounded poll budget when a client never drains", () => {
    const scheduler = manualScheduler()
    const socket = new FakeSocket()
    socket.bufferedAmount = 100
    const policy = new RpcOutboundBackpressure({
      highWaterBytes: 100,
      lowWaterBytes: 25,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    })

    expect(policy.notify(socket, "workspace.changed", "snapshot", () => "resync")).toBe(false)
    for (let poll = 1; poll < maximumRpcWebSocketBackpressurePolls; poll += 1) {
      scheduler.runNext()
      expect(socket.close).not.toHaveBeenCalled()
      expect(scheduler.pending).toHaveLength(1)
    }
    scheduler.runNext()

    expect(socket.close).toHaveBeenCalledWith(
      retryableSlowClientCloseCode,
      retryableSlowClientCloseReason,
    )
    expect(policy.retainedClientCount).toBe(0)
    expect(scheduler.pending).toHaveLength(0)
  })

  it.each(["system.emergencyStopped", "fleet.changed"])("closes rather than dropping a non-coalescible %s notification", (method) => {
    const socket = new FakeSocket()
    socket.bufferedAmount = 100
    const policy = new RpcOutboundBackpressure({ highWaterBytes: 100, lowWaterBytes: 25 })

    expect(policy.notify(socket, method, "event", () => "resync")).toBe(false)

    expect(socket.sent).toEqual([])
    expect(socket.close).toHaveBeenCalledWith(
      retryableSlowClientCloseCode,
      retryableSlowClientCloseReason,
    )
    expect(policy.retainedClientCount).toBe(0)
  })

  it("closes when a coalesced latest snapshot cannot fit at low water", () => {
    const scheduler = manualScheduler()
    const socket = new FakeSocket()
    const policy = new RpcOutboundBackpressure({
      highWaterBytes: 10,
      lowWaterBytes: 2,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    })

    expect(policy.notify(socket, "workspace.delta", "x".repeat(10), () => "é".repeat(5))).toBe(false)
    expect(policy.retainedClientCount).toBe(1)
    expect(scheduler.pending).toHaveLength(1)

    scheduler.runNext()

    expect(socket.sent).toEqual([])
    expect(socket.close).toHaveBeenCalledWith(
      retryableSlowClientCloseCode,
      retryableSlowClientCloseReason,
    )
    expect(policy.retainedClientCount).toBe(0)
    expect(scheduler.pending).toHaveLength(0)
  })

  it.each(["terminal.output", "terminal.closed", "terminal.ownership"])(
    "leaves %s on its existing direct-send path",
    (method) => {
      const socket = new FakeSocket()
      socket.bufferedAmount = 100
      const policy = new RpcOutboundBackpressure({ highWaterBytes: 100, lowWaterBytes: 25 })

      expect(policy.notify(socket, method, method, () => "resync")).toBe(true)

      expect(socket.sent).toEqual([method])
      expect(socket.close).not.toHaveBeenCalled()
      expect(policy.retainedClientCount).toBe(0)
    },
  )
})
