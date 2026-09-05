import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { fleetForgetRefusalSchema, maximumFleetEntries, type FleetEntry, type FleetSnapshotOverflow, type FleetForgetResult, type FleetMachine, type PairedDeviceSummary } from "@getdomovoi/protocol"

import { TooltipProvider } from "./components/ui/tooltip"
import { FleetView, orderedMachineTransports } from "./fleet-view.js"
import { forgetRefusalMessage } from "./forget-machine.js"
import { remoteControlRefusal } from "./machine-selection.js"

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

function entries(...machines: FleetMachine[]): FleetEntry[] {
  return machines.map((machine) => ({ kind: "machine", machine }))
}

const pending: FleetEntry = {
  kind: "pending",
  id: "3d5b7a2e-4c1f-4a6b-9e2d-8f7c6b5a4d3e",
  machineId: `machine-${"c".repeat(32)}`,
  operation: "enroll",
  startedAt: "2026-09-04T12:00:00.000Z",
}

const unenrolled: FleetEntry = { kind: "unenrolled", machineId: `machine-${"e".repeat(32)}` }

const forgotten: FleetForgetResult = {
  outcome: "forgotten",
  machineId: studio.id,
  remoteRevocation: "confirmed",
  fleet: { entries: entries(local) },
}

const device: PairedDeviceSummary = {
  id: `device-${"d".repeat(32)}`,
  label: "studio-ipad",
  pairedAt: "2026-08-20T09:00:00.000Z",
  binding: { kind: "client", client: "tablet" },
  lastSeenAt: "2026-08-31T11:00:00.000Z",
}

// A phone someone named after a build machine. The label lies, which is why the
// Kind column reads the binding and never the label.
const liar: PairedDeviceSummary = {
  id: `device-${"e".repeat(32)}`,
  label: "hetzner-build-runner-03",
  pairedAt: "2026-08-30T20:16:00.000Z",
  binding: { kind: "client", client: "phone" },
  lastSeenAt: "2026-09-04T06:22:00.000Z",
}

const runner: PairedDeviceSummary = {
  id: `device-${"f".repeat(32)}`,
  label: "beelink-ser8",
  pairedAt: "2026-05-28T08:27:00.000Z",
  binding: { kind: "machine", machineId: `machine-${"c".repeat(32)}` },
  lastSeenAt: "2026-09-02T19:14:00.000Z",
}

const clientConsequence = "Signs this device out. Someone has to pair it again from the device."
const machineConsequence =
  "Cuts this machine off. Its sessions keep running there; transfers to it are refused."

function renderFleet(overrides: {
  entries?: FleetEntry[]
  currentMachineId?: string
  fleetOverflow?: FleetSnapshotOverflow
  devices?: PairedDeviceSummary[]
  onForgetMachine?: (machineId: string) => Promise<FleetForgetResult>
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
    outcome: "enrolled" as const,
    machineId: studio.id,
    label: "studio",
    fleet: { entries: entries(local, studio) },
  }))
  const onForgetMachine = vi.fn(overrides.onForgetMachine ?? (() => Promise.resolve(forgotten)))
  const onUseMachine = vi.fn()
  const onOpenMachineTerminal = vi.fn()
  const user = userEvent.setup()
  render(
    <TooltipProvider>
      <FleetView
        connected
        entries={overrides.entries ?? entries(local, studio)}
        currentMachineId={overrides.currentMachineId ?? local.id}
        fleetOverflow={overrides.fleetOverflow ?? null}
        currentSessionCount={2}
        onOpenSkills={() => {}}
        onListDevices={onListDevices as never}
        onRevokeDevice={onRevokeDevice as never}
        onRotateDevice={onRotateDevice as never}
        onPairMachine={onPairMachine}
        onForgetMachine={onForgetMachine}
        onUseMachine={onUseMachine}
        onOpenMachineTerminal={onOpenMachineTerminal}
      />
    </TooltipProvider>,
  )
  return { user, onListDevices, onRevokeDevice, onRotateDevice, onPairMachine, onForgetMachine, onUseMachine, onOpenMachineTerminal }
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
  // A deliberate revoke is not an upgrade, so it must not borrow the copy that
  // tells the operator to pair the device again.
  const row = screen.getByRole("row", { name: /studio-ipad/ })
  expect(row.textContent).not.toContain("Revoked by upgrade")
  expect(row.textContent).not.toContain("predates bound credentials")
})

