import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { activeSessionCount, Thread } from "./workspace-shell.js"

afterEach(cleanup)

const handlers = {
  onResolve: vi.fn(async () => {}),
  onSetRuntime: vi.fn(async () => {}),
  onForkSession: vi.fn(async () => {}),
  onListModels: vi.fn(async () => []),
  onNewSession: vi.fn(),
  onSend: vi.fn(async () => {}),
  onCheckpoint: vi.fn(async () => {}),
  onRestoreCheckpoint: vi.fn(async () => {}),
  onPauseSession: vi.fn(async () => {}),
  onArchiveSession: vi.fn(async () => {}),
}

it("opens the device menu from the composer machine chip", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  render(
    <Thread
      snapshot={snapshot}
      connected
      fleet={[{
        id: `machine-${"a".repeat(32)}`,
        label: snapshot.machine.name,
        platform: snapshot.machine.platform,
        arch: snapshot.machine.arch,
        version: snapshot.machine.version,
        connection: "local",
        capabilities: ["sessions" as const],
        protocolVersion: "0.1.0",
        transports: [
          { kind: "local" as const, endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true as const },
        ],
        heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
        health: "healthy",
        self: true,
      }]}
      currentMachineId={`machine-${"a".repeat(32)}`}
      {...handlers}
    />,
  )

  await user.click(screen.getByRole("button", { name: new RegExp(snapshot.machine.name) }))

  expect(screen.getByRole("menuitem", { name: new RegExp(snapshot.machine.name) }).textContent)
    .toContain("This machine")
})

it("counts only sessions with work in flight", () => {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.sessions = [
    { ...snapshot.sessions[0]!, id: "session-active", state: "active" },
    { ...snapshot.sessions[0]!, id: "session-waiting", state: "waiting" },
    { ...snapshot.sessions[0]!, id: "session-idle", state: "idle" },
    { ...snapshot.sessions[0]!, id: "session-archived", state: "archived" },
  ]

  expect(activeSessionCount(snapshot)).toBe(2)
})

it("keeps naming the machine when the fleet has not loaded", () => {
  const snapshot = structuredClone(demoWorkspace)
  render(<Thread snapshot={snapshot} connected {...handlers} />)

  expect(screen.getByRole("button", { name: new RegExp(snapshot.machine.name) })).toBeTruthy()
})

it("pairs a machine from the composer device menu", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const onPairMachine = vi.fn(async () => ({
    machineId: `machine-${"c".repeat(32)}`,
    label: "workshop",
  }))
  render(
    <Thread
      snapshot={snapshot}
      connected
      currentMachineId={snapshot.machine.id}
      onPairMachine={onPairMachine}
      {...handlers}
    />,
  )

  await user.click(screen.getByRole("button", { name: new RegExp(snapshot.machine.name) }))
  await user.click(screen.getByRole("menuitem", { name: "+ Pair a machine" }))
  await user.type(screen.getByLabelText("Machine address"), "wss://workshop.tailnet:47831/rpc")
  await user.type(screen.getByLabelText("Pairing code"), "hearth-quiet-ember-42")
  await user.type(screen.getByLabelText("Name for this device"), "studio-ipad")
  await user.click(screen.getByRole("button", { name: "Pair machine" }))

  expect(onPairMachine).toHaveBeenCalledWith({
    endpoint: "wss://workshop.tailnet:47831/rpc",
    code: "hearth-quiet-ember-42",
    label: "studio-ipad",
  })
})

it("selects another machine from the composer device menu", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const onSelectMachine = vi.fn()
  const studio = {
    id: `machine-${"b".repeat(32)}`,
    label: "studio",
    platform: "linux",
    arch: "x64",
    version: snapshot.machine.version,
    connection: "tailnet" as const,
    capabilities: ["sessions" as const],
    protocolVersion: "0.1.0" as const,
    transports: [
      { kind: "tailnet" as const, endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true as const },
    ],
    heartbeat: { state: "online" as const, lastSeenAt: "2026-08-31T12:00:00.000Z" },
    health: "healthy" as const,
    self: false,
  }
  render(
    <Thread
      snapshot={snapshot}
      connected
      fleet={[{
        id: snapshot.machine.id,
        label: snapshot.machine.name,
        platform: snapshot.machine.platform,
        arch: snapshot.machine.arch,
        version: snapshot.machine.version,
        connection: "local" as const,
        capabilities: ["sessions" as const],
        protocolVersion: "0.1.0" as const,
        transports: [
          { kind: "local" as const, endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true as const },
        ],
        heartbeat: { state: "online" as const, lastSeenAt: "2026-08-31T12:00:00.000Z" },
        health: "healthy" as const,
        self: true,
      }, studio]}
      currentMachineId={snapshot.machine.id}
      onSelectMachine={onSelectMachine}
      {...handlers}
    />,
  )

  await user.click(screen.getByRole("button", { name: new RegExp(snapshot.machine.name) }))
  await user.click(screen.getByRole("menuitem", { name: /studio/ }))

  expect(onSelectMachine).toHaveBeenCalledWith(studio.id)
})
