import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { SessionsScreen } from "./sessions"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

async function draw(overrides: Partial<Parameters<typeof SessionsScreen>[0]> = {}) {
  const props = {
    snapshot: workspace(),
    machineCount: undefined,
    notice: undefined,
    refreshing: false,
    now: Date.now(),
    onOpenSession: jest.fn<(sessionId: string) => void>(),
    onOpenApproval: jest.fn<(approvalId: string) => void>(),
    onPauseAll: jest.fn<() => void>(),
    onRefresh: jest.fn<() => void>(),
    ...overrides,
  }
  await render(<SessionsScreen {...props} />)
  return props
}

// Everything a person can tap, in the order it is drawn. The lead card and the
// session cards are all buttons, so their order here is their order on screen.
function tappable(): string[] {
  return screen.getAllByRole("button").map((node) =>
    typeof node.props.accessibilityLabel === "string"
      ? node.props.accessibilityLabel
      : node.props.children,
  )
}

describe("SessionsScreen", () => {
  it("leads with the waiting approval, above every session", async () => {
    const { snapshot } = await draw()
    const waiting = snapshot.approvals[0]
    if (!waiting) throw new Error("fixture needs a pending approval")

    const order = tappable()
    const lead = order.findIndex((label) =>
      typeof label === "string" && label.startsWith("1 approval waiting"))
    const firstSession = order.findIndex((label) =>
      snapshot.sessions.some((session) => session.title === label))

    expect(lead).toBeGreaterThan(-1)
    expect(firstSession).toBeGreaterThan(-1)
    expect(lead).toBeLessThan(firstSession)
    // The card says what is waiting and where, not just that something is.
    expect(screen.getByText(waiting.command)).toBeOnTheScreen()
    expect(screen.getByText(new RegExp(`^${waiting.machine} · `))).toBeOnTheScreen()
  })

  it("opens the waiting approval when its card is pressed", async () => {
    const { snapshot, onOpenApproval } = await draw()
    const waiting = snapshot.approvals[0]
    if (!waiting) throw new Error("fixture needs a pending approval")

    await fireEvent.press(screen.getByRole("button", { name: /^1 approval waiting/ }))

    expect(onOpenApproval).toHaveBeenCalledWith(waiting.id)
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

  it("does not claim a machine count it has not been given", async () => {
    await draw({ machineCount: undefined })
    expect(screen.queryByText(/machine/)).toBeNull()

    await draw({ machineCount: 3 })
    expect(screen.getByText(/^3 machines · /)).toBeOnTheScreen()
  })
})
