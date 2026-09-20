import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { rulesIntro } from "./rules-panel"
import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  installFakeWebSocket,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const openSheet = async () => {
  // v2 starts with the sheet closed, so a test that reads the dock opens it
  // first. Already open is not an error: pinned runs render the same tabs.
  if (screen.queryAllByRole("tab", { name: "Changes" }).length > 0) return
  const open = screen.queryByRole("button", { name: "Open the sheet" })
  if (!open) return
  await userEvent.setup().click(open)
  await settle()
}

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

// v2's sheet is Plan preview, Preview, Changes, Terminal, History,
// Checkpoints, Rules, each drawn as an icon whose label is its accessible name.
// There is no Session tab, and Comments is not a tab: the design draws the
// comments on a variant under the preview frame. Rules waits on its own slice.
describe("the dock's tab list", () => {
  it("is v2's list with no Session tab and no Comments tab", async () => {
    render(<WorkspaceShell />)
    await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
    await settle()
    await openSheet()
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Plan preview", "Preview", "Changes", "Terminal", "History", "Checkpoints", "Rules",
    ])
  })

  it("opens Rules on the project's standing rules and asks the daemon for its hard gates", async () => {
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => { completeHandshake(socket, workspaceSnapshot()) })
    await settle()
    await openSheet()
    await userEvent.setup().click(screen.getByRole("tab", { name: "Rules" }))
    await settle()
    expect(screen.getByText(rulesIntro)).toBeTruthy()
    expect(sentRequests(socket, "permission.hardGates")).toHaveLength(1)
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
    await openSheet()
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

    await user.click(screen.getByRole("tab", { name: "Plan preview" }))
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
    await openSheet()
    await userEvent.setup().click(screen.getByRole("tab", { name: "Plan preview" }))
    await settle()
    expect(screen.getByText("No plan content yet")).toBeTruthy()
    const planComments = screen.getByRole("region", { name: "Comments on the plan" })
    expect(within(planComments).getByText("Run this migration on the WSL staging machine first.")).toBeTruthy()
  })
})

// The rule belongs to the project. Selecting an archived session must not
// dim Revoke for the whole project's standing rules.
it("keeps Revoke live in the Rules tab while an archived session is selected", async () => {
  const base = workspaceSnapshot()
  const snapshot = workspaceSnapshot({
    sessions: base.sessions.map((session) => session.id === base.activeSessionId
      ? { ...session, state: "archived" as const, archiveRequestedAt: "2026-09-10T00:00:00.000Z", archiveCheckpoint: "c".repeat(40), archivedAt: "2026-09-10T00:01:00.000Z" }
      : session),
    approvalRules: [{
      id: "rule-tests", useCount: 4, projectId: base.project!.id, operation: "shell", command: "pnpm test",
      createdBy: "desktop", createdAt: "2026-09-03T10:00:00.000Z", status: "active",
      execution: {
        state: "resolved", digest: `sha256:${"a".repeat(64)}`,
        record: { version: 1, cwd: ".", kind: "shell", coverage: "command-and-script-text", entries: [{ id: 0, source: { kind: "request" }, parts: [{ operator: null, argv: ["pnpm", "test"], expandsTo: [] }] }] },
      },
    }],
  })
  render(<WorkspaceShell />)
  await act(async () => { completeHandshake(harness.socket(0), snapshot) })
  await settle()
  await openSheet()
  await userEvent.setup().click(screen.getByRole("tab", { name: "Rules" }))
  await settle()
  const rows = screen.getAllByTestId("rule-row")
  expect(rows.length).toBeGreaterThan(0)
  expect((within(rows[0]!).getByRole("button", { name: "Revoke" }) as HTMLButtonElement).disabled).toBe(false)

})

// v2 has one usage surface, the chip in the composer. The dock draws no
// cost-and-context footer of its own.
it("carries no usage footer", async () => {
  render(<WorkspaceShell />)
  await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
  await settle()
  await openSheet()
  expect(screen.queryByRole("status", { name: "Session cost and context" })).toBeNull()
})