// Two migrations bound credentials, and a person who skipped both would
// otherwise be told their pairing broke twice for two different reasons. The
// record keeps them apart for auditing; the row tells one story with one remedy.
it("tells one upgrade story for either credential migration", async () => {
  renderFleet({
    devices: [
      {
        ...device,
        id: `device-${"1".repeat(32)}`,
        label: "unbound-credential-ipad",
        binding: { kind: "unbound", previousRole: "unknown" },
        revokedAt: "2026-09-03T08:00:00.000Z",
        revocationReason: "legacy-unbound-credential",
      },
      {
        ...device,
        id: `device-${"2".repeat(32)}`,
        label: "unbound-client-kind-ipad",
        binding: { kind: "unbound", previousRole: "client" },
        revokedAt: "2026-09-03T08:00:00.000Z",
        revocationReason: "legacy-unbound-client-kind",
      },
    ],
  })

  const rows = [
    await screen.findByRole("row", { name: /unbound-credential-ipad/ }),
    await screen.findByRole("row", { name: /unbound-client-kind-ipad/ }),
  ]
  const explanations = rows.map((row) => {
    expect(within(row).getByText("Revoked by upgrade")).toBeTruthy()
    return within(row).getByText(/predates bound credentials/).textContent
  })

  expect(explanations[0]).toBe(
    "This pairing predates bound credentials. Pair this device again to restore it.",
  )
  expect(explanations[1]).toBe(explanations[0])
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

  await user.click(screen.getByRole("button", { name: "Rotate the credential on studio-ipad" }))

  expect(onRotateDevice).toHaveBeenCalledWith({ deviceId: device.id })
  const notice = await screen.findByRole("status")
  await user.click(within(notice).getByRole("button", { name: "Show the credential" }))
  expect(notice.textContent).toContain("r".repeat(43))
  expect(notice.textContent).toContain("shown once")
})

it("names the kind from the binding, never from the label", async () => {
  renderFleet({ devices: [liar, runner] })

  const phoneRow = await screen.findByRole("row", { name: /hetzner-build-runner-03/ })
  expect(within(phoneRow).getByText("Phone")).toBeTruthy()
  expect(within(phoneRow).queryByText(/^machine-/)).toBeNull()

  const machineRow = screen.getByRole("row", { name: /beelink-ser8/ })
  expect(within(machineRow).getByText("Machine")).toBeTruthy()
  const chip = within(machineRow).getByText(`machine-${"c".repeat(8)}…`)
  expect(chip.getAttribute("title")).toBe(runner.binding.kind === "machine" ? runner.binding.machineId : "")
})

it("states the consequence of revoking before the confirmation, per kind", async () => {
  renderFleet({ devices: [device, runner] })
  await screen.findByRole("row", { name: /studio-ipad/ })

  act(() => screen.getByRole("button", { name: "Revoke studio-ipad" }).focus())
  expect((await screen.findByRole("tooltip")).textContent).toBe(clientConsequence)

  act(() => screen.getByRole("button", { name: "Revoke beelink-ser8" }).focus())
  await waitFor(() => {
    expect(screen.getByRole("tooltip").textContent).toBe(machineConsequence)
  })
})

