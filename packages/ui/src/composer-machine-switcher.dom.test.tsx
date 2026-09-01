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
        capabilities: ["sessions"],
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
