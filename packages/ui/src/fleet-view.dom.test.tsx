import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { deviceLabelMismatchErrorCode, fleetForgetRefusalSchema, maximumFleetEntries, type FleetEntry, type FleetSnapshotOverflow, type FleetForgetResult, type FleetMachine, type PairedDeviceSummary, type ProviderRuntime } from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"
import { useReadOnVisit, type FleetAccessState, type HeldReading, type MachineReading } from "./fleet-access-session.js"
import { TooltipProvider } from "./components/ui/tooltip"
import { FleetView } from "./fleet-view.js"
import { forgetRefusalMessage } from "./forget-machine.js"
import { remoteControlRefusal } from "./machine-selection.js"

afterEach(cleanup)

it("shows client authorization next to disabled remote controls and names its authority", async () => {
  const user = userEvent.setup()
  render(<TooltipProvider><FleetView connected entries={entries(local, studio)} fleetOverflow={null}
    currentMachineId={local.id} devicesMachineLabel={local.label} currentSessionCount={2} onOpenSkills={() => {}}
    onListDevices={async () => ({ devices: [] })} onRevokeDevice={vi.fn()} onRotateDevice={vi.fn()} onRenameDevice={vi.fn()}
    onUseMachine={vi.fn()} onOpenMachineTerminal={vi.fn()} clientKind="desktop" onAuthorizeClient={vi.fn()}
  /></TooltipProvider>)
  expect(screen.getByRole("button", { name: "Open its sessions on studio" }).hasAttribute("disabled")).toBe(true)
  await user.click(screen.getByRole("button", { name: "Authorize this client for studio" }))
  const dialog = screen.getByRole("dialog")
  // `domovoid pair` prints a one-time pairing code, which this field does not
  // take, so the dialog does not send the person to it for a credential.
  expect(dialog.textContent).not.toContain("Run this on studio")
  expect(dialog.textContent).toContain("Paste a client credential for a desktop client on studio. It comes from a device.pair request made with that daemon's own credential.")
  expect(dialog.textContent).toContain("domovoid pair --client desktop --label <device label> prints a one-time pairing code, which this field does not take.")
  expect(dialog.textContent).toContain("session sends, approvals and terminals")
  expect(dialog.textContent).toContain("Devices list")
  expect(within(dialog).getByLabelText("Client credential").getAttribute("type")).toBe("password")
})

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

it("lists installed providers on the local machine", () => {
  render(<TooltipProvider><FleetView connected entries={entries(local)} fleetOverflow={null}
    currentMachineId={local.id} devicesMachineLabel={local.label} currentSessionCount={2} onOpenSkills={() => {}}
    providers={[{ id: "claude-code", command: "claude", status: "ready", sessionCapable: true }]}
    onListDevices={async () => ({ devices: [] })} onRevokeDevice={vi.fn()} onRotateDevice={vi.fn()} onRenameDevice={vi.fn()}
  /></TooltipProvider>)
  const providers = screen.getByRole("region", { name: "Agents and providers" })
  expect(providers.textContent).toContain("Tokens live in that machine's OS keychain")
  expect(agentRows(providers)).toEqual([["claude-code", "workshop", "ready"]])
})

const claude: ProviderRuntime = { id: "claude-code", command: "claude", status: "ready", sessionCapable: true }
const codex: ProviderRuntime = { id: "codex", command: "codex", status: "ready", sessionCapable: true }
const aider: ProviderRuntime = { id: "aider", command: "aider", status: "missing", sessionCapable: false }

function reading(input: Partial<MachineReading> = {}): MachineReading {
  return { providers: [claude, codex], sessions: [], readAt: new Date().toISOString(), ...input }
}

function session(id: string, title: string, state: MachineReading["sessions"][number]["state"]) {
  return { id, title, state }
}

// A snapshot the shell holds; live while its connection is open.
function held(machineReading: MachineReading, live = true): HeldReading {
  return { reading: machineReading, live }
}

function admitted(machineReading: MachineReading): FleetAccessState {
  return { state: "admitted", deviceId: `device-${"a".repeat(32)}`, reading: machineReading }
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })

// The card's facts as the design draws them: a label and its value per row.
function facts(card: HTMLElement): Record<string, string> {
  const terms = within(card).getAllByRole("term")
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]))
}

function agentRows(panel: HTMLElement): string[][] {
  return within(panel).getAllByRole("listitem").map((row) =>
    [...row.querySelectorAll("[data-agent-cell]")].map((cell) => cell.textContent ?? ""))
}

