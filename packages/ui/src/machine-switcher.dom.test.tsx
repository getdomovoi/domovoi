import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it } from "vitest"

import type { FleetMachine } from "@getdomovoi/protocol"

import { MachineSwitcher } from "./machine-switcher.js"

afterEach(cleanup)

const local: FleetMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "local",
  capabilities: ["sessions", "terminals"],
  heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
  self: true,
}

const tailnet: FleetMachine = {
  ...local,
  id: `machine-${"b".repeat(32)}`,
  label: "studio",
  connection: "tailnet",
  self: false,
}

const offline: FleetMachine = {
  ...tailnet,
  id: `machine-${"c".repeat(32)}`,
  label: "hetzner",
  connection: "relay",
  heartbeat: { state: "offline", lastSeenAt: "2026-08-31T11:00:00.000Z" },
}

async function openMenu(machines: FleetMachine[], sessionCount = 2) {
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      machines={machines}
      currentMachineId={local.id}
      currentSessionCount={sessionCount}
    />,
  )
  await user.click(screen.getByRole("button", { name: /workshop/ }))
  return user
}

it("names the current machine on the chip", () => {
  render(
    <MachineSwitcher machines={[local, tailnet]} currentMachineId={local.id} currentSessionCount={2} />,
  )

  expect(screen.getByRole("button", { name: /workshop/ })).toBeTruthy()
})

it("lists the fleet with connection and status", async () => {
  await openMenu([local, tailnet, offline])

  const studio = screen.getByRole("menuitem", { name: /studio/ })
  expect(studio.textContent).toContain("tailnet")
  expect(studio.textContent).toContain("Online")
})

it("shows an offline machine as unreachable and unselectable", async () => {
  await openMenu([local, offline])

  const machine = screen.getByRole("menuitem", { name: /hetzner/ })
  expect(machine.textContent).toContain("UNREACHABLE")
  expect(machine.getAttribute("aria-disabled")).toBe("true")
})

it("marks the machine this client is attached to", async () => {
  await openMenu([local, tailnet])

  expect(screen.getByRole("menuitem", { name: /workshop/ }).textContent).toContain("This machine")
})

it("reports the active session count of this machine", async () => {
  await openMenu([local, tailnet], 3)

  expect(screen.getByRole("menuitem", { name: /workshop/ }).textContent).toContain("3 sessions")
})

it("explains that a reachable machine cannot be selected yet", async () => {
  await openMenu([local, tailnet])

  const studio = screen.getByRole("menuitem", { name: /studio/ })
  expect(studio.getAttribute("aria-disabled")).toBe("true")
  expect(screen.getByText("Machine transfer is not available yet")).toBeTruthy()
})

it("describes a fleet holding only this machine", async () => {
  await openMenu([local])

  expect(screen.getByText("No other machines are paired")).toBeTruthy()
})
