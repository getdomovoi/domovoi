import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DaemonConnection } from "./daemon"
import { DaemonTimeoutError, requestTimeoutMs } from "./request-timeout"

class FakeSocket {
  static last: FakeSocket | undefined
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | undefined
  onmessage: ((event: { data: string }) => void) | undefined
  onerror: (() => void) | undefined
  onclose: (() => void) | undefined

  constructor() {
    FakeSocket.last = this
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

const handlers = {
  onSnapshot: vi.fn(),
  onDelta: vi.fn(),
  onStatus: vi.fn(),
  onError: vi.fn(),
  onClosed: vi.fn(),
}

function connect(): DaemonConnection {
  const daemon = new DaemonConnection("ws://daemon/rpc", "t".repeat(43), handlers)
  daemon.connect()
  return daemon
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("WebSocket", FakeSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("a request the daemon never answers", () => {
  it("gives up rather than leaving the caller waiting forever", async () => {
    const daemon = connect()
    const pending = daemon.call("session.send", {})
    const settled = expect(pending).rejects.toBeInstanceOf(DaemonTimeoutError)

    expect(daemon.pendingRequests()).toBe(1)
    await vi.advanceTimersByTimeAsync(requestTimeoutMs("session.send"))
    await settled

    // The waiting caller is answered and the entry is gone, so a daemon that
    // stays silent cannot accumulate promises nobody will ever settle.
    expect(daemon.pendingRequests()).toBe(0)
  })

  it("does not fire once the daemon has answered", async () => {
    const daemon = connect()
    const pending = daemon.call("workspace.get", {})
    const id = JSON.parse(FakeSocket.last?.sent[0] ?? "{}").id

    FakeSocket.last?.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }) })
    await expect(pending).resolves.toEqual({ ok: true })

    expect(daemon.pendingRequests()).toBe(0)
    await vi.advanceTimersByTimeAsync(requestTimeoutMs("workspace.get") * 2)
    expect(daemon.pendingRequests()).toBe(0)
  })
})