it("draws a reachable machine as the design's card: four facts and one way into its sessions", async () => {
  const workshop = { ...local, heartbeat: { state: "online" as const, lastSeenAt: new Date(Date.now() - 2_000).toISOString() } }
  const { user, onUseMachine } = renderFleet({
    entries: entries(workshop, studio),
    readings: { [local.id]: held(reading({
      providers: [claude, codex, aider],
      sessions: [session("s1", "Billing webhooks", "active"), session("s2", "Replay test", "waiting"), session("s3", "Docs", "idle"), session("s4", "Old", "archived")],
    })) },
  })

  const card = screen.getByRole("group", { name: "workshop" })
  expect(facts(card)).toEqual({
    TRANSPORT: "loopback · this machine",
    AGENTS: "claude-code · codex",
    SESSIONS: "1 running · 1 waiting on you",
    "LAST HEARD": "just now",
  })
  expect(card.className).not.toContain("danger-border")
  await user.click(within(card).getByRole("button", { name: "Open its 3 sessions on workshop" }))
  expect(onUseMachine).toHaveBeenCalledWith(local.id)
})

it("keeps an unreachable machine with a danger border, dates its last reading and shows what was running", async () => {
  const readAt = "2026-10-06T14:03:00.000Z"
  const lost = { ...studio, health: "unreachable" as const, heartbeat: { state: "offline" as const, lastSeenAt: new Date(Date.now() - 41_000).toISOString() } }
  const { user } = renderFleet({
    entries: entries(local, lost),
    clientAccess: { [studio.id]: admitted(reading({ providers: [codex], readAt, sessions: [session("s1", "Fix the flaky replay test", "active")] })) },
  })

  const card = screen.getByRole("group", { name: "studio" })
  const asOf = `as of ${clock.format(new Date(readAt))}`
  expect(facts(card)).toEqual({
    TRANSPORT: "tailnet · not answering",
    AGENTS: `codex · ${asOf}`,
    SESSIONS: `1 running · ${asOf}`,
    "LAST HEARD": "41s ago",
  })
  expect(card.className.split(" ")).toContain("border-danger-border")
  expect(within(card).queryByRole("button", { name: /^Open its/u })).toBeNull()
  const stalled = within(card).getByRole("button", { name: "See what stalled on studio" })
  expect(stalled.getAttribute("aria-expanded")).toBe("false")
  await user.click(stalled)
  expect(stalled.getAttribute("aria-expanded")).toBe("true")
  const detail = document.getElementById(stalled.getAttribute("aria-controls") ?? "")
  expect(detail?.textContent).toContain("Fix the flaky replay test")
  expect(detail?.textContent).toContain(`when Domovoi last read studio at ${clock.format(new Date(readAt))}`)
  expect(detail?.textContent).toContain("has not reported them stopped")
})

it("says a machine this client holds no credential for is unknown rather than guessing", () => {
  renderFleet({ entries: entries(local, { ...studio, health: "healthy" }), providers: [claude] })

  const card = screen.getByRole("group", { name: "studio" })
  expect(facts(card).AGENTS).toBe("unknown, no client credential here")
  expect(facts(card).SESSIONS).toBe("unknown, no client credential here")
  expect(card.textContent).toContain("This app holds no client credential for studio, so its agents and sessions are unknown here.")
  expect(within(card).getByRole("button", { name: "Open its sessions on studio" })).toHaveProperty("disabled", true)
  const panel = screen.getByRole("region", { name: "Agents and providers" })
  expect(agentRows(panel)).toEqual([
    ["claude-code", "workshop", "ready"],
    ["unknown", "studio", "this app holds no client credential for it"],
  ])
})

it("never puts the attached machine's agents on this machine's card", () => {
  renderFleet({ entries: entries(local, { ...studio, health: "healthy" }), currentMachineId: studio.id, providers: [codex] })

  expect(facts(screen.getByRole("group", { name: "studio" })).AGENTS).toBe("codex")
  expect(facts(screen.getByRole("group", { name: "workshop" })).AGENTS).toBe("unknown, not read yet")
  expect(agentRows(screen.getByRole("region", { name: "Agents and providers" }))).toEqual([
    ["unknown", "workshop", "not read yet"],
    ["codex", "studio", "ready"],
  ])
})

it("offers Authenticate there only where an agent needs sign-in, and names the command for that machine", async () => {
  const { user } = renderFleet({
    entries: entries(local),
    readings: { [local.id]: held(reading({ providers: [{ ...claude, status: "auth-required" }, codex] })) },
  })

  const panel = screen.getByRole("region", { name: "Agents and providers" })
  expect(agentRows(panel)).toEqual([
    ["claude-code", "workshop", "needs sign-in on that machine"],
    ["codex", "workshop", "ready"],
  ])
  expect(within(panel).getAllByRole("button")).toHaveLength(1)
  const authenticate = within(panel).getByRole("button", { name: "Authenticate there: claude-code on workshop" })
  await user.click(authenticate)
  expect(authenticate.getAttribute("aria-expanded")).toBe("true")
  expect(panel.textContent).toContain("Run claude auth login in a terminal on workshop. Domovoi does not sign in for you.")
})

