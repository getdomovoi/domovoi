import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TransportCandidate } from "@getdomovoi/protocol"

import { Deadline } from "./deadline.js"
import { connectMachineClient } from "./machine-client.js"
import { completeHandshake, installFakeWebSocket } from "./test-support/fake-websocket.js"

const loopback: TransportCandidate = {
  kind: "local",
  endpoint: "ws://127.0.0.1:47831/rpc",
  authenticated: true,
}
const lan: TransportCandidate = {
  kind: "lan",
  endpoint: "wss://workshop.local:47831/rpc",
  authenticated: true,
}
const tailnet: TransportCandidate = {
  kind: "tailnet",
  endpoint: "wss://workshop.tailnet:47831/rpc",
  authenticated: true,
}

const credential = "n".repeat(43)
const budgets = { connectMs: 1_000, requestMs: 5_000 }

function fakeClients(failing: string[] = [], stalling: Record<string, number> = {}) {
  const created: { url: string; authToken: string | undefined; disconnected: boolean; remainingMs: number }[] = []
  const createClient = vi.fn((url: string, _kind: unknown, options: { authToken?: string }) => {
    const record = { url, authToken: options.authToken, disconnected: false, remainingMs: -1 }
    created.push(record)
    return {
      url,
      connect: async (deadline: Deadline) => {
        record.remainingMs = deadline.remainingMs()
        const stall = stalling[url]
        if (stall !== undefined) await vi.advanceTimersByTimeAsync(stall)
        if (failing.includes(url)) throw new Error("ECONNREFUSED")
        return { protocolVersion: "0.1.0" }
      },
      disconnect: () => {
        record.disconnected = true
      },
    }
  })
  return { created, createClient }
}

