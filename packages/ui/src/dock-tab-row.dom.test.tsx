import { describe, expect, it } from "vitest"
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
// here on checkpoint rows only. The tab lists the daemon's page as it comes,
// oldest first, so the oldest row is at the top (Q40 A).
describe("the History tab tip", () => {
  it("offers a fork from a checkpoint and puts the oldest row where the tab does", () => {
    const tip = dockTabDefinitions.find((definition) => definition.id === "history")?.note ?? ""
    expect(tip).toBe("Everything that happened in this session, by category, oldest at the top. Fork from a checkpoint.")
  })

  // The tip's order clause is a claim about the panel, so the panel is held to
  // it: the daemon pages history oldest first and the tab draws it as given.
  it("matches the panel, which draws the oldest row first", async () => {
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
    const page: SessionHistoryPage = {
      sessionId: "session-billing",
      hasMore: false,
      items: [entry("older", "2026-09-08T14:02:00.000Z"), entry("newer", "2026-09-08T14:32:00.000Z")],
    }
    render(<HistoryPanel sessionId="session-billing" connected onLoad={async () => page} />)

    const rows = await screen.findAllByTestId("history-row")
    expect(rows.map((row) => within(row).getByTestId("history-time").textContent)).toEqual(["14:02", "14:32"])
  })
})

describe("the sheet close control", () => {
  it("is named Close, because the design draws an X that closes the sheet", () => {
    const header = renderDock().parentElement
    expect(header).not.toBeNull()
    expect(within(header!).getByRole("button", { name: "Close" })).toBeDefined()
  })
})