it("reads each admitted machine when the view opens", () => {
  const onReadMachine = vi.fn((_machineId: string, _signal: AbortSignal) => Promise.reject(new Error("studio did not answer")))
  renderFleet({
    entries: entries(local, { ...studio, health: "healthy" }),
    clientAccess: { [studio.id]: admitted(reading({ providers: [codex], readAt: "2026-10-06T14:03:00.000Z" })) },
    onReadMachine,
  })

  expect(onReadMachine).toHaveBeenCalledWith(studio.id, expect.any(AbortSignal))
})

it("dates a reading the machine did not answer, and one from a machine the home daemon is not hearing", () => {
  const readAt = "2026-10-06T14:03:00.000Z"
  const asOf = `as of ${clock.format(new Date(readAt))}`
  const lab = { ...studio, id: `machine-${"f".repeat(32)}`, label: "lab", health: "reconnecting" as const }
  renderFleet({
    entries: entries(local, { ...studio, health: "healthy" }, lab),
    clientAccess: {
      [studio.id]: { ...admitted(reading({ providers: [codex], readAt })), unanswered: true } as FleetAccessState,
      [lab.id]: admitted(reading({ providers: [codex], readAt })),
    },
  })

  expect(facts(screen.getByRole("group", { name: "studio" })).AGENTS).toBe(`codex · ${asOf}`)
  expect(facts(screen.getByRole("group", { name: "lab" })).SESSIONS).toBe(`none running · ${asOf}`)
})

it("keeps reading when the view mounts twice, as StrictMode does in development", () => {
  const signals: AbortSignal[] = []
  const onReadMachine = vi.fn((_machineId: string, signal: AbortSignal) => { signals.push(signal); return new Promise<void>(() => {}) })
  render(
    <StrictMode>
      <TooltipProvider>
        <FleetView connected entries={entries(local, { ...studio, health: "healthy" })} fleetOverflow={null}
          currentMachineId={local.id} devicesMachineLabel={local.label} currentSessionCount={0} onOpenSkills={() => {}}
          clientAccess={{ [studio.id]: admitted(reading({ readAt: "2026-10-06T14:03:00.000Z" })) }} onReadMachine={onReadMachine}
          onListDevices={async () => ({ devices: [] })} onRevokeDevice={vi.fn()} onRotateDevice={vi.fn()} onRenameDevice={vi.fn()}
        />
      </TooltipProvider>
    </StrictMode>,
  )

  expect(signals.filter((signal) => !signal.aborted)).toHaveLength(1)
})

it("counts every session that is not archived in Open its sessions", () => {
  renderFleet({
    entries: entries(local),
    readings: { [local.id]: held(reading({ sessions: [
      session("s1", "Idle", "idle"), session("s2", "Moved", "transferred"), session("s3", "Going", "archiving"), session("s4", "Gone", "archived"),
    ] })) },
  })

  expect(screen.getByRole("button", { name: "Open its 3 sessions on workshop" })).toBeTruthy()
})

it("dates a snapshot kept after its connection closed and prefers a newer admission reading", () => {
  const kept = "2026-10-06T14:03:00.000Z"
  const newer = "2026-10-06T14:09:00.000Z"
  renderFleet({
    entries: entries(local, { ...studio, health: "healthy" }),
    readings: {
      [local.id]: held(reading({ providers: [claude], readAt: kept }), false),
      [studio.id]: held(reading({ providers: [claude], readAt: kept }), false),
    },
    clientAccess: { [studio.id]: admitted(reading({ providers: [codex], readAt: newer })) },
  })

  expect(facts(screen.getByRole("group", { name: "workshop" })).AGENTS).toBe(`claude-code · as of ${clock.format(new Date(kept))}`)
  expect(facts(screen.getByRole("group", { name: "studio" })).AGENTS).toBe("codex")
})

it("does not read a machine again when another one leaves", async () => {
  const lab = { ...studio, id: `machine-${"f".repeat(32)}`, label: "lab", health: "healthy" as const }
  const old = reading({ readAt: "2026-10-06T14:03:00.000Z" })
  const onReadMachine = vi.fn((_machineId: string, _signal: AbortSignal) => Promise.reject(new Error("no answer")))
  const view = (clientAccess: Readonly<Record<string, FleetAccessState>>) => (
    <TooltipProvider>
      <FleetView connected entries={entries(local, { ...studio, health: "healthy" }, lab)} fleetOverflow={null}
        currentMachineId={local.id} devicesMachineLabel={local.label} currentSessionCount={0} onOpenSkills={() => {}}
        clientAccess={clientAccess} onReadMachine={onReadMachine}
        onListDevices={async () => ({ devices: [] })} onRevokeDevice={vi.fn()} onRotateDevice={vi.fn()} onRenameDevice={vi.fn()}
      />
    </TooltipProvider>
  )
  const { rerender } = render(view({ [studio.id]: admitted(old), [lab.id]: admitted(old) }))
  await waitFor(() => expect(onReadMachine).toHaveBeenCalledTimes(2))
  await act(async () => { await Promise.resolve() })

  rerender(view({ [studio.id]: admitted(old) }))
  await act(async () => { await Promise.resolve() })
  expect(onReadMachine).toHaveBeenCalledTimes(2)
})

