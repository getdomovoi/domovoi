import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, fleetSnapshotOverflowErrorCode, maximumFleetEntries, protocolVersion, workspaceDeltaSchema } from "@getdomovoi/protocol"

import {
  completeHandshake,
  fail,
  FakeWebSocket,
  installFakeWebSocket,
  notify,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"
import { useWorkspace } from "./use-workspace"

const daemonUrl = "ws://127.0.0.1:47831/rpc"
const otherDaemonUrl = "ws://10.0.0.2:47831/rpc"
const backoffCeilingMs = 60_000

type ProbeProps = { url: string; authToken?: string }

function useProbe({ url, authToken }: ProbeProps) {
  return useWorkspace(url, "web", authToken)
}

function mountWorkspace(initialProps: ProbeProps = { url: daemonUrl }) {
  return renderHook(useProbe, { initialProps })
}

const drive = (run: () => void) => act(async () => {
  run()
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

let harness: FakeWebSocketHarness

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.useRealTimers()
})

describe("useWorkspace connection lifecycle", () => {
  it("opens one socket per target and installs the handshake snapshot", async () => {
    const view = mountWorkspace({ url: daemonUrl, authToken: "device-token" })
    expect(harness.sockets.map((socket) => socket.url)).toEqual([daemonUrl])
    expect(view.result.current.snapshot).toBeNull()
    expect(view.result.current.connected).toBe(false)

    const socket = harness.socket(0)
    expect(socket.sent).toHaveLength(0)
    const snapshot = workspaceSnapshot()
    await drive(() => completeHandshake(socket, snapshot))

    expect(sentRequests(socket, "system.hello")).toHaveLength(1)
    expect(sentRequests(socket, "system.hello")[0]?.params).toMatchObject({
      client: "web",
      clientId: view.result.current.terminalClientId,
      authToken: "device-token",
    })
    expect(view.result.current.snapshot).toEqual(snapshot)
    expect(view.result.current.connected).toBe(true)

    view.rerender({ url: daemonUrl, authToken: "device-token" })
    expect(harness.sockets).toHaveLength(1)
    expect(sentRequests(socket, "system.hello")).toHaveLength(1)
    expect(socket.closeCalls).toEqual([])
  })

  it("closes the previous socket and forgets its snapshot when the target changes", async () => {
    const view = mountWorkspace()
    const first = harness.socket(0)
    await drive(() => completeHandshake(first))
    expect(view.result.current.connected).toBe(true)

    view.rerender({ url: otherDaemonUrl })
    expect(first.closeCalls).toEqual([{ code: 1000, reason: "client closed" }])
    expect(harness.sockets.map((socket) => socket.url)).toEqual([daemonUrl, otherDaemonUrl])
    expect(view.result.current.snapshot).toBeNull()
    expect(view.result.current.connected).toBe(false)

    const second = harness.socket(1)
    await drive(() => completeHandshake(second, workspaceSnapshot({
      machine: { ...demoWorkspace.machine, name: "other-box" },
    })))
    expect(view.result.current.snapshot?.machine.name).toBe("other-box")
    expect(view.result.current.connected).toBe(true)
  })

  it("reconnect() after a dropped connection opens one fresh socket with the same identity", async () => {
    const view = mountWorkspace()
    const first = harness.socket(0)
    await drive(() => completeHandshake(first))
    const clientId = view.result.current.terminalClientId

    await drive(() => first.drop(1006, "daemon restarted"))
    expect(view.result.current.connected).toBe(false)
    expect(harness.sockets).toHaveLength(1)

    let reconnecting!: Promise<void>
    await drive(() => {
      reconnecting = view.result.current.reconnect()
      completeHandshake(harness.socket(1), workspaceSnapshot({
        machine: { ...demoWorkspace.machine, name: "macbook-after-restart" },
      }))
    })
    await reconnecting

    expect(harness.sockets.map((socket) => socket.url)).toEqual([daemonUrl, daemonUrl])
    expect(sentRequests(first, "system.hello")).toHaveLength(1)
    expect(sentRequests(harness.socket(1), "system.hello")[0]?.params).toMatchObject({ clientId })
    expect(view.result.current.terminalClientId).toBe(clientId)
    expect(view.result.current.connected).toBe(true)
    expect(view.result.current.snapshot?.machine.name).toBe("macbook-after-restart")

    await drive(() => vi.advanceTimersByTime(backoffCeilingMs))
    expect(harness.sockets).toHaveLength(2)
  })

  it("reconnect() refuses to open a duplicate socket while the current one is open", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))

    let outcome!: Promise<unknown>
    await drive(() => {
      outcome = view.result.current.reconnect().then(() => "reconnected", (cause: unknown) => cause)
    })

    expect(harness.sockets).toHaveLength(1)
    expect(socket.closeCalls).toEqual([])
    expect(sentRequests(socket, "system.hello")).toHaveLength(1)
    expect(await outcome).toEqual(new Error("Daemon connection is already open"))
  })

  it("applies workspace.delta notifications to the installed snapshot", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    const snapshot = workspaceSnapshot()
    const sessionId = "session-billing"
    const streamedAt = "2026-09-02T10:00:00.000Z"
    const delta = workspaceDeltaSchema.parse({
      sessionId,
      updatedAt: streamedAt,
      operations: [{ kind: "assistant.append", id: "assistant-live", delta: "Replaying ", createdAt: streamedAt }],
    })
    const continuation = workspaceDeltaSchema.parse({
      sessionId,
      updatedAt: "2026-09-02T10:00:01.000Z",
      operations: [{ kind: "assistant.append", id: "assistant-live", delta: "webhooks", createdAt: streamedAt }],
    })
    const streamed = () => view.result.current.snapshot?.thread.find((item) => item.id === "assistant-live")

    await drive(() => {
      socket.open()
      notify(socket, "workspace.delta", delta)
    })
    expect(view.result.current.snapshot).toBeNull()

    await drive(() => completeHandshake(socket, snapshot))
    expect(streamed()).toBeUndefined()

    await drive(() => notify(socket, "workspace.delta", delta))
    expect(streamed()).toMatchObject({ kind: "assistant", sessionId, body: "Replaying " })
    expect(view.result.current.snapshot?.sessions.find((session) => session.id === sessionId)?.updatedAt)
      .toBe(streamedAt)

    await drive(() => notify(socket, "workspace.delta", continuation))
    expect(streamed()).toMatchObject({ kind: "assistant", body: "Replaying webhooks" })
    expect(view.result.current.snapshot?.sessions.find((session) => session.id === sessionId)?.updatedAt)
      .toBe(continuation.updatedAt)
  })

  it("closes the socket on unmount and never reconnects", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))
    expect(view.result.current.connected).toBe(true)

    view.unmount()
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "client closed" }])
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)

    await drive(() => vi.advanceTimersByTime(backoffCeilingMs))
    expect(harness.sockets).toHaveLength(1)
  })

  it("closes a socket that is still connecting on unmount", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING)

    view.unmount()
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "client closed" }])

    await drive(() => socket.open())
    expect(socket.sent).toHaveLength(0)
    expect(harness.sockets).toHaveLength(1)
  })

  it("retries with back-off after an unexpected close", async () => {
    const view = mountWorkspace()
    const first = harness.socket(0)
    await drive(() => completeHandshake(first))
    const clientId = view.result.current.terminalClientId

    await drive(() => first.drop(1006, "daemon restarted"))
    expect(view.result.current.connected).toBe(false)
    expect(harness.sockets).toHaveLength(1)

    // The next attempt is bounded like the first, so time moves only to the
    // backoff timer rather than past the connect budget of the retry.
    await drive(() => vi.advanceTimersToNextTimer())
    expect(harness.sockets.map((socket) => socket.url)).toEqual([daemonUrl, daemonUrl])

    const second = harness.socket(1)
    await drive(() => completeHandshake(second))
    expect(sentRequests(second, "system.hello")[0]?.params).toMatchObject({ clientId })
    expect(view.result.current.connected).toBe(true)
    expect(view.result.current.snapshot).not.toBeNull()
  })

  it("stops reconnecting once the daemon revokes the device", async () => {
    const view = mountWorkspace({ url: daemonUrl, authToken: "revoked-token" })
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))
    expect(view.result.current.connected).toBe(true)

    await drive(() => socket.drop(1008, "device credential revoked"))
    expect(view.result.current.connected).toBe(false)

    await drive(() => vi.advanceTimersByTime(backoffCeilingMs))
    expect(harness.sockets).toHaveLength(1)
    expect(view.result.current.connected).toBe(false)
  })
})

