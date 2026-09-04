import { cleanup, render, screen } from "@testing-library/react"
import { demoWorkspace, type FleetMachine } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { TooltipProvider } from "./components/ui/tooltip"
import { SessionsSidebar } from "./workspace-shell.js"

afterEach(cleanup)

const handlers = {
  onCollapse: vi.fn(),
  onActivate: vi.fn(),
  onNewSession: vi.fn(),
  onOpenProviderSettings: vi.fn(),
}

function fleetMachine(index: number, self: boolean): FleetMachine {
  return {
    id: `machine-${String(index).repeat(32)}`,
    label: `forge-0${index}`,
    platform: "linux",
    arch: "x64",
    version: "0.0.1",
    connection: self ? "local" : "tailnet",
    capabilities: ["sessions"],
    protocolVersion: "0.1.0",
    transports: [],
    heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
    health: "healthy",
    self,
  }
}

it("names the connected machine and counts the fleet in the footer", () => {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.machine.name = "forge-02"
  snapshot.machine.connection = "tailnet"
  render(
    <TooltipProvider>
      <SessionsSidebar
        snapshot={snapshot}
        fleet={[fleetMachine(1, false), fleetMachine(2, true), fleetMachine(3, false)]}
        {...handlers}
      />
    </TooltipProvider>,
  )

  expect(screen.getByText("forge-02")).toBeTruthy()
  expect(screen.getByText("F0")).toBeTruthy()
  expect(screen.getByText("3 machines · tailnet")).toBeTruthy()
  expect(screen.queryByText("phetzy")).toBeNull()
  expect(screen.queryByText("DF")).toBeNull()
})

it("counts one machine until the fleet has loaded", () => {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.machine.name = "forge-02"
  render(
    <TooltipProvider>
      <SessionsSidebar snapshot={snapshot} {...handlers} />
    </TooltipProvider>,
  )

  expect(screen.getByText("forge-02")).toBeTruthy()
  expect(screen.getByText("1 machine · local")).toBeTruthy()
  expect(screen.queryByText("phetzy")).toBeNull()
})

it("keeps a session that is moving or in conflict reachable in the list", () => {
  const snapshot = structuredClone(demoWorkspace)
  const [moving, conflicted, moved] = snapshot.sessions
  if (!moving || !conflicted || !moved) throw new Error("fixture needs three sessions")
  moving.state = "transferring"
  moving.title = "Moving session"
  conflicted.state = "ownership-conflict"
  conflicted.title = "Conflicted session"
  moved.state = "transferred"
  moved.title = "Moved session"

  render(
    <TooltipProvider>
      <SessionsSidebar snapshot={snapshot} {...handlers} />
    </TooltipProvider>,
  )

  // A session in any of these states is read-only and may need recovering, so
  // dropping it from the list makes its notice unreachable once the operator
  // selects something else.
  for (const title of ["Moving session", "Conflicted session", "Moved session"]) {
    expect(screen.getByText(title)).toBeTruthy()
  }
})