it("does not read again a machine it has just read", () => {
  const onReadMachine = vi.fn(() => Promise.resolve())
  renderFleet({
    entries: entries(local, { ...studio, health: "healthy" }),
    clientAccess: { [studio.id]: admitted(reading()) },
    onReadMachine,
  })

  expect(onReadMachine).not.toHaveBeenCalled()
})

it("dates an admitted machine's reading while the home daemon is not connected", () => {
  const readAt = "2026-10-06T14:03:00.000Z"
  renderFleet({
    connected: false,
    entries: entries(local, { ...studio, health: "healthy" }),
    clientAccess: { [studio.id]: admitted(reading({ providers: [codex], readAt })) },
  })

  expect(facts(screen.getByRole("group", { name: "studio" })).AGENTS).toBe(`codex · as of ${clock.format(new Date(readAt))}`)
})

it("counts an ownership conflict in the session fact, as the drawer puts it under NEEDS YOU", () => {
  renderFleet({
    entries: entries(local),
    readings: { [local.id]: held(reading({ sessions: [session("s1", "Claimed elsewhere", "ownership-conflict")] })) },
  })

  expect(facts(screen.getByRole("group", { name: "workshop" })).SESSIONS).toBe("1 ownership conflict")
})

it("never shows the placeholder heartbeat the shell draws before the fleet list answers", () => {
  // localMachineEntry stands in for this machine with a heartbeat at the epoch.
  const placeholder = { state: "online" as const, lastSeenAt: new Date(0).toISOString() }
  renderFleet({
    entries: entries({ ...local, heartbeat: placeholder }, { ...studio, health: "healthy", heartbeat: placeholder }),
    readings: { [local.id]: held(reading()) },
  })

  expect(facts(screen.getByRole("group", { name: "workshop" }))["LAST HEARD"]).toBe("just now")
  expect(facts(screen.getByRole("group", { name: "studio" }))["LAST HEARD"]).toBe("unknown, no heartbeat reported")
})

it("reads admitted machines on each visit of a surface that stays mounted, as Settings does", async () => {
  const onReadMachine = vi.fn((_machineId: string, _signal: AbortSignal) => Promise.resolve())
  const clientAccess = { [studio.id]: admitted(reading({ readAt: "2026-10-06T14:03:00.000Z" })) }
  const { rerender } = renderHook(({ active }: { active: boolean }) => useReadOnVisit({ active, connected: true, clientAccess, onReadMachine }),
    { initialProps: { active: false } })
  expect(onReadMachine).not.toHaveBeenCalled()

  rerender({ active: true })
  expect(onReadMachine).toHaveBeenCalledTimes(1)
  await act(async () => { await Promise.resolve() })
  rerender({ active: true })
  expect(onReadMachine).toHaveBeenCalledTimes(1)

  rerender({ active: false })
  rerender({ active: true })
  expect(onReadMachine).toHaveBeenCalledTimes(2)
})

it("cancels a visit's reads when the home connection drops and asks again on reconnect", () => {
  const onReadMachine = vi.fn((_machineId: string, _signal: AbortSignal) => new Promise<void>(() => {}))
  const clientAccess = { [studio.id]: admitted(reading({ readAt: "2026-10-06T14:03:00.000Z" })) }
  const { rerender } = renderHook(({ connected }: { connected: boolean }) => useReadOnVisit({ active: true, connected, clientAccess, onReadMachine }),
    { initialProps: { connected: true } })
  expect(onReadMachine).toHaveBeenCalledTimes(1)

  rerender({ connected: false })
  expect(onReadMachine.mock.calls[0]?.[1].aborted).toBe(true)
  expect(onReadMachine).toHaveBeenCalledTimes(1)

  rerender({ connected: true })
  expect(onReadMachine).toHaveBeenCalledTimes(2)
  expect(onReadMachine.mock.calls[1]?.[1].aborted).toBe(false)
})

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
  binding: { kind: "client", client: "tablet", clientAccess: "full" },
  lastSeenAt: "2026-08-31T11:00:00.000Z",
}