describe("useWorkspace fleet", () => {
  const machineId = `machine-${"c".repeat(32)}`
  const unenrolled = { entries: [{ kind: "unenrolled" as const, machineId }] }
  const remote = {
    id: machineId,
    label: "workshop",
    platform: "linux",
    arch: "x64",
    version: "0.4.2",
    capabilities: ["sessions" as const],
    protocolVersion,
    transports: [],
    connection: "direct" as const,
    verifiedRoute: {
      endpoint: "wss://workshop.tailnet:47831/rpc",
      lastAuthenticatedAt: "2026-09-04T12:00:00.000Z",
    },
    heartbeat: { state: "online" as const, lastSeenAt: "2026-09-04T12:00:00.000Z" },
    health: "healthy" as const,
    self: false,
  }
  const enrolledFleet = { entries: [{ kind: "machine" as const, machine: remote }] }

  it("holds no fleet before the daemon has listed one", () => {
    const view = mountWorkspace()
    expect(view.result.current.fleet).toBeNull()
    expect(view.result.current.fleetOverflow).toBeNull()
  })

  it("keeps the daemon's overflow verdict when it withholds the list", async () => {
    const overflow = { kind: "fleet-overflow", limit: maximumFleetEntries, totalEntries: 600, entriesNotShown: 600 }
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))

    await drive(() => fail(socket, "fleet.list", {
      code: fleetSnapshotOverflowErrorCode,
      message: "Fleet keyring exceeds the wire limit",
      data: overflow,
    }))

    expect(view.result.current.fleet).toBeNull()
    expect(view.result.current.fleetOverflow).toEqual(overflow)

    await drive(() => notify(socket, "fleet.changed", { entries: [] }))
    expect(view.result.current.fleetOverflow).toBeNull()
    expect(view.result.current.fleet).toEqual({ entries: [] })
  })

  it("does not read any other listing failure as an overflow", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))

    await drive(() => fail(socket, "fleet.list", { code: -32603, message: "fleet-overflow" }))

    expect(view.result.current.fleet).toBeNull()
    expect(view.result.current.fleetOverflow).toBeNull()
  })

  it("lists the fleet as soon as the handshake lands and installs the answer", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))

    expect(sentRequests(socket, "fleet.list")).toHaveLength(1)
    await drive(() => respond(socket, "fleet.list", unenrolled))

    expect(view.result.current.fleet).toEqual(unenrolled)
  })

  it("replaces the fleet when the daemon says it changed", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))
    await drive(() => respond(socket, "fleet.list", { entries: [] }))

    await drive(() => notify(socket, "fleet.changed", unenrolled))

    expect(view.result.current.fleet).toEqual(unenrolled)
  })

  it("lists again on every reconnect instead of trusting what it held", async () => {
    const view = mountWorkspace()
    const first = harness.socket(0)
    await drive(() => completeHandshake(first))
    await drive(() => respond(first, "fleet.list", unenrolled))
    expect(view.result.current.fleet).toEqual(unenrolled)

    await drive(() => first.drop(1006, "daemon restarted"))
    await drive(() => vi.advanceTimersToNextTimer())
    const second = harness.socket(1)
    await drive(() => completeHandshake(second))

    expect(sentRequests(second, "fleet.list")).toHaveLength(1)
    await drive(() => respond(second, "fleet.list", { entries: [] }))
    expect(view.result.current.fleet).toEqual({ entries: [] })
  })

  it("pairs through one fleet.enroll request and installs the fleet it returns", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))
    await drive(() => respond(socket, "fleet.list", { entries: [] }))

    let paired!: Promise<unknown>
    await drive(() => {
      paired = view.result.current.pairMachine({
        endpoint: "wss://workshop.tailnet:47831/rpc",
        code: "hearth-quiet-ember-42",
        label: "studio-desktop",
      })
    })
    const requests = sentRequests(socket, "fleet.enroll")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.params).toEqual({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code: "hearth-quiet-ember-42",
      sourceDeviceLabel: "studio-desktop",
      client: "web",
    })
    expect(sentRequests(socket, "device.claim")).toHaveLength(0)
    expect(sentRequests(socket, "system.hello")).toHaveLength(1)

    await drive(() => respond(socket, "fleet.enroll", { outcome: "enrolled", machineId, fleet: enrolledFleet }))

    await expect(paired).resolves.toMatchObject({ outcome: "enrolled", machineId, label: "workshop" })
    expect(view.result.current.fleet).toEqual(enrolledFleet)
  })

  it("forgets through fleet.forget and installs the fleet it returns", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))
    await drive(() => respond(socket, "fleet.list", enrolledFleet))

    let forgotten!: Promise<unknown>
    await drive(() => {
      forgotten = view.result.current.forgetMachine({ machineId })
    })
    expect(sentRequests(socket, "fleet.forget")[0]?.params).toEqual({ machineId, client: "web" })

    await drive(() => respond(socket, "fleet.forget", {
      outcome: "forgotten",
      machineId,
      remoteRevocation: "unconfirmed",
      fleet: { entries: [] },
    }))

    await expect(forgotten).resolves.toMatchObject({ outcome: "forgotten", remoteRevocation: "unconfirmed" })
    expect(view.result.current.fleet).toEqual({ entries: [] })
  })

  it("keeps the fleet it holds when a forget is refused", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))
    await drive(() => respond(socket, "fleet.list", enrolledFleet))

    let refused!: Promise<unknown>
    await drive(() => {
      refused = view.result.current.forgetMachine({ machineId })
    })
    await drive(() => respond(socket, "fleet.forget", { outcome: "refused", reason: "operation-in-progress" }))

    await expect(refused).resolves.toEqual({ outcome: "refused", reason: "operation-in-progress" })
    expect(view.result.current.fleet).toEqual(enrolledFleet)
  })
})

