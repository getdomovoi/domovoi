import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

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
        heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
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

it("keeps naming the machine when the fleet has not loaded", () => {
  const snapshot = structuredClone(demoWorkspace)
  render(<Thread snapshot={snapshot} connected {...handlers} />)

  expect(screen.getByRole("button", { name: new RegExp(snapshot.machine.name) })).toBeTruthy()
})
