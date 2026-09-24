import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type FleetEntry, type FleetMachine, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen, within } from "@testing-library/react-native"

import { SessionsScreen } from "./sessions"

function entry(label: string, health: FleetMachine["health"]): FleetEntry {
  return {
    kind: "machine",
    machine: {
      id: `machine-${label.padEnd(32, "0")}`, label, platform: "linux", arch: "x64", version: "0.0.1",
      connection: "tailnet", capabilities: ["sessions"], protocolVersion: "0.2.0", transports: [],
      heartbeat: { state: health === "unreachable" ? "offline" : "online", lastSeenAt: "2026-09-18T00:00:00.000Z" },
      health, self: false,
    },
  }
}

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

async function draw(overrides: Partial<Parameters<typeof SessionsScreen>[0]> = {}) {
  const props = {
    snapshot: workspace(),
    fleet: undefined,
    notice: undefined,
    refreshing: false,
    now: Date.now(),
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
    expect(screen.getByText(/^1 need you · /)).toBeOnTheScreen()

    // The session holding the approval is the first card after the lead.
    const order = tappable()
    const firstSession = order.findIndex((label) =>
      snapshot.sessions.some((session) => session.title === label))
    expect(order[firstSession]).toBe(waiting.title)
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
    expect(screen.getByText("Two machines are answering and neither has work in flight. Empty here is a healthy state, not a failure.")).toBeOnTheScreen()
    expect(tappable()).toEqual(["Start a session"])
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