describe("useWorkspace endpoint resolution", () => {
  it("resolves the endpoint before every dial, including reconnect()", async () => {
    const endpoints = [
      { url: daemonUrl, token: "first-token" },
      { url: otherDaemonUrl, token: "second-token" },
    ]
    const resolveRpcEndpoint = vi.fn(async () => endpoints.shift() ?? { url: otherDaemonUrl, token: "second-token" })
    const view = renderHook(() => useWorkspace(daemonUrl, "desktop", "stale-token", resolveRpcEndpoint))
    expect(harness.sockets).toHaveLength(0)
    await drive(() => {})

    const first = harness.socket(0)
    expect(first.url).toBe(daemonUrl)
    await drive(() => completeHandshake(first))
    expect(sentRequests(first, "system.hello")[0]?.params).toMatchObject({ authToken: "first-token" })
    expect(view.result.current.connected).toBe(true)
    expect(view.result.current.endpointUrl).toBe(daemonUrl)

    await drive(() => first.drop(1006, "daemon restarted"))
    expect(view.result.current.connected).toBe(false)

    let reconnecting!: Promise<void>
    await drive(() => { reconnecting = view.result.current.reconnect() })
    const second = harness.socket(1)
    expect(second.url).toBe(otherDaemonUrl)
    await drive(() => completeHandshake(second))
    await reconnecting

    expect(sentRequests(second, "system.hello")[0]?.params).toMatchObject({ authToken: "second-token" })
    expect(resolveRpcEndpoint).toHaveBeenCalledTimes(2)
    expect(view.result.current.connected).toBe(true)
    expect(view.result.current.endpointUrl).toBe(otherDaemonUrl)
  })

  it("surfaces a refused resolution as the reconnect failure without dialing", async () => {
    const resolveRpcEndpoint = vi.fn<() => Promise<{ url: string; token: string }>>()
      .mockResolvedValueOnce({ url: daemonUrl, token: "first-token" })
      .mockRejectedValueOnce(new Error("The profile has no reachable owner."))
    const view = renderHook(() => useWorkspace(daemonUrl, "desktop", undefined, resolveRpcEndpoint))
    await drive(() => {})
    const first = harness.socket(0)
    await drive(() => completeHandshake(first))
    await drive(() => first.drop(1006, "daemon stopped"))

    let outcome!: Promise<unknown>
    await drive(() => {
      outcome = view.result.current.reconnect().then(() => "reconnected", (cause: unknown) => cause)
    })

    expect(await outcome).toEqual(new Error("The profile has no reachable owner."))
    expect(harness.sockets).toHaveLength(1)
    expect(view.result.current.connected).toBe(false)
    expect(view.result.current.endpointUrl).toBe(daemonUrl)
  })
})

describe("useWorkspace skill catalog requests", () => {
  it("cancels a skill catalog refresh through the signal it was given", async () => {
    const view = mountWorkspace()
    const socket = harness.socket(0)
    await drive(() => completeHandshake(socket))
    const controller = new AbortController()
    const outcomes: string[] = []

    const listing = view.result.current.listSkills({ signal: controller.signal })
    const inventory = view.result.current.getSkillInventory({ signal: controller.signal })
    void listing.catch((cause: unknown) => outcomes.push(cause instanceof Error ? cause.name : "unknown"))
    void inventory.catch((cause: unknown) => outcomes.push(cause instanceof Error ? cause.name : "unknown"))
    expect(sentRequests(socket, "skill.list")).toHaveLength(1)
    expect(sentRequests(socket, "skill.inventory")).toHaveLength(1)

    await drive(() => controller.abort())
    expect(outcomes).toEqual(["AbortError", "AbortError"])
  })
})