describe("connectMachineClient", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("gives each route its share without renewing the overall deadline", async () => {
    const { created, createClient } = fakeClients([lan.endpoint], { [lan.endpoint]: 800 })
    const deadline = Deadline.start(1_000)

    const connected = await connectMachineClient({
      candidates: [tailnet, lan],
      credential,
      kind: "desktop",
      budgets,
      deadline,
      createClient: createClient as never,
    })

    expect(connected.transport).toEqual(tailnet)
    expect(created[0]).toMatchObject({ url: lan.endpoint, remainingMs: 500 })
    expect(created[1]).toMatchObject({ url: tailnet.endpoint, remainingMs: 200 })
    deadline.clear()
  })

  it("closes a silent route before fallback and cancels its reconnect", async () => {
    const sockets = installFakeWebSocket()
    const deadline = Deadline.start(1_000)
    const opening = connectMachineClient({ candidates: [lan, tailnet], credential, kind: "desktop", budgets, deadline })
    // Observe failures immediately, including when a removed guard spends the whole budget.
    const outcome = opening.catch((error: unknown) => error)
    try {
      sockets.socket(0).open()
      await vi.advanceTimersByTimeAsync(500)
      expect(sockets.sockets).toHaveLength(2)
      expect(sockets.socket(0).closeCalls.length).toBeGreaterThan(0)
      expect(sockets.socket(0).readyState).toBe(sockets.socket(0).CLOSED)
      completeHandshake(sockets.socket(1))
      const connected = await opening
      expect(connected.transport).toEqual(tailnet)
      expect(vi.getTimerCount()).toBe(1)
      // An abandoned hello and its scheduled reconnect must not revive route one.
      completeHandshake(sockets.socket(0))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sockets.sockets).toHaveLength(2)
      connected.client.disconnect()
    } finally {
      await vi.advanceTimersByTimeAsync(1_000)
      await outcome
      deadline.clear()
      sockets.uninstall()
    }
  })

  it("rejects a late route result even before the timer callback runs", async () => {
    const deadline = Deadline.start(1_000)
    const { created, createClient } = fakeClients()
    createClient.mockImplementationOnce((url, _kind, options) => ({
      url,
      connect: async () => { vi.setSystemTime(Date.now() + 600) },
      disconnect: () => { created.push({ url, authToken: options.authToken, disconnected: true, remainingMs: 0 }) },
    }) as never)
    try {
      const connected = await connectMachineClient({
        candidates: [lan, tailnet], credential, kind: "desktop", budgets, deadline,
        createClient: createClient as never,
      })
      expect(connected.transport).toEqual(tailnet)
      expect(created[0]).toMatchObject({ url: lan.endpoint, disconnected: true })
      expect(created[1]).toMatchObject({ url: tailnet.endpoint, remainingMs: 400 })
      expect(vi.getTimerCount()).toBe(1)
    } finally { deadline.clear() }
  })

  it("does not create a socket after clock expiry with a queued timer", async () => {
    const deadline = Deadline.start(1_000)
    const { createClient } = fakeClients()
    vi.setSystemTime(Date.now() + 1_000)
    try {
      await expect(connectMachineClient({
        candidates: [lan, tailnet], credential, kind: "desktop", budgets, deadline,
        createClient: createClient as never,
      })).rejects.toThrow("No transport reached that machine")
      expect(createClient).not.toHaveBeenCalled()
    } finally { deadline.clear() }
  })

  it("dials no further candidate once the deadline has run out", async () => {
    const { created, createClient } = fakeClients([lan.endpoint], { [lan.endpoint]: 1_000 })
    const deadline = Deadline.start(1_000)

    await expect(connectMachineClient({
      candidates: [tailnet, lan],
      credential,
      kind: "desktop",
      budgets,
      deadline,
      createClient: createClient as never,
    })).rejects.toThrow("No transport reached that machine (tried lan, tailnet)")
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ url: lan.endpoint, disconnected: true })
  })

  it("connects over the most private reachable endpoint", async () => {
    const { created, createClient } = fakeClients()

    const connected = await connectMachineClient({
      candidates: [tailnet, loopback],
      credential,
      kind: "desktop",
      budgets,
      deadline: Deadline.start(10_000),
      createClient: createClient as never,
    })

    expect(connected.transport).toEqual(loopback)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ url: loopback.endpoint, authToken: credential })
  })

  it("closes a client that could not connect before trying the next", async () => {
    const { created, createClient } = fakeClients([lan.endpoint])

    const connected = await connectMachineClient({
      candidates: [tailnet, lan],
      credential,
      kind: "desktop",
      budgets,
      deadline: Deadline.start(10_000),
      createClient: createClient as never,
    })

    expect(connected.transport).toEqual(tailnet)
    expect(created[0]).toMatchObject({ url: lan.endpoint, disconnected: true })
    expect(created[1]).toMatchObject({ url: tailnet.endpoint, disconnected: false })
  })

  it("never builds a client for an unencrypted remote endpoint", async () => {
    const { created, createClient } = fakeClients()
    const plaintextRemote: TransportCandidate = {
      kind: "lan",
      endpoint: "ws://workshop.local:47831/rpc",
      authenticated: true,
    }

    await expect(connectMachineClient({
      candidates: [plaintextRemote],
      credential,
      kind: "desktop",
      budgets,
      deadline: Deadline.start(10_000),
      createClient: createClient as never,
    })).rejects.toThrow("Refusing to authenticate over an unencrypted lan transport")
    expect(created).toHaveLength(0)
  })

  it("never builds a client without a credential", async () => {
    const { created, createClient } = fakeClients()

    await expect(connectMachineClient({
      candidates: [loopback],
      credential: "",
      kind: "desktop",
      budgets,
      deadline: Deadline.start(10_000),
      createClient: createClient as never,
    })).rejects.toThrow("A transport credential is required")
    expect(created).toHaveLength(0)
  })

  it("leaves no client open when nothing connects", async () => {
    const { created, createClient } = fakeClients([lan.endpoint, tailnet.endpoint])

    await expect(connectMachineClient({
      candidates: [lan, tailnet],
      credential,
      kind: "desktop",
      budgets,
      deadline: Deadline.start(10_000),
      createClient: createClient as never,
    })).rejects.toThrow("No transport reached that machine")
    expect(created).toHaveLength(2)
    expect(created.every((client) => client.disconnected)).toBe(true)
  })
})
