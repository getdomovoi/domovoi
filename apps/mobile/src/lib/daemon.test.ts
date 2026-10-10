import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, terminalWatchResultSchema } from "@getdomovoi/protocol"

import { DaemonConnection, DaemonError, DaemonNotSentError, DaemonProtocolError, DaemonUnconfirmedError, watchTerminal, type TerminalWatchCall } from "./daemon"

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
  onTerminal?: (notification: unknown) => void
} = {}) {
  return new DaemonConnection("ws://desk:8787", "token", "phone", {
    onSnapshot: handlers.onSnapshot ?? (() => {}),
    ...(handlers.onHello ? { onHello: handlers.onHello } : {}),
    ...(handlers.onTerminal ? { onTerminal: handlers.onTerminal } : {}),
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

  // Phone v2 frame 04: a watched terminal's output, its end and its claim
  // reach the phone as notifications, after terminal.watch.
  it("hands on a watched terminal's output, its end and a move of its claim", () => {
    const socket = withSocket(() => {})
    const onTerminal = vi.fn()
    const daemon = connection({ onTerminal })
    daemon.connect()
    const owner = { client: "desktop", clientId: "desktop-1", device: { id: `device-${"a".repeat(32)}`, label: "MacBook Pro" } }
    try {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "terminal.output", params: { terminalId: "terminal-1", data: "$ ls\n" } }) })
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "terminal.ownership", params: { terminalId: "terminal-1", owner } }) })
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "terminal.closed", params: { terminalId: "terminal-1", exitCode: 1 } }) })
      expect(onTerminal.mock.calls.map(([notification]) => notification)).toEqual([
        { method: "terminal.output", params: { terminalId: "terminal-1", data: "$ ls\n" } },
        { method: "terminal.ownership", params: { terminalId: "terminal-1", owner } },
        { method: "terminal.closed", params: { terminalId: "terminal-1", exitCode: 1 } },
      ])
    } finally { daemon.close() }
  })

  // #779: sent only to a watch that asked with followResize.
  it("hands on a watched terminal's new grid", () => {
    const socket = withSocket(() => {})
    const onTerminal = vi.fn()
    const onProtocolError = vi.fn()
    const daemon = connection({ onTerminal, onProtocolError })
    daemon.connect()
    try {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "terminal.resized", params: { terminalId: "terminal-1", cols: 80, rows: 24 } }) })
      expect(onTerminal.mock.calls.map(([notification]) => notification)).toEqual([
        { method: "terminal.resized", params: { terminalId: "terminal-1", cols: 80, rows: 24 } },
      ])
      expect(onProtocolError).not.toHaveBeenCalled()
    } finally { daemon.close() }
  })
})

describe("watchTerminal", () => {
  const result = terminalWatchResultSchema.parse({
    terminalId: "terminal-1",
    sessionId: "session-1",
    cols: 120,
    rows: 34,
    shell: "/bin/zsh",
    cwd: "/tmp",
    owner: { client: "desktop", clientId: "desktop-1" },
    claimHeld: true,
    openedAt: "2026-10-06T13:52:04.000Z",
    state: "live",
    buffer: "",
    earlierOutputDropped: false,
    watchedAt: "2026-10-06T14:06:12.000Z",
  })
  const refused = new DaemonError("Method parameters are invalid", -32602, undefined)
  type WatchCall = TerminalWatchCall

  it("asks to follow the holder's resizes", async () => {
    const call = vi.fn<WatchCall>(async () => result)
    await expect(watchTerminal(call, "terminal-1", () => true)).resolves.toBe(result)
    expect(call.mock.calls).toEqual([["terminal.watch", { terminalId: "terminal-1", followResize: true }]])
  })

  // A daemon from before terminal.resized refuses the field it does not know.
  it("asks again without followResize when an older daemon refuses the field", async () => {
    const call = vi.fn<WatchCall>()
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(result)
    await expect(watchTerminal(call, "terminal-1", () => true)).resolves.toBe(result)
    expect(call.mock.calls).toEqual([
      ["terminal.watch", { terminalId: "terminal-1", followResize: true }],
      ["terminal.watch", { terminalId: "terminal-1" }],
    ])
  })

  // Asked again after the person left, the watch would be no one's.
  it("does not ask again for a watch no one wants any more", async () => {
    const call = vi.fn<WatchCall>(async () => { throw refused })
    await expect(watchTerminal(call, "terminal-1", () => false)).rejects.toBe(refused)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("passes on any other failure without asking again", async () => {
    const other = new DaemonError("Terminal not found", -32602, undefined)
    const unknown = new DaemonError("Method parameters are invalid", -32000, undefined)
    for (const cause of [other, unknown, new DaemonUnconfirmedError("closed")]) {
      const call = vi.fn<WatchCall>(async () => { throw cause })
      await expect(watchTerminal(call, "terminal-1", () => true)).rejects.toBe(cause)
      expect(call).toHaveBeenCalledTimes(1)
    }
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

  it("reports terminal output it cannot read and passes none of it on", () => {
    const socket = withSocket(() => {})
    const onProtocolError = vi.fn()
    const onTerminal = vi.fn()
    const daemon = connection({ onProtocolError, onTerminal })
    daemon.connect()
    try {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "terminal.output", params: { terminalId: "terminal-1", data: "" } }) })
    } finally { daemon.close() }
    expect(onTerminal).not.toHaveBeenCalled()
    expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining("terminal.output"))
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
