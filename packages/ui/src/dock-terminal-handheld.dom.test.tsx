import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace, type ClientKind } from "@getdomovoi/protocol"

import { TooltipProvider } from "./components/ui/tooltip"
import { ArtifactDock } from "./artifact-dock"
import { HandheldTabMachine } from "./handheld-tab"

// The pane's chunk never arrives here, so the dock shows its loading state
// for as long as the test looks.
vi.mock("./terminal-pane", () => new Promise(() => {}))

// The shell provides the machine of a phone or tablet tab, and nothing in a
// desktop or web tab.
function renderDock(clientKind: ClientKind) {
  render(
    <TooltipProvider>
      <HandheldTabMachine.Provider value={clientKind === "phone" || clientKind === "tablet" ? demoWorkspace.machine.name : undefined}>
      <ArtifactDock
        snapshot={demoWorkspace}
        onCollapse={() => {}}
        defaultTab="changes"
        rpcUrl="ws://127.0.0.1:47831/rpc"
        authorizeArtifact={async () => { throw new Error("not used") }}
        connected
        terminalControls={{} as never}
        onReplyToAnnotation={async () => {}}
        onSetAnnotationStatus={async () => {}}
        onCreateAnnotation={async () => {}}
        onLoadSessionHistory={async () => ({ sessionId: demoWorkspace.sessions[0]?.id ?? "", items: [], hasMore: false })}
        onLoadSessionEvidence={async () => { throw new Error("not used") }}
        onRevertSessionFile={async () => {}}
      />
      </HandheldTabMachine.Provider>
    </TooltipProvider>,
  )
}

const reason = `Opening, typing into, resizing and taking a shell are off in a phone or tablet tab: the daemon lets a phone or tablet credential only read one. Use the desktop app on ${demoWorkspace.machine.name}.`

describe("the dock's Terminal tab while its renderer loads", () => {
  it.each(["phone", "tablet"] as const)("gives the reason in a %s tab and promises no interactive terminal", async (clientKind) => {
    renderDock(clientKind)
    await userEvent.setup().click(screen.getByRole("tab", { name: "Terminal" }))

    expect(await screen.findByText("Loading terminal")).toBeTruthy()
    expect(screen.getByText("Preparing the terminal renderer.")).toBeTruthy()
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.queryByText(/interactive/u)).toBeNull()
  })

  it.each(["desktop", "web"] as const)("keeps the interactive loading line in a %s tab", async (clientKind) => {
    renderDock(clientKind)
    await userEvent.setup().click(screen.getByRole("tab", { name: "Terminal" }))

    expect(await screen.findByText("Preparing the interactive terminal renderer.")).toBeTruthy()
    expect(screen.queryByText(/off in a phone or tablet tab/u)).toBeNull()
  })
})