// Radix tooltips never open on touch, so the sentence has to stand on its own
// wherever the pointer is coarse. That is a CSS variant, which happy-dom does not
// evaluate, so this checks the variant is on the element that carries the sentence.
it("keeps the consequence as standing text where hover does not exist", async () => {
  renderFleet({ devices: [device, runner] })

  const clientRow = await screen.findByRole("row", { name: /studio-ipad/ })
  const standing = within(clientRow).getByText(clientConsequence)
  expect(standing.className.split(" ")).toContain("hidden")
  expect(standing.className.split(" ")).toContain("pointer-coarse:block")

  const machineRow = screen.getByRole("row", { name: /beelink-ser8/ })
  expect(within(machineRow).getByText(machineConsequence).className.split(" "))
    .toContain("pointer-coarse:block")
})

it("masks a rotated credential and copies it without revealing it", async () => {
  const { user } = renderFleet()
  await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(screen.getByRole("button", { name: "Rotate the credential on studio-ipad" }))

  const receipt = await screen.findByRole("status")
  expect(receipt.textContent).not.toContain("r".repeat(43))
  expect(receipt.textContent).toContain("•".repeat(20))

  await user.click(within(receipt).getByRole("button", { name: "Copy" }))

  expect(await navigator.clipboard.readText()).toBe("r".repeat(43))
  await waitFor(() => {
    expect(receipt.textContent).toContain("Copied to the clipboard.")
  })
  expect(receipt.textContent).not.toContain("r".repeat(43))
})

it("says when the clipboard refused the credential", async () => {
  const { user } = renderFleet()
  await screen.findByRole("row", { name: /studio-ipad/ })
  await user.click(screen.getByRole("button", { name: "Rotate the credential on studio-ipad" }))
  const receipt = await screen.findByRole("status")
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"))

  await user.click(within(receipt).getByRole("button", { name: "Copy" }))

  await waitFor(() => {
    expect(receipt.textContent).toContain("This browser refused the clipboard.")
  })
})

it("reveals the credential on request and names the state of the control", async () => {
  const { user } = renderFleet()
  await screen.findByRole("row", { name: /studio-ipad/ })
  await user.click(screen.getByRole("button", { name: "Rotate the credential on studio-ipad" }))
  const receipt = await screen.findByRole("status")

  const reveal = within(receipt).getByRole("button", { name: "Show the credential" })
  expect(reveal.getAttribute("aria-pressed")).toBe("false")
  await user.click(reveal)

  expect(receipt.textContent).toContain("r".repeat(43))
  const hide = within(receipt).getByRole("button", { name: "Hide the credential" })
  expect(hide.getAttribute("aria-pressed")).toBe("true")
  await user.click(hide)

  expect(receipt.textContent).not.toContain("r".repeat(43))
  expect(within(receipt).getByRole("button", { name: "Show the credential" })).toBeTruthy()
})

it("masks a new receipt even when the last one was revealed", async () => {
  let rotations = 0
  const { user } = renderFleet({
    onRotateDevice: (params) => {
      rotations += 1
      return Promise.resolve({
        device: { ...device, id: params.deviceId },
        token: (rotations === 1 ? "r" : "s").repeat(43),
      })
    },
  })
  await screen.findByRole("row", { name: /studio-ipad/ })
  const rotate = screen.getByRole("button", { name: "Rotate the credential on studio-ipad" })

  await user.click(rotate)
  await user.click(within(await screen.findByRole("status")).getByRole("button", { name: "Show the credential" }))
  expect(screen.getByRole("status").textContent).toContain("r".repeat(43))

  await user.click(rotate)

  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("•".repeat(20))
  })
  const receipt = screen.getByRole("status")
  expect(receipt.textContent).not.toContain("s".repeat(43))
  expect(receipt.textContent).not.toContain("r".repeat(43))
  expect(within(receipt).getByRole("button", { name: "Show the credential" })).toBeTruthy()
})

