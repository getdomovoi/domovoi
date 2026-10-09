import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace, type SessionHistoryEntry, type SessionHistoryPage } from "@getdomovoi/protocol"
import { TooltipProvider } from "./components/ui/tooltip"
import { ArtifactDock } from "./artifact-dock"
import { dockTabDefinitions } from "./dock-tabs"
import { HistoryPanel } from "./history-panel"

function renderDock(): HTMLElement {
  render(
    <TooltipProvider>
      <ArtifactDock
        snapshot={demoWorkspace}
        onCollapse={() => {}}
        defaultTab="changes"
        rpcUrl="ws://127.0.0.1:47831/rpc"
        authorizeArtifact={async () => { throw new Error("not used") }}
        connected
        terminalControls={{ claim: async () => {}, release: async () => {}, write: async () => {}, resize: async () => {} } as never}
        onReplyToAnnotation={async () => {}}
        onSetAnnotationStatus={async () => {}}
        onCreateAnnotation={async () => {}}
        onLoadSessionHistory={async () => ({
          sessionId: demoWorkspace.sessions[0]?.id ?? "",
          items: [],
          hasMore: false,
        })}
        onRestoreCheckpoint={async () => {}}
        onForkCheckpoint={async () => {}}
        onRevokeApprovalRule={async () => {}}
        onLoadHardGates={async () => []}
        onLoadSessionEvidence={async () => { throw new Error("not used") }}
        onRevertSessionFile={async () => {}}
      />
    </TooltipProvider>,
  )
  const row = screen.getAllByRole("tablist").find((list) => {
    const names = within(list).queryAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    return names.includes("Checkpoints")
  })
  if (!row) throw new Error("the dock tab row is missing")
  return row
}

describe("the dock tab row follows the design", () => {
  it("draws every tab as an icon, with the label carried by the accessible name", () => {
    const row = renderDock()
    for (const definition of dockTabDefinitions) {
      const tab = within(row).getByRole("tab", { name: definition.label })
      expect(tab.textContent, `${definition.id} draws its label as text`).toBe("")
      expect(tab.querySelector("svg"), `${definition.id} draws no icon`).toBeTruthy()
    }
  })

  it("names every tab exactly as the design names it", () => {
    const row = renderDock()
    const names = within(row).getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    expect(names).toEqual(dockTabDefinitions.map((definition) => definition.label))
  })

  it("puts the label and the note in the tooltip, where the design draws them", async () => {
    const user = userEvent.setup()
    const row = renderDock()
    const changes = dockTabDefinitions.find((definition) => definition.id === "changes")
    if (!changes) throw new Error("the changes tab is missing from the definitions")
    await user.hover(within(row).getByRole("tab", { name: changes.label }))
    const tip = await screen.findByRole("tooltip")
    expect(tip.textContent).toContain(changes.label)
    expect(tip.textContent).toContain(changes.note)
  })
})

