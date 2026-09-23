import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace } from "@getdomovoi/protocol"
import { TooltipProvider } from "./components/ui/tooltip"
import { ArtifactDock } from "./artifact-dock"
import { dockTabDefinitions } from "./dock-tabs"

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

describe("the sheet close control", () => {
  it("is named Close, because the design draws an X that closes the sheet", () => {
    const header = renderDock().parentElement
    expect(header).not.toBeNull()
    expect(within(header!).getByRole("button", { name: "Close" })).toBeDefined()
  })
})
