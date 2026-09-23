import { describe, expect, it, jest } from "@jest/globals"
import type { FleetEntry, FleetMachine } from "@getdomovoi/protocol"
import { fireEvent, render, screen, within } from "@testing-library/react-native"

import type { MachineActivity } from "../machine-activity"
import { MachinesScreen } from "./fleet"

const lastSeenAt = "2026-09-04T12:00:00.000Z"
const now = Date.parse("2026-09-04T12:12:00.000Z")

const daemon: FleetMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "macbook-pro-m3",
  platform: "darwin",
  arch: "arm64",
  version: "0.0.1",
  connection: "local",
  capabilities: ["sessions"],
  protocolVersion: "0.2.0",
  transports: [],
  heartbeat: { state: "online", lastSeenAt },
  health: "healthy",
  self: true,
}

const remote: FleetMachine = {
  ...daemon,
  id: `machine-${"b".repeat(32)}`,
  label: "hetzner-cx42",
  platform: "linux",
  arch: "x64",
  connection: "tailnet",
  self: false,
}

const activity: MachineActivity = {
  machineId: daemon.id,
  sessions: 3,
  tools: "1 approval",
  attention: true,
}

function fleetOf(...machines: FleetMachine[]): FleetEntry[] {
  return machines.map((machine) => ({ kind: "machine", machine }))
}

async function draw(overrides: Partial<Parameters<typeof MachinesScreen>[0]> = {}) {
  const props = {
    fleet: fleetOf(daemon, remote),
    activity,
    loading: false,
    problem: "",
    notice: undefined,
    connected: true,
    now,
    onRefresh: jest.fn<() => void>(),
    onOpen: jest.fn<() => void>(),
    onScanPairingCode: jest.fn<() => void>(),
    onTypePairingCode: jest.fn<() => void>(),
    bottomInset: 0,
    ...overrides,
  }
  await render(<MachinesScreen {...props} />)
  return props
}

// Everything a person can press, by the name a screen reader would announce:
// its label when it has one, otherwise the words drawn inside it.
function buttons(): string[] {
  return screen.getAllByRole("button").map((node) => {
    if (typeof node.props.accessibilityLabel === "string") return node.props.accessibilityLabel
    return within(node).queryAllByText(/.+/)
      .map((child) => String(child.props.children))
      .join(" ")
  })
}

describe("MachinesScreen", () => {
  it("says how each machine is reached and what it is", async () => {
    await draw()

    expect(screen.getByText("This daemon")).toBeOnTheScreen()
    expect(screen.getByText("Tailnet")).toBeOnTheScreen()
    expect(screen.getByText("darwin · arm64 · 0.0.1")).toBeOnTheScreen()
    expect(screen.getByText("linux · x64 · 0.0.1")).toBeOnTheScreen()
  })

  it("counts sessions and tools on the connected daemon and nowhere else", async () => {
    await draw()

    // One machine's snapshot cannot be spread across the fleet, so each stat
    // is drawn once however many machines are listed.
    expect(screen.getAllByText("Sessions")).toHaveLength(1)
    expect(screen.getAllByText("Tools")).toHaveLength(1)
    expect(screen.getByText("3")).toBeOnTheScreen()
    expect(screen.getByText("1 approval")).toBeOnTheScreen()
  })

  it("withholds the counts until a snapshot has named a machine", async () => {
    await draw({ activity: undefined })

    expect(screen.queryByText("Sessions")).toBeNull()
    expect(screen.queryByText("Tools")).toBeNull()
    expect(screen.getByText("macbook-pro-m3")).toBeOnTheScreen()
  })

  it("opens only the daemon this phone is connected to", async () => {
    const { onOpen } = await draw()

    expect(buttons()).toEqual(["Refresh", "Open macbook-pro-m3", "Scan a code", "Type it"])

    await fireEvent.press(screen.getByRole("button", { name: "Open macbook-pro-m3" }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("says when a machine that stopped answering was last heard from, and offers nothing", async () => {
    await draw({
      fleet: fleetOf({ ...remote, health: "unreachable", heartbeat: { state: "offline", lastSeenAt } }),
      activity: undefined,
    })

    expect(screen.getByText("Offline")).toBeOnTheScreen()
    expect(screen.getByText("hetzner-cx42 cannot be reached. Last seen 12m ago.")).toBeOnTheScreen()
    // Nothing in the protocol wakes a machine, so no button claims it can.
    expect(buttons()).toEqual(["Refresh", "Scan a code", "Type it"])
    expect(screen.queryByRole("button", { name: /wake/i })).toBeNull()
  })

  it("names the v2 Machines surface and counts its fleet", async () => {
    await draw({ fleet: fleetOf(daemon, remote, { ...remote, id: `machine-${"c".repeat(32)}`, health: "unreachable" }) })

    expect(screen.getByText("Machines")).toBeOnTheScreen()
    expect(screen.getByText("2 reachable · 1 offline")).toBeOnTheScreen()
  })

  it("owns pairing with the signed camera and typed entry points", async () => {
    const { onScanPairingCode, onTypePairingCode } = await draw()

    expect(screen.getByText("Pair this phone")).toBeOnTheScreen()
    expect(buttons()).toEqual(expect.arrayContaining(["Scan a code", "Type it"]))
    await fireEvent.press(screen.getByRole("button", { name: "Scan a code" }))
    await fireEvent.press(screen.getByRole("button", { name: "Type it" }))
    expect(onScanPairingCode).toHaveBeenCalledTimes(1)
    expect(onTypePairingCode).toHaveBeenCalledTimes(1)
  })

  it("draws no list, and no pairing card, before the daemon has been asked", async () => {
    await draw({ fleet: undefined, activity: undefined, loading: true })

    expect(screen.getByText("Asking the daemon.")).toBeOnTheScreen()
    expect(screen.queryByText("Pair a machine")).toBeNull()
    expect(screen.queryByText("macbook-pro-m3")).toBeNull()
  })

  it("marks a list read on a connection that has since dropped", async () => {
    await draw({ connected: false })

    expect(screen.getByText("Last read while connected.")).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Refresh" }).props.accessibilityState)
      .toMatchObject({ disabled: true })
  })

  // A fleet the daemon has answered with nothing in it is not the same as a
  // fleet nobody has asked for. Only the answered one names the two commands.
  it("turns an answered empty fleet into the v2 pairing surface", async () => {
    await draw({ fleet: [] })

    expect(screen.getByText("Pair this phone")).toBeOnTheScreen()
    expect(screen.getByText(/Nothing passes through a server/)).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Scan a code" })).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Type it" })).toBeOnTheScreen()
    expect(screen.queryByText(/domovoid pair/)).toBeNull()
  })

  it("claims nothing about an empty fleet before the daemon has answered", async () => {
    await draw({ fleet: undefined })

    expect(screen.queryByText("Nothing paired to this phone")).toBeNull()
    expect(screen.queryByText(/domovoid pair/)).toBeNull()
  })
})
