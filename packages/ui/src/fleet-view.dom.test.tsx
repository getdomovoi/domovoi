import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import type { FleetMachine, PairedDeviceSummary } from "@getdomovoi/protocol"

import { FleetView, orderedMachineTransports } from "./fleet-view.js"

afterEach(cleanup)

const local: FleetMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.4.2",
  connection: "local",
  capabilities: ["sessions", "terminals", "previews"],
  heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
  protocolVersion: "0.1.0",
  transports: [
    { kind: "relay", endpoint: "wss://relay.example/rpc", authenticated: true },
    { kind: "tailnet", endpoint: "wss://workshop.tailnet:47831/rpc", authenticated: true },
    { kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true },
  ],
  health: "healthy",
  self: true,
}

const studio: FleetMachine = {
  ...local,
  id: `machine-${"b".repeat(32)}`,
  label: "studio",
  platform: "darwin",
  arch: "arm64",
  version: "0.4.1",
  connection: "tailnet",
  capabilities: ["sessions"],
  health: "upgrade-required",
  self: false,
  transports: [{ kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true }],
}

const device: PairedDeviceSummary = {
  id: `device-${"d".repeat(32)}`,
  label: "studio-ipad",
  pairedAt: "2026-08-20T09:00:00.000Z",
  lastSeenAt: "2026-08-31T11:00:00.000Z",
}

function renderFleet(overrides: {
  machines?: FleetMachine[]
  devices?: PairedDeviceSummary[]
  onRevokeDevice?: (params: { deviceId: string }) => Promise<{ device: PairedDeviceSummary }>
  onRotateDevice?: (params: { deviceId: string }) => Promise<{ device: PairedDeviceSummary; token: string }>
} = {}) {
  const devices = overrides.devices ?? [device]
  const onListDevices = vi.fn(() => Promise.resolve({ devices }))
  const onRevokeDevice = vi.fn(
    overrides.onRevokeDevice
      ?? ((params: { deviceId: string }) => Promise.resolve({
        device: { ...device, id: params.deviceId, revokedAt: "2026-09-01T10:00:00.000Z" },
      })),
  )
  const onRotateDevice = vi.fn(
    overrides.onRotateDevice
      ?? ((params: { deviceId: string }) => Promise.resolve({
        device: { ...device, id: params.deviceId },
        token: "r".repeat(43),
      })),
  )
  const onPairMachine = vi.fn(() => Promise.resolve({
    machineId: studio.id,
    machineName: "studio",
    label: "studio-ipad",
  }))
  const onUseMachine = vi.fn()
  const onOpenMachineTerminal = vi.fn()
  const user = userEvent.setup()
  render(
    <FleetView
      connected
      machines={overrides.machines ?? [local, studio]}
      currentMachineId={local.id}
      currentSessionCount={2}
      onOpenSkills={() => {}}
      onListDevices={onListDevices as never}
      onRevokeDevice={onRevokeDevice as never}
      onRotateDevice={onRotateDevice as never}
      onPairMachine={onPairMachine as never}
      onUseMachine={onUseMachine}
      onOpenMachineTerminal={onOpenMachineTerminal}
    />,
  )
  return { user, onListDevices, onRevokeDevice, onRotateDevice, onPairMachine, onUseMachine, onOpenMachineTerminal }
}

it("describes each machine in the fleet", () => {
  renderFleet()

  const machine = screen.getByRole("group", { name: "studio" })
  expect(machine.textContent).toContain("darwin")
  expect(machine.textContent).toContain("arm64")
  expect(machine.textContent).toContain("0.4.1")
  expect(machine.textContent).toContain("tailnet")
  expect(machine.textContent).toContain("Upgrade required")
  expect(machine.textContent).toContain("sessions")
})

it("counts sessions only for this machine", () => {
  renderFleet()

  expect(screen.getByRole("group", { name: "workshop" }).textContent).toContain("2 sessions")
  expect(screen.getByRole("group", { name: "studio" }).textContent).not.toContain("2 sessions")
})

it("orders transports by preference and never claims a relay", () => {
  expect(orderedMachineTransports(local).map((transport) => transport.kind))
    .toEqual(["local", "tailnet"])
})

it("shows the transport order without a relay row", () => {
  renderFleet()

  const transports = within(screen.getByRole("group", { name: "workshop" }))
    .getByRole("list", { name: "Transports" })
  expect(transports.textContent).toContain("local")
  expect(transports.textContent).toContain("tailnet")
  expect(transports.textContent).not.toContain("relay")
})

it("lists paired devices the daemon reports", async () => {
  renderFleet()

  const row = await screen.findByRole("row", { name: /studio-ipad/ })
  expect(row.textContent).toContain("studio-ipad")
})

