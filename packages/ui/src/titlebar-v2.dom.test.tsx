import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { afterEach, expect, it, vi } from "vitest"

import { AppBar } from "./app-bar.js"
import { SessionsDrawerTrigger } from "./sessions-drawer.js"

afterEach(cleanup)

// Desktop V2's titlebar is a row of 28px icon buttons, each named by a tooltip
// rather than by visible text. These pin what the design draws on that row.

function appBar({ connected = true }: { connected?: boolean } = {}) {
  return render(
    <AppBar
      snapshot={demoWorkspace}
      connected={connected}
      emergencyStopPending={false}
      emergencyStopOutcome={null}
      emergencyStopError={null}
      onNewSession={vi.fn()}
      onOpenMachines={vi.fn()}
      onOpenSettings={vi.fn()}
      onPauseAll={vi.fn()}
      onEmergencyStop={vi.fn()}
      onOpenCommands={vi.fn()}
      onToggleTheme={vi.fn()}
      commandShortcut="⌘K"
    />,
  )
}

function withFailedSession(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const { activeTurnId: _running, ...session } = snapshot.sessions[0]!
  snapshot.sessions = [{ ...session, id: "session-failed", state: "failed" }]
  return snapshot
}

it("draws stop everything as an icon with its tooltip, not a labelled button", async () => {
  const user = userEvent.setup()
  appBar()

  const stop = screen.getByRole("button", { name: "Stop everything" })
  expect(stop.textContent).toBe("")
  expect(stop.querySelector("svg.lucide-octagon-x")).toBeTruthy()

  await user.hover(stop)
  expect((await screen.findByRole("tooltip")).textContent).toContain("Stop everything, every machine")
})

it("heads the stop menu with its scope and gives each option the design's note", async () => {
  const user = userEvent.setup()
  appBar()

  await user.click(screen.getByRole("button", { name: "Stop everything" }))
  const menu = await screen.findByRole("menu")
  expect(within(menu).getByText("STOP EVERYTHING, ON EVERY MACHINE")).toBeTruthy()
  expect(within(menu).getByText("Stops at the next turn boundary, nothing is killed.")).toBeTruthy()
  expect(within(menu).getByText("Kills processes now. Half-written files stay half-written.")).toBeTruthy()
})

it("names the settings button with a tooltip", async () => {
  const user = userEvent.setup()
  appBar()

  await user.hover(screen.getByRole("button", { name: "Settings" }))
  expect((await screen.findByRole("tooltip")).textContent).toContain("Settings")
})

it("marks the machine chip as a danger when the machine is unreachable", () => {
  appBar({ connected: false })
  const chip = screen.getByRole("button", { name: `Machines: ${demoWorkspace.machine.name}` })
  expect(chip.className).toContain("border-danger-border")
  expect(chip.className).toContain("bg-danger-background")

  cleanup()
  appBar()
  const online = screen.getByRole("button", { name: `Machines: ${demoWorkspace.machine.name}` })
  expect(online.className).not.toContain("border-danger-border")
})

it("shows the needs-you badge only while the drawer is closed", () => {
  const snapshot = withFailedSession()
  const view = render(<SessionsDrawerTrigger snapshot={snapshot} open={false} onOpenChange={vi.fn()} />)
  const closed = screen.getByRole("button", { name: /^Sessions 1, 1 needs you/ })
  expect(closed.querySelector("[data-needs-you-badge]")).toBeTruthy()

  view.rerender(<SessionsDrawerTrigger snapshot={snapshot} open onOpenChange={vi.fn()} />)
  const open = screen.getByRole("button", { name: /^Hide sessions 1, 1 needs you/ })
  expect(open.querySelector("[data-needs-you-badge]")).toBeNull()
})

it("names the drawer toggle with a tooltip that follows the drawer", async () => {
  const user = userEvent.setup()
  const view = render(<SessionsDrawerTrigger snapshot={demoWorkspace} open={false} onOpenChange={vi.fn()} />)

  await user.hover(screen.getByRole("button", { name: /^Sessions/ }))
  expect((await screen.findByRole("tooltip")).textContent).toBe("Sessions")

  view.rerender(<SessionsDrawerTrigger snapshot={demoWorkspace} open onOpenChange={vi.fn()} />)
  expect((await screen.findByRole("tooltip")).textContent).toBe("Hide sessions")
})
