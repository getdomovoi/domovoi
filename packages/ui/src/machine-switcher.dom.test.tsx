import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

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
  protocolVersion: "0.1.0",
  transports: [
    { kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true },
  ],
  health: "healthy",
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
  health: "unreachable",
}

async function openMenu(
  machines: FleetMachine[],
  sessionCount = 2,
  onSelectMachine?: (machineId: string) => void,
) {
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      machines={machines}
      currentMachineId={local.id}
      currentSessionCount={sessionCount}
      {...(onSelectMachine ? { onSelectMachine } : {})}
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

it("selects a reachable machine", async () => {
  const onSelectMachine = vi.fn()
  const user = await openMenu([local, tailnet], 2, onSelectMachine)

  await user.click(screen.getByRole("menuitem", { name: /studio/ }))

  expect(onSelectMachine).toHaveBeenCalledWith(tailnet.id)
})

it("says why a machine cannot be selected", async () => {
  const onSelectMachine = vi.fn()
  await openMenu([local, offline], 2, onSelectMachine)

  const machine = screen.getByRole("menuitem", { name: /hetzner/ })
  expect(machine.getAttribute("aria-disabled")).toBe("true")
  expect(machine.textContent).toContain("That machine cannot be reached")
})

it("offers nothing to select where no handler can act on it", async () => {
  await openMenu([local, tailnet])

  expect(screen.getByRole("menuitem", { name: /studio/ }).getAttribute("aria-disabled")).toBe("true")
})

it("names a machine that needs an upgrade", async () => {
  await openMenu([local, { ...tailnet, health: "upgrade-required" }])

  const studio = screen.getByRole("menuitem", { name: /studio/ })
  expect(studio.textContent).toContain("Upgrade required")
})

it("names a machine the client is too old to talk to", async () => {
  await openMenu([local, { ...tailnet, health: "version-mismatch" }])

  expect(screen.getByRole("menuitem", { name: /studio/ }).textContent).toContain("Version mismatch")
})

it("names a machine that is reconnecting", async () => {
  await openMenu([local, { ...tailnet, health: "reconnecting" }])

  expect(screen.getByRole("menuitem", { name: /studio/ }).textContent).toContain("Reconnecting")
})

it("offers to pair a machine, as the handoff's device menu does", async () => {
  const onPairMachine = vi.fn()
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      machines={[local]}
      currentMachineId={local.id}
      currentSessionCount={1}
      onPairMachine={onPairMachine}
    />,
  )
  await user.click(screen.getByRole("button", { name: /workshop/ }))

  await user.click(screen.getByRole("menuitem", { name: /pair a machine/i }))

  expect(onPairMachine).toHaveBeenCalledTimes(1)
})

it("omits the pairing entry where nothing can act on it", async () => {
  await openMenu([local])

  expect(screen.queryByRole("menuitem", { name: /pair a machine/i })).toBeNull()
})

it("describes a fleet holding only this machine", async () => {
  await openMenu([local])

  expect(screen.getByText("No other machines are paired")).toBeTruthy()
})