it("revokes a device only after the confirmation is accepted", async () => {
  const { user, onRevokeDevice } = renderFleet()
  await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(screen.getByRole("button", { name: "Revoke studio-ipad" }))
  expect(onRevokeDevice).not.toHaveBeenCalled()

  await user.click(await screen.findByRole("button", { name: "Revoke device" }))

  expect(onRevokeDevice).toHaveBeenCalledWith({ deviceId: device.id })
  await waitFor(() => {
    expect(screen.getByRole("row", { name: /studio-ipad/ }).textContent).toContain("Revoked")
  })
})

it("keeps the device when the confirmation is cancelled", async () => {
  const { user, onRevokeDevice } = renderFleet()
  await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(screen.getByRole("button", { name: "Revoke studio-ipad" }))
  await user.click(await screen.findByRole("button", { name: "Keep device" }))

  expect(onRevokeDevice).not.toHaveBeenCalled()
})

it("rotates a device credential and shows it once", async () => {
  const { user, onRotateDevice } = renderFleet()
  await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(screen.getByRole("button", { name: "Rotate studio-ipad" }))

  expect(onRotateDevice).toHaveBeenCalledWith({ deviceId: device.id })
  const notice = await screen.findByRole("status")
  expect(notice.textContent).toContain("r".repeat(43))
  expect(notice.textContent).toContain("shown once")
})

it("states why a device action was refused", async () => {
  const { user } = renderFleet({
    onRevokeDevice: () => Promise.reject(new Error("Managing paired devices requires the daemon credential")),
  })
  await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(screen.getByRole("button", { name: "Revoke studio-ipad" }))
  await user.click(await screen.findByRole("button", { name: "Revoke device" }))

  expect((await screen.findByRole("alert")).textContent)
    .toContain("Managing paired devices requires the daemon credential")
})

it("offers pairing a machine through the existing pairing dialog", async () => {
  const { user } = renderFleet()

  await user.click(screen.getByRole("button", { name: "Pair a machine" }))

  expect(await screen.findByRole("heading", { name: "Pair a machine" })).toBeTruthy()
  expect(screen.getByLabelText("Pairing code")).toBeTruthy()
})

it("says when no device is paired", async () => {
  renderFleet({ devices: [] })

  expect(await screen.findByText("No device is paired with this machine")).toBeTruthy()
})


it("opens a machine from its card", async () => {
  const { user, onUseMachine } = renderFleet()

  const card = within(screen.getByRole("group", { name: "studio" }))
  await user.click(card.getByRole("button", { name: "Use studio" }))

  expect(onUseMachine).toHaveBeenCalledWith(studio.id)
})

it("says which machine is already in use instead of offering to open it", () => {
  renderFleet()

  const card = within(screen.getByRole("group", { name: "workshop" }))
  expect(card.getByText("In use")).toBeTruthy()
  expect(card.queryByRole("button", { name: /^Use /u })).toBeNull()
})

it("opens a terminal on the machine that owns it", async () => {
  const { user, onOpenMachineTerminal } = renderFleet({
    machines: [{ ...studio, capabilities: ["sessions", "terminals"] }],
  })

  const card = within(screen.getByRole("group", { name: "studio" }))
  await user.click(card.getByRole("button", { name: "Terminal on studio" }))

  expect(onOpenMachineTerminal).toHaveBeenCalledWith(studio.id)
})

it("offers no terminal on a machine that reports no terminal capability", () => {
  renderFleet()

  const card = within(screen.getByRole("group", { name: "studio" }))
  expect(card.queryByRole("button", { name: "Terminal on studio" })).toBeNull()
})

it("does not offer machine actions while the daemon is unreachable", () => {
  const onUseMachine = vi.fn()
  render(
    <FleetView
      connected={false}
      machines={[{ ...studio, capabilities: ["sessions", "terminals"] }]}
      currentMachineId={local.id}
      currentSessionCount={2}
      onOpenSkills={() => {}}
      onListDevices={(() => Promise.resolve({ devices: [] })) as never}
      onRevokeDevice={(() => Promise.resolve({})) as never}
      onRotateDevice={(() => Promise.resolve({})) as never}
      onUseMachine={onUseMachine}
      onOpenMachineTerminal={vi.fn()}
    />,
  )

  const card = within(screen.getByRole("group", { name: "studio" }))
  expect(card.getByRole("button", { name: "Use studio" })).toHaveProperty("disabled", true)
  expect(card.getByRole("button", { name: "Terminal on studio" })).toHaveProperty("disabled", true)
})

it("marks a machine running an older daemon than the fleet", () => {
  renderFleet({ machines: [local, { ...studio, version: "0.4.1" }] })

  const behind = within(screen.getByRole("group", { name: "studio" }))
  expect(behind.getByText("UPDATE 0.4.2")).toBeTruthy()
  const current = within(screen.getByRole("group", { name: "workshop" }))
  expect(current.queryByText(/^UPDATE/u)).toBeNull()
})