// The design's tip offers a fork from any turn, with the oldest row at the
// bottom. Turn-row fork was closed as a design error (f3252e50): session.fork
// takes a checkpointId and nothing else, and the History tab offers Fork from
// here on checkpoint rows only. The daemon pages history oldest first and the
// tab turns it round, so the oldest row is at the bottom as drawn.
describe("the History tab tip", () => {
  it("offers a fork from a checkpoint and puts the oldest row where the tab does", () => {
    const tip = dockTabDefinitions.find((definition) => definition.id === "history")?.note ?? ""
    expect(tip).toBe("Everything that happened in this session, by category, oldest at the bottom. Fork from a checkpoint.")
  })

  const entry = (sourceId: string, createdAt: string): SessionHistoryEntry => ({
    id: `thread:${sourceId}`,
    sourceId,
    sessionId: "session-billing",
    createdAt,
    category: "tools",
    tool: "command",
    status: "completed",
    title: sourceId,
  })
  const times = () => screen.getAllByTestId("history-row").map((row) => within(row).getByTestId("history-time").textContent)
  const follows = (later: Element, earlier: Element) =>
    Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)

  // The tip's order clause is a claim about the panel, so the panel is held to
  // it: the daemon pages history oldest first and the tab draws it newest first.
  it("matches the panel, which draws the newest row first", async () => {
    const page: SessionHistoryPage = {
      sessionId: "session-billing",
      hasMore: false,
      items: [entry("older", "2026-09-08T14:02:00.000Z"), entry("newer", "2026-09-08T14:32:00.000Z")],
    }
    render(<HistoryPanel sessionId="session-billing" connected onLoad={async () => page} />)

    await screen.findAllByTestId("history-row")
    expect(times()).toEqual(["14:32", "14:02"])
  })

  // The daemon's cursor is the page's oldest id and the next page holds what
  // came before it, so an older page belongs under the rows already drawn, and
  // Load older stays under the oldest row.
  it("draws an older page below the rows it already has", async () => {
    const latest: SessionHistoryPage = {
      sessionId: "session-billing",
      hasMore: true,
      nextCursor: "thread:b",
      items: [entry("b", "2026-09-08T14:10:00.000Z"), entry("c", "2026-09-08T14:20:00.000Z")],
    }
    const older: SessionHistoryPage = {
      sessionId: "session-billing",
      hasMore: true,
      nextCursor: "thread:a",
      items: [entry("a", "2026-09-08T14:00:00.000Z")],
    }
    const onLoad = vi.fn(async (_sessionId: string, options?: { before?: string }) => options?.before ? older : latest)
    render(<HistoryPanel sessionId="session-billing" connected onLoad={onLoad} />)
    await screen.findAllByTestId("history-row")
    expect(times()).toEqual(["14:20", "14:10"])

    await userEvent.setup().click(screen.getByRole("button", { name: "Load older" }))
    await screen.findByText("a")
    expect(onLoad).toHaveBeenLastCalledWith("session-billing", expect.objectContaining({ before: "thread:b" }), expect.anything())
    expect(times()).toEqual(["14:20", "14:10", "14:00"])
    expect(follows(screen.getByRole("button", { name: "Load older" }), screen.getAllByTestId("history-row").at(-1)!)).toBe(true)
  })

  // Past the retained budget the newest rows are the ones let go, and they
  // were drawn at the top, so the way back to them is offered there.
  it("offers Back to latest above the rows once the newest are let go", async () => {
    const stamp = (minute: number) => `2026-09-08T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`
    const latest: SessionHistoryPage = {
      sessionId: "session-billing",
      hasMore: true,
      nextCursor: "thread:n100",
      items: Array.from({ length: 150 }, (_, index) => entry(`n${100 + index}`, stamp(100 + index))),
    }
    const older: SessionHistoryPage = {
      sessionId: "session-billing",
      hasMore: true,
      nextCursor: "thread:n0",
      items: Array.from({ length: 100 }, (_, index) => entry(`n${index}`, stamp(index))),
    }
    render(<HistoryPanel sessionId="session-billing" connected onLoad={async (_sessionId, options) => options?.before ? older : latest} />)
    await screen.findAllByTestId("history-row")

    await userEvent.setup().click(screen.getByRole("button", { name: "Load older" }))
    const back = await screen.findByRole("button", { name: "Back to latest" })
    const rows = screen.getAllByTestId("history-row")
    expect(rows).toHaveLength(200)
    expect(follows(rows[0]!, back)).toBe(true)
    expect(follows(screen.getByRole("button", { name: "Load older" }), rows.at(-1)!)).toBe(true)
  })
})

describe("the sheet close control", () => {
  it("is named Close, because the design draws an X that closes the sheet", () => {
    const header = renderDock().parentElement
    expect(header).not.toBeNull()
    expect(within(header!).getByRole("button", { name: "Close" })).toBeDefined()
  })
})
