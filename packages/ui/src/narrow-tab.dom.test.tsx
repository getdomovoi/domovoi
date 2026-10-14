import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { AppBar } from "./app-bar"
import { DaemonLostBanner } from "./connection-status"
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// A tab narrower than 640 px (Tailwind's sm, 40rem), such as a phone at 390
// or 360 px. jsdom lays nothing out, so the width rules are read from the
// classes that carry them; the browser check in the pull request measures the
// boxes.

let harness: FakeWebSocketHarness

beforeEach(() => {
  try {
    localStorage.removeItem(workspaceUiStorageKey)
  } catch {
    // A browser without storage starts from the default layout anyway.
  }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const classes = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/)

async function openShell() {
  const snapshot = workspaceSnapshot()
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  return { snapshot, socket }
}

function appBar({ connected, clientAccess }: { connected: boolean; clientAccess?: "watching" }) {
  return render(
    <AppBar
      snapshot={demoWorkspace}
      connected={connected}
      {...(clientAccess ? { clientAccess } : {})}
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

it("lets the thread and dock row, and Machines, shrink to the tab instead of their content's width", async () => {
  const user = userEvent.setup()
  await openShell()
  // A row flex item defaults to min-width auto, so without min-w-0 the thread
  // column took its content's width (562 px at 390) and the shell clipped it,
  // the approval card with it.
  const group = document.querySelector("[data-slot=resizable-panel-group]")
  expect(classes(group?.parentElement)).toContain("min-w-0")

  await user.click(screen.getByRole("button", { name: /^Machines:/ }))
  // Machines loads on demand.
  const machines = await screen.findByRole("heading", { name: "Machines", level: 1 }, { timeout: 5000 })
  await settle()
  expect(classes(machines.closest("[data-slot=scroll-area]")?.parentElement)).toContain("min-w-0")
  // The devices table may be wider than a phone; it scrolls in its own box,
  // which adds nothing to the page's width.
  const tables = screen.getAllByRole("table")
  expect(tables.length).toBeGreaterThan(0)
  for (const table of tables) {
    expect(classes(table.parentElement)).toEqual(expect.arrayContaining(["w-0", "min-w-full", "overflow-x-auto"]))
  }
})

it("collapses the app bar below 640 px: tighter spacing, the route word and theme toggle fold away", async () => {
  await openShell()
  const header = document.querySelector("header")
  expect(classes(header)).toEqual(expect.arrayContaining(["max-sm:gap-1", "max-sm:px-2"]))
  // The theme stays one tap away in Settings, Appearance.
  expect(classes(screen.getByRole("button", { name: /^Use (dark|light) theme$/ }))).toContain("max-sm:hidden")
  // The machine chip may shrink; its name truncates, and the route word folds
  // while connected (Machines names it).
  const chip = screen.getByRole("button", { name: /^Machines:/ })
  expect(classes(chip)).toContain("max-sm:shrink")
  const search = screen.getByRole("button", { name: "Open command palette" })
  expect(classes(search.querySelector("kbd"))).toContain("max-sm:hidden")
})

// At 360 px a watching tab whose daemon is unreachable ran the machine chip
// under Stop. Below 640 px a watching bar drops the two controls a watching tab
// cannot use, so watching only and unreachable both keep room.
it("below 640 px a watching bar folds New session and Stop, and keeps watching only and unreachable", () => {
  appBar({ connected: false, clientAccess: "watching" })
  expect(classes(screen.getByRole("button", { name: "New session" }))).toContain("max-sm:hidden")
  expect(classes(screen.getByRole("button", { name: "Stop everything" }).parentElement)).toContain("max-sm:hidden")
  expect(classes(screen.getByText("watching only"))).not.toContain("max-sm:hidden")
  expect(classes(screen.getByText("unreachable"))).not.toContain("max-sm:hidden")
})

it("below 640 px a full-access bar keeps New session and Stop", () => {
  appBar({ connected: true })
  expect(classes(screen.getByRole("button", { name: "New session" }))).not.toContain("max-sm:hidden")
  expect(classes(screen.getByRole("button", { name: "Stop everything" }).parentElement)).not.toContain("max-sm:hidden")
})

// At 390 px the lost banner's words wrapped one per line beside its buttons,
// 327 px tall. Below 640 px the words keep most of the line.
it("below 640 px the lost banner keeps its words on most of the line", () => {
  render(
    <DaemonLostBanner
      connected={false}
      reconnecting
      authenticationRequired={null}
      protocolError={null}
      connectionError=""
      machineName="macbook-pro-m3"
      onReconnect={vi.fn()}
    />,
  )
  const words = screen.getByText("Lost the daemon on macbook-pro-m3").closest("span.flex")
  expect(classes(words)).toContain("max-sm:min-w-[60%]")
})
