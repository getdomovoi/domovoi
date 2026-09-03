import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, workspaceDeltaSchema } from "@getdomovoi/protocol"

import {
  completeHandshake,
  FakeWebSocket,
  installFakeWebSocket,
  notify,
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
    expect(first.sent).toHaveLength(1)
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

    await drive(() => vi.advanceTimersByTime(backoffCeilingMs))
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
