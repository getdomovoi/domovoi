import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import type { FleetEntry, FleetMachine } from "@getdomovoi/protocol"

import { MachineSwitcher } from "./machine-switcher.js"
import { remoteControlRefusal } from "./machine-selection.js"

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

function entries(...machines: FleetMachine[]): FleetEntry[] {
  return machines.map((machine) => ({ kind: "machine", machine }))
}

const pending: FleetEntry = {
  kind: "pending",
  id: "3d5b7a2e-4c1f-4a6b-9e2d-8f7c6b5a4d3e",
  machineId: `machine-${"d".repeat(32)}`,
  operation: "enroll",
  startedAt: "2026-09-04T12:00:00.000Z",
}

const unenrolled: FleetEntry = { kind: "unenrolled", machineId: `machine-${"e".repeat(32)}` }

async function openMenu(
  fleet: FleetEntry[],
  sessionCount = 2,
  onSelectMachine?: (machineId: string) => void,
) {
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      entries={fleet}
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
    <MachineSwitcher entries={entries(local, tailnet)} currentMachineId={local.id} currentSessionCount={2} />,
  )

  expect(screen.getByRole("button", { name: /workshop/ })).toBeTruthy()
})

it("lists the fleet with connection and status", async () => {
  await openMenu(entries(local, tailnet, offline))

  const studio = screen.getByRole("menuitem", { name: /studio/ })
  expect(studio.textContent).toContain("tailnet")
  expect(studio.textContent).toContain("Online")
})

it("shows an offline machine as unreachable and unselectable", async () => {
  await openMenu(entries(local, offline))

  const machine = screen.getByRole("menuitem", { name: /hetzner/ })
  expect(machine.textContent).toContain("UNREACHABLE")
  expect(machine.getAttribute("aria-disabled")).toBe("true")
})

it("marks the machine this client is attached to", async () => {
  await openMenu(entries(local, tailnet))

  expect(screen.getByRole("menuitem", { name: /workshop/ }).textContent).toContain("This machine")
})

it("reports the active session count of this machine", async () => {
  await openMenu(entries(local, tailnet), 3)

  expect(screen.getByRole("menuitem", { name: /workshop/ }).textContent).toContain("3 sessions")
})

it("refuses attaching to a remote machine and names the missing credential", async () => {
  const onSelectMachine = vi.fn()
  const user = await openMenu(entries(local, tailnet), 2, onSelectMachine)

  const studio = screen.getByRole("menuitem", { name: /studio/ })
  expect(studio.getAttribute("aria-disabled")).toBe("true")
  expect(studio.textContent).toContain(remoteControlRefusal)
  await user.click(studio)
  expect(onSelectMachine).not.toHaveBeenCalled()
})

it("says why a machine cannot be selected", async () => {
  const onSelectMachine = vi.fn()
  await openMenu(entries(local, offline), 2, onSelectMachine)

  const machine = screen.getByRole("menuitem", { name: /hetzner/ })
  expect(machine.getAttribute("aria-disabled")).toBe("true")
  expect(machine.textContent).toContain("UNREACHABLE")
  expect(machine.textContent).toContain(remoteControlRefusal)
})

it("offers nothing to select where no handler can act on it", async () => {
  await openMenu(entries(local, tailnet))

  expect(screen.getByRole("menuitem", { name: /studio/ }).getAttribute("aria-disabled")).toBe("true")
})

it("names a machine that needs an upgrade", async () => {
  await openMenu(entries(local, { ...tailnet, health: "upgrade-required" }))

  const studio = screen.getByRole("menuitem", { name: /studio/ })
  expect(studio.textContent).toContain("Upgrade required")
})

it("names a machine the client is too old to talk to", async () => {
  await openMenu(entries(local, { ...tailnet, health: "version-mismatch" }))

  expect(screen.getByRole("menuitem", { name: /studio/ }).textContent).toContain("Version mismatch")
})

it("names a machine that is reconnecting", async () => {
  await openMenu(entries(local, { ...tailnet, health: "reconnecting" }))

  expect(screen.getByRole("menuitem", { name: /studio/ }).textContent).toContain("Reconnecting")
})

it("offers to pair a machine, as the handoff's device menu does", async () => {
  const onPairMachine = vi.fn()
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      entries={entries(local)}
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
  await openMenu(entries(local))

  expect(screen.queryByRole("menuitem", { name: /pair a machine/i })).toBeNull()
})

