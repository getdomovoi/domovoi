import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  installFakeWebSocket,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

// v2's sheet is Plan, Preview, Changes, Terminal, History, Checkpoints, Rules.
// There is no Session tab, and Comments is not a tab: the design draws the
// comments on a variant under the preview frame. Rules waits on its own slice.
describe("the dock's tab list", () => {
  it("is v2's list with no Session tab and no Comments tab", async () => {
    render(<WorkspaceShell />)
    await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
    await settle()
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Plan", "Preview", "Changes", "Terminal", "History", "Checkpoints",
    ])
  })

  // v2 labels the block "COMMENTS ON VARIANT B" and its logic filters by the
  // selected document. A comment on the plan belongs under the plan, and a
  // comment on another variant shows when that variant is selected.
  it("scopes the comments under the preview to the selected variant, and the plan's to the plan", async () => {
    const snapshot = workspaceSnapshot()
    const first = snapshot.artifacts.find((artifact) => artifact.id === "artifact-preview")!
    snapshot.artifacts = [
      ...snapshot.artifacts.filter((artifact) => artifact.id !== "artifact-preview"),
      { ...first, id: "variant-a", title: "Variant A", path: "design-studio/replay/a.html", mimeType: "text/html", variant: { id: "a", groupId: "design-studio/replay", label: "Variant A", order: 0 } },
      { ...first, id: "variant-b", title: "Variant B", path: "design-studio/replay/b.html", mimeType: "text/html", variant: { id: "b", groupId: "design-studio/replay", label: "Variant B", order: 1 } },
    ]
    const base = snapshot.annotations[0]!
    snapshot.annotations = [
      { ...base, id: "on-a", artifactId: "variant-a", body: "Tighten the header on A.", thread: [] },
      { ...base, id: "on-b", artifactId: "variant-b", body: "B loses the status column.", thread: [] },
      { ...base, id: "on-plan", artifactId: "artifact-plan", body: "Run the migration on staging first.", thread: [] },
    ]
    render(<WorkspaceShell />)
    await act(async () => { completeHandshake(harness.socket(0), snapshot) })
    await settle()
    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Preview" }))
    await settle()
    let comments = screen.getByRole("region", { name: "Comments on this preview" })
    expect(within(comments).getByText(/COMMENTS ON VARIANT B/)).toBeTruthy()
    expect(within(comments).getByText("1 open")).toBeTruthy()
    expect(within(comments).getByText("B loses the status column.")).toBeTruthy()
    expect(within(comments).queryByText("Tighten the header on A.")).toBeNull()
    expect(within(comments).queryByText("Run the migration on staging first.")).toBeNull()

    await user.click(screen.getByRole("button", { name: /Variant A/ }))
    await settle()
    comments = screen.getByRole("region", { name: "Comments on this preview" })
    expect(within(comments).getByText(/COMMENTS ON VARIANT A/)).toBeTruthy()
    expect(within(comments).getByText("Tighten the header on A.")).toBeTruthy()
    expect(within(comments).queryByText("B loses the status column.")).toBeNull()

    await user.click(screen.getByRole("tab", { name: "Plan" }))
    await settle()
    const planComments = screen.getByRole("region", { name: "Comments on the plan" })
    expect(within(planComments).getByText("Run the migration on staging first.")).toBeTruthy()
  })

  it("keeps the plan's comments reachable when the plan has no content to show", async () => {
    const snapshot = workspaceSnapshot()
    snapshot.workingPlans = []
    snapshot.artifacts = snapshot.artifacts.map((artifact) => artifact.id === "artifact-plan" ? { ...artifact, content: undefined } : artifact)
    render(<WorkspaceShell />)
    await act(async () => { completeHandshake(harness.socket(0), snapshot) })
    await settle()
    await userEvent.setup().click(screen.getByRole("tab", { name: "Plan" }))
    await settle()
    expect(screen.getByText("No plan content yet")).toBeTruthy()
    const planComments = screen.getByRole("region", { name: "Comments on the plan" })
    expect(within(planComments).getByText("Run this migration on the WSL staging machine first.")).toBeTruthy()
  })
})
