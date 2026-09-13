import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

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

function connection(handlers: {
  onFleet?: (entries: unknown[]) => void
  onSnapshot?: (snapshot: unknown) => void
  onHello?: (snapshot: unknown) => void
} = {}) {
  return new DaemonConnection("ws://desk:8787", "token", {
    onSnapshot: handlers.onSnapshot ?? (() => {}),
    ...(handlers.onHello ? { onHello: handlers.onHello } : {}),
    onDelta: () => {},
    onFleet: handlers.onFleet ?? (() => {}),
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

describe("DaemonConnection notifications", () => {
  const entries = [{ kind: "unenrolled", machineId: `machine-${"a".repeat(32)}` }]

  it("hands on a fleet the daemon pushed, so an open list stops going stale", () => {
    const socket = withSocket(() => {})
    const onFleet = vi.fn()
    const daemon = connection({ onFleet })
    daemon.connect()
    try {
      socket.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", method: "fleet.changed", params: { entries } }),
      })
      expect(onFleet).toHaveBeenCalledWith(entries)
    } finally { daemon.close() }
  })

  it("drops a pushed fleet it cannot read rather than passing on a shape", () => {
    const socket = withSocket(() => {})
    const onFleet = vi.fn()
    const daemon = connection({ onFleet })
    daemon.connect()
    try {
      socket.onmessage?.({
        data: JSON.stringify({
          jsonrpc: "2.0",
          method: "fleet.changed",
          params: { entries: [{ kind: "unenrolled", machineId: "not-a-machine-id" }] },
        }),
      })
      expect(onFleet).not.toHaveBeenCalled()
    } finally { daemon.close() }
  })

  it("announces a hello only when the daemon answered it, never for a snapshot pushed before", async () => {
    const sent: string[] = []
    const socket = withSocket((payload) => { sent.push(payload) })
    const onSnapshot = vi.fn()
    const onHello = vi.fn()
    const daemon = connection({ onSnapshot, onHello })
    daemon.connect()
    try {
      socket.onopen?.()
      // A snapshot that arrives as a notification before the greeting is
      // answered updates the screen and proves nothing about the token.
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: demoWorkspace }) })
      expect(onSnapshot).toHaveBeenCalledTimes(1)
      expect(onHello).not.toHaveBeenCalled()
      const hello = JSON.parse(sent[0]!) as { id: number }
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: demoWorkspace }) })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onHello).toHaveBeenCalledTimes(1)
      expect(onSnapshot).toHaveBeenCalledTimes(2)
    } finally { daemon.close() }
  })
})
