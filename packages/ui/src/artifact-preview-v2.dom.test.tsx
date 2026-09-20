import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { demoWorkspace, type Artifact, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ArtifactDock } from "./artifact-dock"

const sessionId = demoWorkspace.activeSessionId!
const previews: Artifact[] = [
  {
    id: "artifact-preview-a",
    sessionId,
    title: "Webhook replay A",
    type: "preview",
    revision: 1,
    mimeType: "text/html",
    path: ".domovoi/previews/a.html",
    variant: { groupId: "webhook-replay", id: "a", label: "Variant A", order: 1 },
  },
  {
    id: "artifact-preview-b",
    sessionId,
    title: "Webhook replay B",
    type: "preview",
    revision: 1,
    mimeType: "text/html",
    path: ".domovoi/previews/b.html",
    variant: { groupId: "webhook-replay", id: "b", label: "Variant B", order: 2 },
  },
]
const snapshot: WorkspaceSnapshot = { ...demoWorkspace, artifacts: previews, annotations: [] }

function renderDock() {
  render(
    <ArtifactDock
      snapshot={snapshot}
      onCollapse={vi.fn()}
      defaultTab="preview"
      rpcUrl="ws://127.0.0.1:47831/rpc"
      authorizeArtifact={() => new Promise(() => {})}
      connected
      terminalControls={{ claim: vi.fn(), release: vi.fn(), write: vi.fn(), resize: vi.fn() } as never}
      onReplyToAnnotation={vi.fn()}
      onSetAnnotationStatus={vi.fn()}
      onCreateAnnotation={vi.fn()}
      onLoadSessionHistory={vi.fn()}
      onLoadSessionEvidence={vi.fn()}
      onRevertSessionFile={vi.fn()}
    />,
  )
}

afterEach(cleanup)

it("keeps the viewed preview distinct from the build basis", async () => {
  const user = userEvent.setup()
  renderDock()

  expect(screen.getByText("Build basis · Variant B")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: /Variant A/ }))
  expect(screen.getByText("Viewing · Variant A")).toBeTruthy()
  expect(screen.getByText("Build basis · Variant B")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Use Variant A as build basis" }))
  expect(screen.getByText("Build basis · Variant A")).toBeTruthy()
})

it("keeps sandbox authorization and sheet controls visible", () => {
  renderDock()

  expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts")
  expect(screen.getByText("sandboxed", { exact: false })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
})

it("opens an authorized preview fullscreen and exits it", async () => {
  const user = userEvent.setup()
  renderDock()

  await user.click(screen.getByRole("button", { name: "Open fullscreen preview" }))
  expect(screen.getByRole("dialog")).toBeTruthy()
  expect(screen.getByText("Exit fullscreen")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Exit fullscreen" }))
  expect(screen.queryByRole("dialog")).toBeNull()
})