it("tells a phone to enter the credential and a machine that nobody has to be there", async () => {
  const byId = new Map([[liar.id, liar], [runner.id, runner]])
  const { user } = renderFleet({
    devices: [liar, runner],
    onRotateDevice: (params) => Promise.resolve({
      device: byId.get(params.deviceId) ?? device,
      token: "t".repeat(43),
    }),
  })
  await screen.findByRole("row", { name: /hetzner-build-runner-03/ })

  await user.click(screen.getByRole("button", { name: "Rotate the credential on hetzner-build-runner-03" }))
  let receipt = await screen.findByRole("status")
  expect(receipt.textContent).toContain("New credential for hetzner-build-runner-03")
  expect(receipt.textContent).toContain("Enter it on that phone.")
  expect(receipt.textContent).not.toContain("Nobody has to be at that machine.")

  await user.click(screen.getByRole("button", { name: "Rotate the credential beelink-ser8 uses" }))
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("New credential for beelink-ser8")
  })
  receipt = screen.getByRole("status")
  expect(receipt.textContent).toContain("Nobody has to be at that machine.")
  expect(receipt.textContent).toContain("sessions already running there are untouched")
  expect(receipt.textContent).not.toContain("Enter it on that")
})

it("lands the receipt under the row that produced it", async () => {
  const { user } = renderFleet({
    devices: [liar, runner],
    onRotateDevice: () => Promise.resolve({ device: liar, token: "t".repeat(43) }),
  })
  await screen.findByRole("row", { name: /hetzner-build-runner-03/ })

  await user.click(screen.getByRole("button", { name: "Rotate the credential on hetzner-build-runner-03" }))

  const receipt = await screen.findByRole("status")
  const receiptRow = receipt.closest("tr")
  expect(receiptRow).not.toBeNull()
  expect(receiptRow?.previousElementSibling?.textContent).toContain("hetzner-build-runner-03")
  expect(receiptRow?.nextElementSibling?.textContent).toContain("beelink-ser8")
})

it("confirms revoking a client device in that device's own words", async () => {
  const { user, onRevokeDevice } = renderFleet()
  await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(screen.getByRole("button", { name: "Revoke studio-ipad" }))

  const dialog = await screen.findByRole("alertdialog", { name: "Revoke studio-ipad" })
  expect(dialog.textContent).toContain(
    "That tablet loses access to this machine immediately and has to be paired again, from the tablet, to come back.",
  )
  expect(dialog.textContent).toContain("Sessions already on this machine are untouched.")
  expect(dialog.textContent).not.toContain("machine-")
  expect(within(dialog).getByRole("button", { name: "Keep device" })).toBeTruthy()
  await user.click(within(dialog).getByRole("button", { name: "Revoke device" }))
  expect(onRevokeDevice).toHaveBeenCalledWith({ deviceId: device.id })
})

it("confirms revoking a machine with what the operator cannot see from here", async () => {
  const { user, onRevokeDevice } = renderFleet({ devices: [runner] })
  await screen.findByRole("row", { name: /beelink-ser8/ })

  await user.click(screen.getByRole("button", { name: "Revoke beelink-ser8" }))

  const dialog = await screen.findByRole("alertdialog", { name: "Revoke beelink-ser8" })
  expect(dialog.textContent).toContain(`machine-${"c".repeat(8)}…`)
  expect(dialog.textContent).toContain("Sessions running there keep running and stay reachable from that machine")
  expect(dialog.textContent).toContain("a transfer to it is refused rather than queued")
  expect(dialog.textContent).toContain(
    "Pairing it again needs someone with access to that machine, not to this one.",
  )
  expect(within(dialog).queryByRole("button", { name: "Keep device" })).toBeNull()
  expect(within(dialog).getByRole("button", { name: "Keep machine" })).toBeTruthy()
  await user.click(within(dialog).getByRole("button", { name: "Revoke machine" }))
  expect(onRevokeDevice).toHaveBeenCalledWith({ deviceId: runner.id })
})