// A phone someone named after a build machine. The label lies, which is why the
// Kind column reads the binding and never the label.
const liar: PairedDeviceSummary = {
  id: `device-${"e".repeat(32)}`,
  label: "hetzner-build-runner-03",
  pairedAt: "2026-08-30T20:16:00.000Z",
  binding: { kind: "client", client: "phone", clientAccess: "full" },
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
  devicesMachineLabel?: string
  fleetOverflow?: FleetSnapshotOverflow
  devices?: PairedDeviceSummary[]
  onForgetMachine?: (machineId: string) => Promise<FleetForgetResult>
  onRevokeDevice?: (params: { deviceId: string }) => Promise<{ device: PairedDeviceSummary }>
  onRotateDevice?: (params: { deviceId: string }) => Promise<{ device: PairedDeviceSummary; token: string }>
  onRenameDevice?: (params: { deviceId: string; label: string; expectedLabel?: string }) => Promise<{ device: PairedDeviceSummary }>
  onListDevices?: () => Promise<{ devices: PairedDeviceSummary[] }>
  connected?: boolean
  readOnly?: boolean
  onMoveSessionHere?: (machineId: string) => void
  clientAccess?: Readonly<Record<string, FleetAccessState>>
  readings?: Readonly<Record<string, HeldReading>>
  onReadMachine?: (machineId: string, signal: AbortSignal) => Promise<void>
  providers?: ProviderRuntime[]
} = {}) {
  const devices = overrides.devices ?? [device]
  const onListDevices = vi.fn(overrides.onListDevices ?? (() => Promise.resolve({ devices })))
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
  const onRenameDevice = vi.fn(
    overrides.onRenameDevice
      ?? ((params: { deviceId: string; label: string }) => Promise.resolve({
        device: { ...devices.find((candidate) => candidate.id === params.deviceId)!, label: params.label },
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
  const onMoveSessionHere = vi.fn(overrides.onMoveSessionHere)
  const user = userEvent.setup()
  render(
    <TooltipProvider>
      <FleetView
        connected={overrides.connected ?? true}
        entries={overrides.entries ?? entries(local, studio)}
        currentMachineId={overrides.currentMachineId ?? local.id}
        devicesMachineLabel={overrides.devicesMachineLabel ?? local.label}
        fleetOverflow={overrides.fleetOverflow ?? null}
        currentSessionCount={2}
        onOpenSkills={() => {}}
        onListDevices={onListDevices as never}
        onRevokeDevice={onRevokeDevice as never}
        onRotateDevice={onRotateDevice as never}
        onRenameDevice={onRenameDevice as never}
        onPairMachine={onPairMachine}
        onForgetMachine={onForgetMachine}
        onUseMachine={onUseMachine}
        onOpenMachineTerminal={onOpenMachineTerminal}
        onMoveSessionHere={onMoveSessionHere}
        {...(overrides.clientAccess ? { clientAccess: overrides.clientAccess } : {})}
        {...(overrides.readOnly !== undefined ? { readOnly: overrides.readOnly } : {})}
        {...(overrides.readings ? { readings: overrides.readings } : {})}
        {...(overrides.onReadMachine ? { onReadMachine: overrides.onReadMachine } : {})}
        providers={overrides.providers ?? [claude]}
      />
    </TooltipProvider>,
  )
  return { user, onListDevices, onRevokeDevice, onRotateDevice, onRenameDevice, onPairMachine, onForgetMachine, onUseMachine, onOpenMachineTerminal, onMoveSessionHere }
}

it("renders the v2 Machines hierarchy without a settings rail", () => {
  renderFleet()

  expect(screen.getByRole("heading", { level: 1, name: "Machines" })).toBeTruthy()
  expect(screen.getByText("Each one runs its own daemon. Code, credentials and Git state stay where the work happens.")).toBeTruthy()
  expect(screen.queryByRole("complementary", { name: "Settings navigation" })).toBeNull()
  const content = document.body.textContent ?? ""
  expect(content.indexOf("Machines")).toBeLessThan(content.indexOf("Devices paired with"))
})

it("offers the active session as a transfer intent on another machine", async () => {
  const onMoveSessionHere = vi.fn()
  const healthyStudio = { ...studio, health: "healthy" as const }
  const { user } = renderFleet({
    entries: entries(local, healthyStudio),
    onMoveSessionHere,
    clientAccess: { [studio.id]: { state: "admitted", deviceId: `device-${"a".repeat(32)}`, reading: { providers: [], sessions: [], readAt: "2026-08-31T12:00:00.000Z" } } },
  })

  await user.click(screen.getByRole("button", { name: "Move a session here on studio" }))

  expect(onMoveSessionHere).toHaveBeenCalledWith(studio.id)
  expect(screen.queryByRole("button", { name: "Move a session here on workshop" })).toBeNull()
})

it("draws a distinct empty Machines state", async () => {
  renderFleet({ entries: [], devices: [] })

  expect(screen.getByText("No machines are enrolled")).toBeTruthy()
  expect(screen.getByText(/Pair a machine to reach its sessions without moving its code or credentials/u)).toBeTruthy()
  expect(await screen.findByText("No device is paired with this machine")).toBeTruthy()
})

it("draws paired-device failure and unreachable states without a loading latch", async () => {
  const failed = renderFleet({ onListDevices: () => Promise.reject(new Error("daemon stopped answering")) })
  expect((await screen.findByRole("alert")).textContent).toContain("Could not read paired devices")
  expect(screen.queryByText("Loading paired devices")).toBeNull()
  cleanup()

  failed.onListDevices.mockClear()
  renderFleet({ connected: false })
  expect(screen.getByText("Paired devices are unavailable while this daemon is unreachable.")).toBeTruthy()
  expect(screen.queryByText("Loading paired devices")).toBeNull()
})

it("describes each machine in the fleet", () => {
  renderFleet()

  const machine = screen.getByRole("group", { name: "studio" })
  expect(within(machine).getByText("studio").getAttribute("title")).toBe("darwin · arm64 · 0.4.1")
  expect(facts(machine).TRANSPORT).toBe("tailnet")
  expect(machine.textContent).toContain("Upgrade required")
})

it("names the distribution for a daemon inside WSL", () => {
  const ubuntu: FleetMachine = {
    ...studio,
    id: `machine-${"d".repeat(32)}`,
    label: "ubuntu-daemon",
    platform: "linux",
    arch: "x64",
    wsl: { distribution: "Ubuntu-24.04", version: 2 },
    health: "healthy",
  }
  renderFleet({ entries: entries(local, ubuntu) })

  const machine = screen.getByRole("group", { name: "ubuntu-daemon" })
  expect(within(machine).getByText("ubuntu-daemon").getAttribute("title")).toBe("Ubuntu-24.04 (WSL) · x64 · 0.4.1")
  expect(within(screen.getByRole("group", { name: "workshop" })).getByText("workshop").getAttribute("title")).not.toContain("(WSL)")
})

it("counts sessions only for this machine", () => {
  renderFleet()

  expect(facts(screen.getByRole("group", { name: "workshop" })).SESSIONS).toBe("2 running or waiting")
  expect(facts(screen.getByRole("group", { name: "studio" })).SESSIONS).toBe("unknown, no client credential here")
})

it("names the route a direct connection was verified on", () => {
  renderFleet({ entries: entries(local, {
    ...studio,
    connection: "direct",
    verifiedRoute: { endpoint: "wss://100.64.0.7:47831/rpc", lastAuthenticatedAt: "2026-08-31T12:00:00.000Z" },
  }) })

  expect(facts(screen.getByRole("group", { name: "studio" })).TRANSPORT).toBe("direct · 100.64.0.7:47831")
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
  expect(within(notice).getByRole("button", { name: "Copy once" })).toBeTruthy()
  await user.click(within(notice).getByRole("button", { name: "Done" }))
  expect(screen.queryByRole("status")).toBeNull()
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

  await user.click(within(receipt).getByRole("button", { name: "Copy once" }))

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

  await user.click(within(receipt).getByRole("button", { name: "Copy once" }))

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
        currentMachineId={local.id} devicesMachineLabel={local.label}
        currentSessionCount={0}
        onOpenSkills={() => {}}
        onListDevices={(() => pending) as never}
        onRevokeDevice={(() => Promise.resolve({})) as never}
        onRotateDevice={(() => Promise.resolve({})) as never}
        onRenameDevice={(() => Promise.resolve({})) as never}
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

it("renames a device in place and offers Undo after committing", async () => {
  const { user, onRenameDevice } = renderFleet()
  const row = await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(within(row).getByRole("button", { name: "Rename studio-ipad" }))
  const field = within(row).getByRole("textbox", { name: "Name for studio-ipad" })
  expect(field).toHaveProperty("value", "studio-ipad")
  await user.clear(field)
  await user.type(field, "kitchen-ipad")
  await user.click(within(row).getByRole("button", { name: "Save" }))

  expect(onRenameDevice).toHaveBeenCalledWith({ deviceId: device.id, label: "kitchen-ipad" })
  const renamed = await screen.findByRole("row", { name: /kitchen-ipad/ })
  expect(within(renamed).queryByRole("textbox")).toBeNull()
  expect(within(renamed).getByRole("button", { name: "Revoke kitchen-ipad" })).toBeTruthy()

  await user.click(within(renamed).getByRole("button", { name: "Undo" }))

  expect(onRenameDevice).toHaveBeenLastCalledWith({ deviceId: device.id, label: "studio-ipad", expectedLabel: "kitchen-ipad" })
  const restored = await screen.findByRole("row", { name: /studio-ipad/ })
  expect(within(restored).queryByRole("button", { name: "Undo" })).toBeNull()
  expect(within(restored).getByRole("button", { name: "Rename studio-ipad" })).toBeTruthy()
})

it("keeps a rename made elsewhere instead of undoing over it", async () => {
  const onRenameDevice = vi.fn()
    .mockImplementationOnce((params: { deviceId: string; label: string }) =>
      Promise.resolve({ device: { ...device, label: params.label } }))
    .mockRejectedValueOnce(new DaemonRpcError(
      deviceLabelMismatchErrorCode,
      "Paired device is called desk-ipad, not the label this rename expected",
      { kind: "device-label-mismatch", device: { ...device, label: "desk-ipad" } },
    ))
  const { user } = renderFleet({ onRenameDevice })
  const row = await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(within(row).getByRole("button", { name: "Rename studio-ipad" }))
  await user.clear(within(row).getByRole("textbox", { name: "Name for studio-ipad" }))
  await user.keyboard("kitchen-ipad{Enter}")
  const renamed = await screen.findByRole("row", { name: /kitchen-ipad/ })

  await user.click(within(renamed).getByRole("button", { name: "Undo" }))

  const current = await screen.findByRole("row", { name: /desk-ipad/ })
  expect(within(current).queryByRole("button", { name: "Undo" })).toBeNull()
  expect(within(current).getByRole("button", { name: "Rename desk-ipad" })).toBeTruthy()
  expect(screen.queryByRole("row", { name: /studio-ipad/ })).toBeNull()
  expect(onRenameDevice).toHaveBeenCalledTimes(2)
  expect(onRenameDevice).toHaveBeenLastCalledWith({ deviceId: device.id, label: "studio-ipad", expectedLabel: "kitchen-ipad" })
  const alert = await screen.findByRole("alert")
  expect(alert.textContent).toContain("changed elsewhere")
  expect(alert.textContent).toContain("desk-ipad")
})

it("commits a rename with Enter and abandons one with Escape", async () => {
  const { user, onRenameDevice } = renderFleet()
  const row = await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(within(row).getByRole("button", { name: "Rename studio-ipad" }))
  await user.clear(within(row).getByRole("textbox", { name: "Name for studio-ipad" }))
  await user.keyboard("desk-ipad{Escape}")

  expect(onRenameDevice).not.toHaveBeenCalled()
  expect(within(row).queryByRole("textbox")).toBeNull()
  expect(row.textContent).toContain("studio-ipad")

  await user.click(within(row).getByRole("button", { name: "Rename studio-ipad" }))
  await user.clear(within(row).getByRole("textbox", { name: "Name for studio-ipad" }))
  await user.keyboard("desk-ipad{Enter}")

  expect(onRenameDevice).toHaveBeenCalledWith({ deviceId: device.id, label: "desk-ipad" })
  expect(await screen.findByRole("row", { name: /desk-ipad/ })).toBeTruthy()
})

it("keeps an empty or unchanged label out of the daemon", async () => {
  const { user, onRenameDevice } = renderFleet()
  const row = await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(within(row).getByRole("button", { name: "Rename studio-ipad" }))
  const field = within(row).getByRole("textbox", { name: "Name for studio-ipad" })
  await user.clear(field)
  await user.type(field, "   ")
  await user.click(within(row).getByRole("button", { name: "Save" }))

  expect(onRenameDevice).not.toHaveBeenCalled()
  expect(field.getAttribute("aria-invalid")).toBe("true")

  await user.click(within(row).getByRole("button", { name: "Cancel" }))
  await user.click(within(row).getByRole("button", { name: "Rename studio-ipad" }))
  await user.click(within(row).getByRole("button", { name: "Save" }))

  expect(onRenameDevice).not.toHaveBeenCalled()
  expect(within(row).queryByRole("textbox")).toBeNull()
})

it("keeps the draft open for retry and says why when a rename is refused", async () => {
  const onRenameDevice = vi.fn()
    .mockRejectedValueOnce(new Error("Managing paired devices requires the daemon credential"))
    .mockImplementationOnce((params: { deviceId: string; label: string }) =>
      Promise.resolve({ device: { ...device, label: params.label } }))
  const { user } = renderFleet({ onRenameDevice })
  const row = await screen.findByRole("row", { name: /studio-ipad/ })

  await user.click(within(row).getByRole("button", { name: "Rename studio-ipad" }))
  await user.clear(within(row).getByRole("textbox", { name: "Name for studio-ipad" }))
  await user.keyboard("kitchen-ipad{Enter}")

  expect((await screen.findByRole("alert")).textContent)
    .toContain("Managing paired devices requires the daemon credential")
  const field = within(row).getByRole("textbox", { name: "Name for studio-ipad" })
  expect(field).toHaveProperty("value", "kitchen-ipad")
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()

  await user.click(within(row).getByRole("button", { name: "Save" }))

  expect(onRenameDevice).toHaveBeenCalledTimes(2)
  expect(onRenameDevice).toHaveBeenLastCalledWith({ deviceId: device.id, label: "kitchen-ipad" })
  const renamed = await screen.findByRole("row", { name: /kitchen-ipad/ })
  expect(within(renamed).queryByRole("textbox")).toBeNull()
  expect(within(renamed).getByRole("button", { name: "Undo" })).toBeTruthy()
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

it("keeps machine, pairing, and device mutations locked while watching", async () => {
  renderFleet({ readOnly: true })
  const row = await screen.findByRole("row", { name: /studio-ipad/ })

  expect(screen.getByRole("button", { name: "Pair a machine" })).toHaveProperty("disabled", true)
  expect(screen.queryByRole("button", { name: /^Open its/u })).toBeNull()
  expect(within(row).getByRole("button", { name: "Rename studio-ipad" })).toHaveProperty("disabled", true)
  expect(within(row).getByRole("button", { name: "Rotate the credential on studio-ipad" })).toHaveProperty("disabled", true)
  expect(within(row).getByRole("button", { name: "Revoke studio-ipad" })).toHaveProperty("disabled", true)
})

it("refuses to open a remote machine and names the missing credential", async () => {
  const { user, onUseMachine } = renderFleet()

  const card = within(screen.getByRole("group", { name: "studio" }))
  const open = card.getByRole("button", { name: "Open its sessions on studio" })
  expect(open).toHaveProperty("disabled", true)
  expect(card.getByText(/Machine pairing alone does not grant client access/u)).toBeTruthy()
  expect(card.queryByText(remoteControlRefusal)).toBeNull()
  await user.click(open)
  expect(onUseMachine).not.toHaveBeenCalled()
})

it("opens this machine from its card when the client is attached elsewhere", async () => {
  const { user, onUseMachine } = renderFleet({ currentMachineId: studio.id })

  const card = within(screen.getByRole("group", { name: "workshop" }))
  await user.click(card.getByRole("button", { name: "Open its sessions on workshop" }))

  expect(onUseMachine).toHaveBeenCalledWith(local.id)
  expect(card.queryByText(/Machine pairing alone/u)).toBeNull()
})

it("opens the sessions of the machine already in use", async () => {
  const { user, onUseMachine } = renderFleet()

  const card = within(screen.getByRole("group", { name: "workshop" }))
  await user.click(card.getByRole("button", { name: "Open its 2 sessions on workshop" }))
  expect(onUseMachine).toHaveBeenCalledWith(local.id)
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
      currentMachineId={studio.id} devicesMachineLabel={local.label}
      currentSessionCount={2}
      onOpenSkills={() => {}}
      onListDevices={(() => Promise.resolve({ devices: [] })) as never}
      onRevokeDevice={(() => Promise.resolve({})) as never}
      onRotateDevice={(() => Promise.resolve({})) as never}
      onRenameDevice={(() => Promise.resolve({})) as never}
      onUseMachine={onUseMachine}
      onOpenMachineTerminal={vi.fn()}
    />,
  )

  const card = within(screen.getByRole("group", { name: "workshop" }))
  expect(card.getByRole("button", { name: "Open its sessions on workshop" })).toHaveProperty("disabled", true)
  expect(card.getByRole("button", { name: "Terminal on workshop" })).toHaveProperty("disabled", true)
})

it("keeps an unreachable machine listed, dimmed, and names the unknown state", () => {
  renderFleet({ entries: entries(local, { ...studio, health: "unreachable" }) })

  const card = screen.getByRole("group", { name: "studio" })
  expect(card.className.split(" ")).toContain("opacity-[.72]")
  expect(card.textContent).toContain("The daemon reports studio as unreachable. Its sessions are not reported as stopped.")
  expect(facts(card).SESSIONS).toBe("unknown, no client credential here")
})

it("says what stalled is unknown when this client never read the machine", async () => {
  const { user } = renderFleet({ entries: entries(local, { ...studio, health: "unreachable" }) })

  const stalled = screen.getByRole("button", { name: "See what stalled on studio" })
  await user.click(stalled)
  expect(document.getElementById(stalled.getAttribute("aria-controls") ?? "")?.textContent)
    .toBe("What was running on studio is unknown: this app holds no client credential for it.")
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

// v2 names whose list this is, because each daemon keeps its own and a person
// who pairs from Settings should not look for the device on another machine.
it("names the daemon that keeps the paired-device list", async () => {
  renderFleet()
  const section = screen.getByRole("region", { name: `Devices paired with ${local.label}` })
  expect(within(section).getByRole("heading", { name: `Devices paired with ${local.label}` })).toBeTruthy()
  expect(section.textContent).toContain("Each daemon keeps its own list. Pair a new one from Settings.")
  expect(await within(section).findByText(device.label)).toBeTruthy()
})

it("names the daemon that answers the device list while another machine is in use", async () => {
  const { onListDevices } = renderFleet({ currentMachineId: studio.id, devicesMachineLabel: local.label })
  const section = screen.getByRole("region", { name: `Devices paired with ${local.label}` })
  expect(within(section).getByRole("heading", { name: `Devices paired with ${local.label}` })).toBeTruthy()
  expect(within(section).queryByRole("heading", { name: `Devices paired with ${studio.label}` })).toBeNull()
  expect(await within(section).findByText(device.label)).toBeTruthy()
  expect(onListDevices).toHaveBeenCalled()
})
