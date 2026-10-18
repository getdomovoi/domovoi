import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type FleetEntry, type FleetMachine, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen, within } from "@testing-library/react-native"

import { SessionsScreen } from "./sessions"

function entry(label: string, health: FleetMachine["health"], self = false): FleetEntry {
  return {
    kind: "machine",
    machine: {
      id: `machine-${label.padEnd(32, "0")}`, label, platform: "linux", arch: "x64", version: "0.0.1",
      connection: "tailnet", capabilities: ["sessions"], protocolVersion: "0.2.0", transports: [],
      heartbeat: { state: health === "unreachable" ? "offline" : "online", lastSeenAt: "2026-09-18T00:00:00.000Z" },
      health, self,
    },
  }
}

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

async function draw(overrides: Partial<Parameters<typeof SessionsScreen>[0]> = {}) {
  // Unless a test says otherwise, the daemon's clock agrees with the phone's.
  const now = overrides.now ?? Date.now()
  const props = {
    snapshot: workspace(),
    fleet: undefined,
    notice: undefined,
    live: true,
    lastReadAt: undefined as number | undefined,
    refreshing: false,
    now,
    fleetNow: now,
    onOpenSession: jest.fn<(sessionId: string) => void>(),
    onOpenApproval: jest.fn<(approvalId: string) => void>(),
    onRefresh: jest.fn<() => void>(),
    onStartSession: jest.fn<() => void>(),
    startDisabledReason: undefined as string | undefined,
    bottomInset: 0,
    ...overrides,
  }
  await render(<SessionsScreen {...props} />)
  return props
}

// Everything a person can tap, in the order it is drawn. The lead card and the
// session cards are all buttons, so their order here is their order on screen.
function tappable(): string[] {
  return screen.getAllByRole("button").map((node) => {
    if (typeof node.props.accessibilityLabel === "string") return node.props.accessibilityLabel
    return within(node).queryAllByText(/.+/).map((child) => String(child.props.children)).join(" ")
  })
}

