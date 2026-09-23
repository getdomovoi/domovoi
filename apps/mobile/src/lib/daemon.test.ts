import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { DaemonConnection, DaemonNotSentError, DaemonProtocolError, DaemonUnconfirmedError } from "./daemon"

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
  onDelta?: (delta: unknown) => void
  onError?: (cause: unknown) => void
  onProtocolError?: (reason: string) => void
} = {}) {
  return new DaemonConnection("ws://desk:8787", "token", "phone", {
    onSnapshot: handlers.onSnapshot ?? (() => {}),
    ...(handlers.onHello ? { onHello: handlers.onHello } : {}),
    onDelta: handlers.onDelta ?? (() => {}),
    onFleet: handlers.onFleet ?? (() => {}),
    onStatus: () => {},
    onError: handlers.onError ?? (() => {}),
    onProtocolError: handlers.onProtocolError ?? (() => {}),
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

  it("greets as the kind the credential was paired as", () => {
    const send = vi.fn()
    const socket = withSocket(send)
    const daemon = new DaemonConnection("ws://desk:8787", "token", "tablet", {
      onSnapshot: () => {}, onDelta: () => {}, onFleet: () => {}, onStatus: () => {},
      onError: () => {}, onProtocolError: () => {}, onClosed: () => {},
    })
    daemon.connect()
    try {
      socket.onopen?.()
      expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
        method: "system.hello", params: { client: "tablet" },
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
    await expect(daemon.call("workspace.get", {})).rejects.toBeInstanceOf(DaemonNotSentError)
    // The entry is cleared by call itself. Leaving it for onclose would make
    // this class correct only for as long as that handler keeps doing it.
    expect(daemon.pendingRequests()).toBe(0)
  })

  it("rejects without a socket at all rather than queueing", async () => {
    const daemon = connection()

    await expect(daemon.call("workspace.get", {})).rejects.toThrow("not open")
    await expect(daemon.call("workspace.get", {})).rejects.toBeInstanceOf(DaemonNotSentError)
    expect(daemon.pendingRequests()).toBe(0)
  })

  // A frame that left before the socket closed may have been applied. The
  // rejection says so by its class, so a screen cannot claim "not sent" for a
  // decision the daemon may have taken.
  it("rejects a request the socket closed on as unconfirmed, not as unsent", async () => {
    const socket = withSocket(() => {})
    const daemon = connection()
    daemon.connect()
    socket.onopen?.()
    const pending = daemon.call("workspace.get", {})
    void pending.catch(() => {})
    socket.onclose?.()
    await expect(pending).rejects.toBeInstanceOf(DaemonUnconfirmedError)
    await expect(pending).rejects.toThrow("The daemon closed the connection")
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

describe("DaemonConnection messages it cannot read", () => {
  function pushed(data: string) {
    const socket = withSocket(() => {})
    const onProtocolError = vi.fn()
    const onSnapshot = vi.fn()
    const onDelta = vi.fn()
    const onFleet = vi.fn()
    const daemon = connection({ onProtocolError, onSnapshot, onDelta, onFleet })
    daemon.connect()
    try {
      socket.onmessage?.({ data })
    } finally { daemon.close() }
    return { onProtocolError, onSnapshot, onDelta, onFleet }
  }

  it("reports a frame that is not JSON rather than dropping it without a trace", () => {
    const { onProtocolError } = pushed("{not json")
    expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"))
  })

  it("reports a pushed snapshot it cannot read and keeps it off the screen", () => {
    const { onProtocolError, onSnapshot } = pushed(JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: { sessions: "none" } }))
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining("workspace.changed"))
  })

  it("reports a streamed delta it cannot read", () => {
    const { onProtocolError, onDelta } = pushed(JSON.stringify({ jsonrpc: "2.0", method: "workspace.delta", params: { sessionId: "s", operations: [] } }))
    expect(onDelta).not.toHaveBeenCalled()
    expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining("workspace.delta"))
  })

  it("reports a pushed fleet it cannot read", () => {
    const { onProtocolError, onFleet } = pushed(JSON.stringify({ jsonrpc: "2.0", method: "fleet.changed", params: { entries: [{ kind: "unenrolled", machineId: "not-a-machine-id" }] } }))
    expect(onFleet).not.toHaveBeenCalled()
    expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining("fleet.changed"))
  })

  it("refuses a hello answer that is not a snapshot instead of seeding the screen with it", async () => {
    const sent: string[] = []
    const socket = withSocket((payload) => { sent.push(payload) })
    const onSnapshot = vi.fn()
    const onHello = vi.fn()
    const onError = vi.fn()
    const onProtocolError = vi.fn()
    const daemon = connection({ onSnapshot, onHello, onError, onProtocolError })
    daemon.connect()
    try {
      socket.onopen?.()
      const hello = JSON.parse(sent[0]!) as { id: number }
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: { machine: {} } }) })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onSnapshot).not.toHaveBeenCalled()
      expect(onHello).not.toHaveBeenCalled()
      expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining("system.hello"))
      expect(onError).toHaveBeenCalledWith(expect.any(DaemonProtocolError))
    } finally { daemon.close() }
  })
})

describe("DaemonConnection results", () => {
  function answering() {
    const sent: string[] = []
    const socket = withSocket((payload) => { sent.push(payload) })
    const onProtocolError = vi.fn()
    const daemon = connection({ onProtocolError })
    daemon.connect()
    const answer = (frame: Record<string, unknown>) => {
      const request = JSON.parse(sent.at(-1)!) as { id: number }
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, ...frame }) })
    }
    return { daemon, answer, onProtocolError }
  }

  it("hands back a result only once the method's own schema accepts it", async () => {
    const { daemon, answer } = answering()
    try {
      const pending = daemon.call("workspace.get", {})
      answer({ result: demoWorkspace })
      await expect(pending).resolves.toMatchObject({ machine: { id: demoWorkspace.machine.id } })
    } finally { daemon.close() }
  })

  it("refuses a result that does not match the method's schema, and reports it", async () => {
    const { daemon, answer, onProtocolError } = answering()
    try {
      const pending = daemon.call("workspace.get", {})
      answer({ result: { sessions: "none" } })
      await expect(pending).rejects.toBeInstanceOf(DaemonProtocolError)
      expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining("workspace.get"))
    } finally { daemon.close() }
  })

  it("refuses a response frame that is not JSON-RPC, and reports it", async () => {
    const { daemon, answer, onProtocolError } = answering()
    try {
      const pending = daemon.call("workspace.get", {})
      answer({ result: demoWorkspace, unexpected: true })
      await expect(pending).rejects.toBeInstanceOf(DaemonProtocolError)
      expect(onProtocolError).toHaveBeenCalled()
    } finally { daemon.close() }
  })
})