it("describes a fleet holding only this machine", async () => {
  await openMenu(entries(local))

  expect(screen.getByText("No other machines are paired")).toBeTruthy()
})

it("offers moving the active session to another machine", async () => {
  const onTransferSession = vi.fn()
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      entries={entries(local, tailnet)}
      currentMachineId={local.id}
      currentSessionCount={1}
      onTransferSession={onTransferSession}
    />,
  )
  await user.click(screen.getByRole("button", { name: /workshop/ }))

  await user.click(screen.getByRole("menuitem", { name: /move this session to studio/i }))

  expect(onTransferSession).toHaveBeenCalledWith(tailnet.id)
})

it("offers the move to a machine it refuses to attach to", async () => {
  const onSelectMachine = vi.fn()
  const onTransferSession = vi.fn()
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      entries={entries(local, tailnet)}
      currentMachineId={local.id}
      currentSessionCount={1}
      onSelectMachine={onSelectMachine}
      onTransferSession={onTransferSession}
    />,
  )
  await user.click(screen.getByRole("button", { name: /workshop/ }))

  expect(screen.getByRole("menuitem", { name: /^studio/ }).getAttribute("aria-disabled")).toBe("true")
  await user.click(screen.getByRole("menuitem", { name: /move this session to studio/i }))

  expect(onTransferSession).toHaveBeenCalledWith(tailnet.id)
  expect(onSelectMachine).not.toHaveBeenCalled()
})

it("refuses the move to an unreachable machine with the reason", async () => {
  const onTransferSession = vi.fn()
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      entries={entries(local, offline)}
      currentMachineId={local.id}
      currentSessionCount={1}
      onTransferSession={onTransferSession}
    />,
  )
  await user.click(screen.getByRole("button", { name: /workshop/ }))

  const move = screen.getByRole("menuitem", { name: /move this session to hetzner/i })
  expect(move.getAttribute("aria-disabled")).toBe("true")
  expect(move.textContent).toContain("That machine cannot be reached")
})

it("omits the move section where no other machine is paired", async () => {
  const onTransferSession = vi.fn()
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      entries={entries(local)}
      currentMachineId={local.id}
      currentSessionCount={1}
      onTransferSession={onTransferSession}
    />,
  )
  await user.click(screen.getByRole("button", { name: /workshop/ }))

  expect(screen.queryByText("Move this session to")).toBeNull()
})

it("names a machine whose credential the target refused", async () => {
  await openMenu(entries(local, { ...tailnet, health: "pairing-required" }))

  expect(screen.getByRole("menuitem", { name: /studio/ }).textContent).toContain("Pair again")
})

it("names a machine whose credential could not be read here", async () => {
  await openMenu(entries(local, { ...tailnet, health: "credential-store-unavailable" }))

  expect(screen.getByRole("menuitem", { name: /studio/ }).textContent).toContain("Keychain unavailable")
})

it("shows an enrollment in progress in place, with nothing to press", async () => {
  await openMenu([...entries(local), pending])

  const row = screen.getByRole("menuitem", { name: /enrolling/i })
  expect(row.getAttribute("aria-disabled")).toBe("true")
  expect(row.textContent).toContain("machine-dddddddd")
  expect(row.textContent).toContain("This daemon resumes it on its own")
  expect(row.querySelector("button")).toBeNull()
})

it("shows a forget in progress as forgetting", async () => {
  await openMenu([...entries(local), { ...pending, operation: "forget" }])

  expect(screen.getByRole("menuitem", { name: /forgetting/i })).toBeTruthy()
})

it("says an unenrolled credential exists and how to enroll the machine", async () => {
  await openMenu([...entries(local), unenrolled])

  const row = screen.getByRole("menuitem", { name: /never enrolled/i })
  expect(row.getAttribute("aria-disabled")).toBe("true")
  expect(row.textContent).toContain("A credential exists but this machine was never enrolled. Pair it again to enroll it.")
})

it("offers the move only to machines with a descriptor", async () => {
  const user = userEvent.setup()
  render(
    <MachineSwitcher
      entries={[...entries(local, tailnet), pending, unenrolled]}
      currentMachineId={local.id}
      currentSessionCount={1}
      onTransferSession={vi.fn()}
    />,
  )
  await user.click(screen.getByRole("button", { name: /workshop/ }))

  expect(screen.getAllByRole("menuitem", { name: /move this session to/i })).toHaveLength(1)
})