describe("SessionsScreen", () => {
  // Phone v2 frame 01: a session waiting on you says how long it has waited,
  // after its machine. Rows that wait on nobody carry no clock.
  it("says how long a waiting session has waited on you", async () => {
    const snapshot = workspace()
    const approval = snapshot.approvals[0]
    if (!approval) throw new Error("fixture needs a pending approval")
    await draw({ snapshot, now: Date.parse(approval.requestedAt) + 4 * 60_000 })

    expect(screen.getByText(`${snapshot.machine.name} · 4m`)).toBeOnTheScreen()
    // Only the waiting card carries a clock after its machine.
    expect(screen.getAllByText(new RegExp(`^${snapshot.machine.name} · (now|\\d+[mhd])$`))).toHaveLength(1)
  })

  // The card opens the approval its clock counts from: the earliest one the
  // session holds, whatever order the snapshot lists them in.
  it("opens the approval the session has waited on longest", async () => {
    const snapshot = workspace()
    const later = snapshot.approvals[0]
    if (!later) throw new Error("fixture needs a pending approval")
    const earlier = { ...later, id: `${later.id}-earlier`, requestedAt: new Date(Date.parse(later.requestedAt) - 10 * 60_000).toISOString() }
    snapshot.approvals.push(earlier)
    const session = snapshot.sessions.find((candidate) => candidate.id === later.sessionId)
    if (!session) throw new Error("fixture needs the approval's session")
    const { onOpenApproval } = await draw({ snapshot, now: Date.parse(later.requestedAt) })

    await fireEvent.press(screen.getByRole("button", { name: session.title }))

    expect(onOpenApproval).toHaveBeenCalledWith(earlier.id)
  })

  // Ruling Q358 A: idle sessions stay under QUIET, and fleet machines that do
  // not answer get an UNREACHABLE line of their own. The phone holds no
  // sessions from them, so the line names the machine and when it was last
  // seen.
  it("lists fleet machines that do not answer under UNREACHABLE", async () => {
    const now = Date.parse("2026-09-20T00:00:00.000Z")
    await draw({ now, fleet: [entry("mac-mini", "healthy", true), entry("wsl", "unreachable")] })

    expect(screen.getByText("UNREACHABLE")).toBeOnTheScreen()
    expect(screen.getByText("wsl")).toBeOnTheScreen()
    expect(screen.getByText("last seen 2d ago")).toBeOnTheScreen()
    expect(screen.queryByText("mac-mini")).toBeNull()
  })

  // #781: a heartbeat's time is the daemon's, so how long a machine has been
  // silent is measured on the daemon's clock (fleetNow). How long a session
  // has waited on you stays on the phone's.
  it("measures a machine's silence on the daemon's clock and a wait on the phone's", async () => {
    const snapshot = workspace()
    const approval = snapshot.approvals[0]
    if (!approval) throw new Error("fixture needs a pending approval")
    await draw({
      snapshot,
      now: Date.parse(approval.requestedAt) + 4 * 60_000,
      fleetNow: Date.parse("2026-09-18T00:05:00.000Z"),
      fleet: [entry("mac-mini", "healthy", true), entry("wsl", "unreachable")],
    })

    expect(screen.getByText("last seen 5m ago")).toBeOnTheScreen()
    expect(screen.getByText(`${snapshot.machine.name} · 4m`)).toBeOnTheScreen()
  })

  it("measures a quiet machine's silence on the daemon's clock", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    await draw({
      snapshot: idle,
      now: Date.parse("2026-09-20T00:00:00.000Z"),
      fleetNow: Date.parse("2026-09-18T00:05:00.000Z"),
      fleet: [entry("mac-mini", "healthy", true), entry("wsl", "unreachable")],
    })

    expect(screen.getByText("last seen 5m ago")).toBeOnTheScreen()
  })

  it("draws no UNREACHABLE line when every machine answers", async () => {
    await draw({ fleet: [entry("mac-mini", "healthy", true), entry("hetzner", "healthy")] })
    expect(screen.queryByText("UNREACHABLE")).toBeNull()
  })

  // Phone v2 frames 01 and 10 put the Domovoi mark beside the title.
  it("marks the Sessions title with the Domovoi mark", async () => {
    await draw()
    expect(screen.getByTestId("domovoi-mark", { includeHiddenElements: true })).toBeOnTheScreen()
    // The Sessions heading names the screen; the mark is not announced.
    expect(screen.queryByRole("image", { name: "Domovoi" })).toBeNull()
  })

  it("has no global stop control in its header", async () => {
    await draw()
    expect(screen.queryByRole("button", { name: "Stop everything" })).toBeNull()
  })

  it("leads with the waiting session once, inside NEEDS YOU", async () => {
    const { snapshot } = await draw()
    const waiting = snapshot.sessions.find((session) => session.id === snapshot.approvals[0]?.sessionId)
    if (!waiting) throw new Error("fixture needs a pending approval")

    const order = tappable()
    const firstSession = order.findIndex((label) =>
      snapshot.sessions.some((session) => session.title === label))

    expect(screen.getByText("NEEDS YOU")).toBeOnTheScreen()
    expect(order.filter((label) => label === waiting.title)).toHaveLength(1)
    expect(order.some((label) => typeof label === "string" && label.startsWith("1 approval waiting"))).toBe(false)
    expect(order[firstSession]).toBe(waiting.title)
  })

  it("opens the waiting approval from its single session card", async () => {
    const { snapshot, onOpenApproval, onOpenSession } = await draw()
    const waiting = snapshot.approvals[0]
    const session = snapshot.sessions.find((entry) => entry.id === waiting?.sessionId)
    if (!waiting || !session) throw new Error("fixture needs a pending approval")

    await fireEvent.press(screen.getByRole("button", { name: session.title }))

    expect(onOpenApproval).toHaveBeenCalledWith(waiting.id)
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  it("shows no approval card when nothing is waiting", async () => {
    const snapshot = workspace()
    snapshot.approvals = []
    await draw({ snapshot })

    expect(screen.queryByText(/approvals? waiting/)).toBeNull()
    for (const session of snapshot.sessions) {
      expect(screen.getByText(session.title)).toBeOnTheScreen()
    }
  })

  it("opens the session that was pressed", async () => {
    const { snapshot, onOpenSession } = await draw()
    const session = snapshot.sessions[1]
    if (!session) throw new Error("fixture needs a second session")

    await fireEvent.press(screen.getByRole("button", { name: session.title }))

    expect(onOpenSession).toHaveBeenCalledWith(session.id)
  })

  it("groups sessions under needs-you, running and quiet, in that order", async () => {
    const { snapshot } = await draw()
    const waiting = snapshot.sessions.find((session) => session.id === snapshot.approvals[0]?.sessionId)
    if (!waiting) throw new Error("fixture needs a pending approval")

    const headings = ["NEEDS YOU", "RUNNING", "QUIET"].map((label) => screen.getByText(label))
    expect(headings).toHaveLength(3)
    expect(screen.getByText("1 needs you")).toBeOnTheScreen()

    // The session holding the approval is the first card after the lead.
    const order = tappable()
    const firstSession = order.findIndex((label) =>
      snapshot.sessions.some((session) => session.title === label))
    expect(order[firstSession]).toBe(waiting.title)
  })

  // Phone v2 frame 01: the header's count is a warning pill of its own, not
  // the head of the meta line, and each group's count is a pill tinted with
  // the group's state. Needs-you cards wear the warning ground and border, and
  // the gate is a pill on the card rather than an uppercase label.
  it("draws frame 01's pills and needs-you cards", async () => {
    const { snapshot } = await draw()
    const waiting = snapshot.sessions.find((session) => session.id === snapshot.approvals[0]?.sessionId)
    if (!waiting) throw new Error("fixture needs a pending approval")

    const needed = screen.getByTestId("needs-you-pill")
    expect(within(needed).getByText("1 needs you")).toBeOnTheScreen()
    expect(String(needed.props.className)).toContain("bg-warn-bg")
    expect(String(within(needed).getByText("1 needs you").props.className)).toContain("text-warn-fg")
    expect(screen.queryByText(/^1 needs? you · /)).toBeNull()
    expect(screen.getByText(/^macbook-pro-m3 · 1 running$/)).toBeOnTheScreen()

    const tints = Object.fromEntries(["needs-you", "running", "quiet"].map((id) => [
      id,
      String(screen.getByTestId(`group-count-${id}`).props.className),
    ]))
    expect(tints["needs-you"]).toContain("bg-warning/15")
    expect(tints.running).toContain("bg-success/15")
    expect(tints.quiet).toContain("bg-muted")

    const card = screen.getByRole("button", { name: waiting.title })
    expect(String(card.props.className)).toContain("border-warn-border")
    expect(String(card.props.className)).toContain("bg-warn-bg")
    expect(within(card).getByText("gate")).toBeOnTheScreen()
    expect(within(card).queryByText("approval")).toBeNull()

    const other = snapshot.sessions.find((session) => session.id !== waiting.id)
    if (!other) throw new Error("fixture needs a second session")
    const calm = screen.getByRole("button", { name: other.title })
    expect(String(calm.props.className)).not.toContain("bg-warn-bg")
    expect(within(calm).queryByText("gate")).toBeNull()
  })

  // Walk F19: the pill agrees with its count, as frame 01's "2 need you" does.
  it("says one session needs you and two need you", async () => {
    const snapshot = workspace()
    const first = snapshot.approvals[0]
    const other = snapshot.sessions.find((session) => session.id !== first?.sessionId)
    if (!first || !other) throw new Error("fixture needs a pending approval and a second session")
    snapshot.approvals.push({ ...first, id: `${first.id}-other`, sessionId: other.id })
    await draw({ snapshot })

    expect(within(screen.getByTestId("needs-you-pill")).getByText("2 need you")).toBeOnTheScreen()
  })

  // Walk F12: under "Not connected", a refused credential, or a hello not yet
  // answered, the list is the last state the phone was sent. The header says
  // its counts are from that read and when the phone got it, and drops the
  // fleet part: "reachable" is a claim about now.
  it("says the header counts are from the last read while not live", async () => {
    const snapshot = workspace()
    const now = new Date(2026, 9, 15, 17, 8, 0).getTime()
    const lastReadAt = new Date(2026, 9, 15, 16, 52, 10).getTime()
    await draw({
      snapshot,
      now,
      live: false,
      lastReadAt,
      fleet: [entry("mac-mini", "healthy", true), entry("hetzner", "healthy")],
      notice: { tone: "destructive", headline: "The daemon refused this credential", detail: "Pair again in Settings." },
    })

    expect(screen.getByText(`${snapshot.machine.name} · 1 running when last read at 16:52`)).toBeOnTheScreen()
    expect(screen.queryByText(/reachable/)).toBeNull()
  })

  // A green light says a session runs now. Read before the connection went,
  // it no longer says that, so no card or group count keeps one.
  it("drops the live lights from cached session cards while not live", async () => {
    await draw()
    expect(screen.getAllByTestId("session-dot").some((dot) => String(dot.props.className).includes("bg-success"))).toBe(true)
    expect(String(screen.getByTestId("group-count-running").props.className)).toContain("bg-success/15")

    await draw({ live: false, notice: { tone: "warning", headline: "Not connected", detail: "Nothing here is live." } })
    for (const dot of screen.getAllByTestId("session-dot")) {
      expect(String(dot.props.className)).not.toMatch(/bg-success|bg-warning/)
      expect(String(dot.props.className)).toContain("bg-faint")
    }
    expect(String(screen.getByTestId("group-count-running").props.className)).not.toContain("bg-success")
    // The approval is still the last fact the phone holds about it, so its
    // card keeps its place and ground.
    expect(screen.getByText("NEEDS YOU")).toBeOnTheScreen()
  })

  it("tints the UNREACHABLE count as muted", async () => {
    await draw({ fleet: [entry("mac-mini", "healthy", true), entry("wsl", "unreachable")] })
    expect(String(screen.getByTestId("group-count-unreachable").props.className)).toContain("bg-muted")
  })

  it("says nobody is needed only by leaving the count out", async () => {
    const calm = workspace()
    calm.approvals = []
    await draw({ snapshot: calm })

    expect(screen.queryByText(/need you/)).toBeNull()
    expect(screen.queryByText("NEEDS YOU")).toBeNull()
  })

  it("names the machine, and says how many of the fleet answered only once the fleet has been read", async () => {
    await draw({ fleet: undefined })
    expect(screen.queryByText(/reachable|offline/)).toBeNull()
    expect(screen.getByText(/macbook-pro-m3 · 1 running$/)).toBeOnTheScreen()

    await draw({ fleet: [entry("a", "healthy"), entry("b", "healthy"), entry("c", "unreachable")] })
    expect(screen.getByText(/ · 2 reachable · 1 offline$/)).toBeOnTheScreen()
    expect(screen.queryByText(/3 machines/)).toBeNull()
  })

  // The daemon answered and has nothing open. That is a fact about the machine,
  // not a phone that has failed to look, and the screen has to say which.
  it("names the healthy idle state and offers one start action", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    await draw({ snapshot: idle, fleet: [entry("a", "healthy"), entry("b", "healthy")] })

    expect(screen.getByText("Everything is idle")).toBeOnTheScreen()
    expect(tappable()).toEqual(["Start a session"])
  })

  // The sentence is a fact about the fleet the phone was given. One machine
  // must not read as two, and the phone holds only its own machine's
  // sessions, so it vouches for that machine's idleness and no other's.
  it("says how many machines answer from the fleet, and vouches only for its own", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    const machine = idle.machine.name

    await draw({ snapshot: idle, fleet: undefined })
    expect(screen.getByText(`${machine} is answering and has no work in flight. Empty here is a healthy state, not a failure.`)).toBeOnTheScreen()
    expect(screen.queryByText(/Two machines/)).toBeNull()

    await draw({ snapshot: idle, fleet: [entry(machine, "healthy", true)] })
    expect(screen.getByText(`${machine} is answering and has no work in flight. Empty here is a healthy state, not a failure.`)).toBeOnTheScreen()

    await draw({ snapshot: idle, fleet: [entry(machine, "healthy", true), entry("hetzner", "healthy"), entry("wsl", "unreachable")] })
    expect(screen.getByText(`2 machines are answering. ${machine}, the one this phone reads, has no work in flight. Empty here is a healthy state, not a failure.`)).toBeOnTheScreen()
  })

  // A fleet read before the connection dropped says nothing about now. While
  // the banner says so, the idle card drops the count and speaks of the last
  // read rather than claiming machines are answering.
  it("does not count answering machines while the connection is down", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    const machine = idle.machine.name
    await draw({
      snapshot: idle,
      fleet: [entry(machine, "healthy", true), entry("hetzner", "healthy")],
      notice: { tone: "warning", headline: "Not connected", detail: "Nothing here is live. This is the last state the phone was sent." },
    })

    expect(screen.getByText(`${machine} had no work in flight when last read.`)).toBeOnTheScreen()
    expect(screen.queryByText(/answering/)).toBeNull()
  })

  // Walk F12 review: "Everything is idle" on the success ground is a claim
  // about now. While not live the card says it was idle when last read, on a
  // plain ground, and the sentence under it says the same.
  it("says the machine was idle when last read while not live, without the healthy ground", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    await draw({ snapshot: idle, live: false })

    expect(screen.queryByText("Everything is idle")).toBeNull()
    const title = screen.getByText("Idle when last read")
    expect(String(title.props.className)).not.toContain("text-ok-fg")
    expect(screen.getByText(`${idle.machine.name} had no work in flight when last read.`)).toBeOnTheScreen()
    expect(String(screen.getByTestId("idle-card").props.className)).not.toMatch(/bg-ok-bg|border-ok-border/)

    await draw({ snapshot: idle })
    expect(screen.getByText("Everything is idle")).toBeOnTheScreen()
    expect(String(screen.getByTestId("idle-card").props.className)).toContain("bg-ok-bg")
  })

  // Frame 10's rows say a machine's state in a few words ("last seen 2d ago"),
  // not a sentence that repeats the machine's name beside it.
  it("says a quiet machine's state in the design's short words", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    const now = Date.parse("2026-09-20T00:00:00.000Z")
    await draw({ snapshot: idle, now, fleet: [entry("mac-mini", "healthy", true), entry("wsl", "unreachable")] })

    expect(screen.getByText("last seen 2d ago")).toBeOnTheScreen()
    expect(screen.queryByText(/cannot be reached/)).toBeNull()
  })

  // A green light says a machine answers now. Read before the connection
  // dropped, it no longer says that, so no row keeps a green light while the
  // banner says the phone is not connected.
  it("drops the answering lights while the connection is down", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    const fleet = [entry("mac-mini", "healthy", true), entry("hetzner", "healthy")]

    await draw({ snapshot: idle, fleet })
    expect(screen.getAllByTestId("fleet-dot").map((dot) => String(dot.props.className))).toEqual([
      expect.stringContaining("bg-success"),
      expect.stringContaining("bg-success"),
    ])

    await draw({ snapshot: idle, fleet, notice: { tone: "warning", headline: "Not connected", detail: "Nothing here is live." } })
    for (const dot of screen.getAllByTestId("fleet-dot")) expect(String(dot.props.className)).not.toContain("bg-success")
  })

  // A machine that answered and asked to be paired again is not a machine
  // that went quiet, so it says what it wants rather than when it was seen.
  it("says a machine that needs pairing again wants pairing", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    await draw({ snapshot: idle, now: Date.parse("2026-09-20T00:00:00.000Z"), fleet: [entry("mac-mini", "healthy", true), entry("old-box", "pairing-required")] })

    expect(screen.getByText("Pair again")).toBeOnTheScreen()
    expect(screen.queryByText(/last seen/)).toBeNull()
  })

  // Frame 10 lists the fleet under the idle card, one row per machine.
  it("lists the fleet under the idle card", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    await draw({ snapshot: idle, fleet: [entry("mac-mini", "healthy", true), entry("hetzner", "healthy"), entry("wsl", "unreachable")] })

    for (const label of ["mac-mini", "hetzner", "wsl"]) expect(screen.getByText(label)).toBeOnTheScreen()
  })

  it("keeps Start a session visible and disabled with the exact no-project reason", async () => {
    const idle = workspace()
    idle.sessions = []
    idle.approvals = []
    const reason = "Open a project on the machine before starting a session."
    await draw({ snapshot: idle, startDisabledReason: reason })

    expect(screen.getByRole("button", { name: "Start a session" })).toBeDisabled()
    expect(screen.getByText(reason)).toBeOnTheScreen()
  })

  it("says nothing about being empty while a session is listed", async () => {
    await draw()
    expect(screen.queryByText("No sessions running")).toBeNull()
  })

  // There is no push without the relay, so a gate reaches a phone only over
  // the connection the open app holds. The list says so where gates land.
  it("says a gate reaches this phone only while Domovoi is open", async () => {
    await draw()
    expect(screen.getByText("Keep Domovoi open to answer gates. Nothing is pushed to this phone yet.")).toBeOnTheScreen()
  })
})
