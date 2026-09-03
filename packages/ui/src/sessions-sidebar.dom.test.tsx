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