it("holds the table shape while the list loads", async () => {
  let deliver: (result: { devices: PairedDeviceSummary[] }) => void = () => {}
  const pending = new Promise<{ devices: PairedDeviceSummary[] }>((resolve) => { deliver = resolve })
  render(
    <TooltipProvider>
      <FleetView
        connected
        entries={entries(local)}
        fleetOverflow={null}
        currentMachineId={local.id}
        currentSessionCount={0}
        onOpenSkills={() => {}}
        onListDevices={(() => pending) as never}
        onRevokeDevice={(() => Promise.resolve({})) as never}
        onRotateDevice={(() => Promise.resolve({})) as never}
      />
    </TooltipProvider>,
  )

  expect(screen.getByRole("status").textContent).toContain("Loading paired devices")
  expect(screen.getByRole("columnheader", { name: "Kind" })).toBeTruthy()
  expect(screen.getByRole("columnheader", { name: "Actions" })).toBeTruthy()
  expect(screen.queryAllByRole("row").length).toBe(1)

  deliver({ devices: [device] })

  await screen.findByRole("row", { name: /studio-ipad/ })
  expect(screen.queryByText("Loading paired devices")).toBeNull()
})

it("offers no consequence and no action on a revoked row", async () => {
  renderFleet({
    devices: [{ ...device, revokedAt: "2026-09-01T10:00:00.000Z" }],
  })

  const row = await screen.findByRole("row", { name: /studio-ipad/ })
  expect(within(row).getByRole("button", { name: "Revoke studio-ipad" })).toHaveProperty("disabled", true)
  expect(within(row).getByRole("button", { name: "Rotate the credential on studio-ipad" })).toHaveProperty("disabled", true)
  expect(within(row).queryByText(clientConsequence)).toBeNull()
  expect(row.textContent).toContain("revoked")
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


it("refuses to open a remote machine and names the missing credential", async () => {
  const { user, onUseMachine } = renderFleet()

  const card = within(screen.getByRole("group", { name: "studio" }))
  const use = card.getByRole("button", { name: "Use studio" })
  expect(use).toHaveProperty("disabled", true)
  expect(card.getByText(remoteControlRefusal)).toBeTruthy()
  await user.click(use)
  expect(onUseMachine).not.toHaveBeenCalled()
})

it("opens this machine from its card when the client is attached elsewhere", async () => {
  const { user, onUseMachine } = renderFleet({ currentMachineId: studio.id })

  const card = within(screen.getByRole("group", { name: "workshop" }))
  await user.click(card.getByRole("button", { name: "Use workshop" }))

  expect(onUseMachine).toHaveBeenCalledWith(local.id)
  expect(card.queryByText(remoteControlRefusal)).toBeNull()
})

it("says which machine is already in use instead of offering to open it", () => {
  renderFleet()

  const card = within(screen.getByRole("group", { name: "workshop" }))
  expect(card.getByText("In use")).toBeTruthy()
  expect(card.queryByRole("button", { name: /^Use /u })).toBeNull()
})

it("refuses a terminal on a remote machine for the same missing credential", async () => {
  const { user, onOpenMachineTerminal } = renderFleet({
    entries: entries(local, { ...studio, capabilities: ["sessions", "terminals"] }),
  })

  const card = within(screen.getByRole("group", { name: "studio" }))
  const terminal = card.getByRole("button", { name: "Terminal on studio" })
  expect(terminal).toHaveProperty("disabled", true)
  await user.click(terminal)
  expect(onOpenMachineTerminal).not.toHaveBeenCalled()
})

it("opens a terminal on this machine", async () => {
  const { user, onOpenMachineTerminal } = renderFleet({ currentMachineId: studio.id })

  const card = within(screen.getByRole("group", { name: "workshop" }))
  await user.click(card.getByRole("button", { name: "Terminal on workshop" }))

  expect(onOpenMachineTerminal).toHaveBeenCalledWith(local.id)
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
      entries={entries({ ...local, capabilities: ["sessions", "terminals"] })}
      fleetOverflow={null}
      currentMachineId={studio.id}
      currentSessionCount={2}
      onOpenSkills={() => {}}
      onListDevices={(() => Promise.resolve({ devices: [] })) as never}
      onRevokeDevice={(() => Promise.resolve({})) as never}
      onRotateDevice={(() => Promise.resolve({})) as never}
      onUseMachine={onUseMachine}
      onOpenMachineTerminal={vi.fn()}
    />,
  )

  const card = within(screen.getByRole("group", { name: "workshop" }))
  expect(card.getByRole("button", { name: "Use workshop" })).toHaveProperty("disabled", true)
  expect(card.getByRole("button", { name: "Terminal on workshop" })).toHaveProperty("disabled", true)
})

it("marks a machine running an older daemon than the fleet", () => {
  renderFleet({ entries: entries(local, { ...studio, version: "0.4.1" }) })

  const behind = within(screen.getByRole("group", { name: "studio" }))
  expect(behind.getByText("UPDATE 0.4.2")).toBeTruthy()
  const current = within(screen.getByRole("group", { name: "workshop" }))
  expect(current.queryByText(/^UPDATE/u)).toBeNull()
})

it("says the target refused this machine's credential and that pairing again is the fix", () => {
  renderFleet({ entries: entries(local, { ...studio, health: "pairing-required" }) })

  const card = screen.getByRole("group", { name: "studio" })
  expect(card.textContent).toContain("Pair again")
  expect(card.textContent).toContain("studio refused the credential this machine holds for it. Pair it again to restore it.")
})

it("says a keychain that cannot be read is not a pairing problem", () => {
  renderFleet({ entries: entries(local, { ...studio, health: "credential-store-unavailable" }) })

  const card = screen.getByRole("group", { name: "studio" })
  expect(card.textContent).toContain("Keychain unavailable")
  expect(card.textContent).toContain("The keychain on this machine could not be read, so nothing was presented to studio. Pairing again would not fix it.")
})

it("shows an enrollment in progress where the machine will be, with nothing to press", () => {
  renderFleet({ entries: [...entries(local), pending] })

  const row = screen.getByRole("group", { name: /enrolling machine-cccccccc/i })
  expect(row.textContent).toContain("This daemon resumes it on its own")
  expect(within(row).queryAllByRole("button")).toHaveLength(0)
})

it("shows a forget in progress as forgetting", () => {
  renderFleet({ entries: [...entries(local), { ...pending, operation: "forget" }] })

  expect(screen.getByRole("group", { name: /forgetting machine-cccccccc/i })).toBeTruthy()
})

it("says an unenrolled credential exists and how to enroll the machine", () => {
  renderFleet({ entries: [...entries(local), unenrolled] })

  const row = screen.getByRole("group", { name: /never enrolled machine-eeeeeeee/i })
  expect(row.textContent).toContain("A credential exists but this machine was never enrolled. Pair it again to enroll it.")
  expect(within(row).queryAllByRole("button")).toHaveLength(0)
})

it("forgets a machine only after the confirmation is accepted", async () => {
  const { user, onForgetMachine } = renderFleet()

  const card = within(screen.getByRole("group", { name: "studio" }))
  await user.click(card.getByRole("button", { name: "Forget studio" }))
  expect(onForgetMachine).not.toHaveBeenCalled()
  const dialog = await screen.findByRole("alertdialog")
  expect(dialog.textContent).toContain("no revocation across machines")

  await user.click(within(dialog).getByRole("button", { name: "Forget machine" }))

  await waitFor(() => expect(onForgetMachine).toHaveBeenCalledWith(studio.id))
  expect((await screen.findByRole("status", { name: /forgot studio/i })).textContent)
    .toContain("studio revoked this machine's credential")
})

it("keeps the machine when the forget is cancelled", async () => {
  const { user, onForgetMachine } = renderFleet()

  const card = within(screen.getByRole("group", { name: "studio" }))
  await user.click(card.getByRole("button", { name: "Forget studio" }))
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep machine" }))

  expect(onForgetMachine).not.toHaveBeenCalled()
})

it("tells the operator to revoke this machine on the target when nothing confirmed it", async () => {
  const { user } = renderFleet({
    onForgetMachine: () => Promise.resolve({ ...forgotten, remoteRevocation: "unconfirmed" }),
  })

  const card = within(screen.getByRole("group", { name: "studio" }))
  await user.click(card.getByRole("button", { name: "Forget studio" }))
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forget machine" }))

  const receipt = await screen.findByRole("status", { name: /forgot studio/i })
  expect(receipt.textContent).toContain("studio did not confirm revoking this machine")
  expect(receipt.textContent).toContain("Revoke this machine in the Devices list on studio")
})

it("says a forget the daemon is still finishing is pending and who revokes", async () => {
  const { user } = renderFleet({
    onForgetMachine: () => Promise.resolve({
      outcome: "pending",
      operation: { ...pending, machineId: studio.id, operation: "forget" },
      remoteRevocation: "unconfirmed",
      fleet: { entries: [...entries(local), { ...pending, machineId: studio.id, operation: "forget" }] },
    }),
  })

  const card = within(screen.getByRole("group", { name: "studio" }))
  await user.click(card.getByRole("button", { name: "Forget studio" }))
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forget machine" }))

  const receipt = await screen.findByRole("status", { name: /forgetting studio/i })
  expect(receipt.textContent).toContain("This daemon resumes it on its own")
  expect(receipt.textContent).toContain("Revoke this machine in the Devices list on studio")
})

it("states why a forget was refused, in this build's words", async () => {
  const { user } = renderFleet({
    onForgetMachine: () => Promise.resolve({ outcome: "refused", reason: "operation-in-progress" }),
  })

  const card = within(screen.getByRole("group", { name: "studio" }))
  await user.click(card.getByRole("button", { name: "Forget studio" }))
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forget machine" }))

  expect((await screen.findByRole("alert")).textContent).toContain(forgetRefusalMessage["operation-in-progress"])
  for (const reason of fleetForgetRefusalSchema.options) {
    expect(forgetRefusalMessage[reason]).not.toMatch(/[!—]/u)
  }
})

it("offers no forget on this machine", () => {
  renderFleet()

  expect(within(screen.getByRole("group", { name: "workshop" })).queryByRole("button", { name: /^Forget/u })).toBeNull()
})

it("states the consequence of forgetting before the confirmation", () => {
  renderFleet()

  const card = within(screen.getByRole("group", { name: "studio" }))
  const standing = card.getByText("Deletes the credential this machine holds for it. Sessions there keep running, and revoking this machine on that side may still be yours to do.")
  expect(standing.className.split(" ")).toContain("pointer-coarse:block")
})

it("says the fleet list is withheld, how many entries exist, and the daemon-side remedy", () => {
  renderFleet({
    entries: entries(local),
    fleetOverflow: {
      kind: "fleet-overflow",
      limit: maximumFleetEntries,
      totalEntries: maximumFleetEntries + 40,
      entriesNotShown: maximumFleetEntries + 40,
    },
  })

  const alert = screen.getByRole("alert")
  expect(alert.textContent).toContain("Fleet list withheld")
  expect(alert.textContent).toContain(`${maximumFleetEntries + 40} fleet entries`)
  expect(alert.textContent).toContain(`${maximumFleetEntries + 40} entries are not shown`)
  expect(alert.textContent).toContain("This is not an empty fleet")
  expect(alert.textContent).toContain("domovoid fleet-keychain list")
  expect(alert.textContent).toContain("domovoid fleet-keychain forget <machine-id> --confirm-daemon-stopped")
  expect(alert.textContent).toContain("On the daemon's own machine")
})

it("shows no overflow notice when the daemon listed the fleet", () => {
  renderFleet()

  expect(screen.queryByText("Fleet list withheld")).toBeNull()
})
