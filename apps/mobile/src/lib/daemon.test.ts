import { afterEach, describe, expect, it, vi } from "vitest"

import { DaemonConnection } from "./daemon"

vi.mock("@getdomovoi/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("@getdomovoi/protocol")>(),
  buildVersion: "9.8.7-test",
}))

type FakeSocket = {
  readyState: number
  send: (payload: string) => void
  close: () => void
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  onclose?: () => void
}

const original = Reflect.get(globalThis, "WebSocket") as unknown

function withSocket(send: (payload: string) => void): FakeSocket {
  const socket: FakeSocket = { readyState: 1, send, close: () => {} }
  Reflect.set(globalThis, "WebSocket", function FakeWebSocket(this: unknown) {
    return socket
  })
  return socket
}

function connection() {
  return new DaemonConnection("ws://desk:8787", "token", {
    onSnapshot: () => {},
    onDelta: () => {},
    onStatus: () => {},
    onError: () => {},
    onClosed: () => {},
  })
}

afterEach(() => {
  Reflect.set(globalThis, "WebSocket", original)
  vi.restoreAllMocks()
})

describe("DaemonConnection.call", () => {
  it("greets with the build version supplied by this release", () => {
    const send = vi.fn()
    const socket = withSocket(send)
    const daemon = connection()
    daemon.connect()
    try {
      socket.onopen?.()
      expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
        method: "system.hello", params: { client: "phone", clientVersion: "9.8.7-test" },
      })
    } finally { daemon.close() }
  })

  it("holds one pending request per call that was sent", async () => {
    withSocket(() => {})
    const daemon = connection()
    daemon.connect()

    const first = daemon.call("workspace.get", {})

    expect(daemon.pendingRequests()).toBe(1)

    // Settle it so the rejection is observed rather than left unhandled.
    daemon.close()
    void first.catch(() => {})
  })

  it("keeps nothing pending for a request the socket refused to send", async () => {
    withSocket(() => {
      throw new Error("INVALID_STATE_ERR")
    })
    const daemon = connection()
    daemon.connect()

    await expect(daemon.call("workspace.get", {})).rejects.toThrow("INVALID_STATE_ERR")
    // The entry is cleared by call itself. Leaving it for onclose would make
    // this class correct only for as long as that handler keeps doing it.
    expect(daemon.pendingRequests()).toBe(0)
  })

  it("rejects without a socket at all rather than queueing", async () => {
    const daemon = connection()

    await expect(daemon.call("workspace.get", {})).rejects.toThrow("not open")
    expect(daemon.pendingRequests()).toBe(0)
  })
})
