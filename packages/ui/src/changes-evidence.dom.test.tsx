import type { SessionEvidence } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { SessionEvidenceContent } from "./session-evidence"

afterEach(cleanup)

const commit = "8f3c1de4a2b7c9d0e1f2a3b4c5d6e7f8a9b0c1d2"

function evidenceWith(associations: SessionEvidence["fileAssociations"]): SessionEvidence {
  return {
    sessionId: "session-1",
    refreshedAt: "2026-09-08T10:00:00.000Z",
    workspace: {
      baseCommit: commit,
      diff: "",
      diffTruncated: false,
      totalChangedFiles: 2,
      filesTruncated: false,
      files: [
        { path: "src/handler.ts", status: "modified", staged: false, unstaged: true, additions: 62, deletions: 14, binary: false },
        { path: "src/replay.ts", status: "added", staged: false, unstaged: true, additions: 71, deletions: 0, binary: false },
      ],
    },
    tests: { passed: 0, failed: 0, totalRuns: 0, runs: [], runsTruncated: false },
    ...(associations ? { fileAssociations: associations } : {}),
  }
}

function pane(evidence: SessionEvidence, onRevertFile = vi.fn(async () => {})) {
  render(
    <SessionEvidenceContent
      evidence={evidence}
      connected
      error=""
      loading={false}
      onRevertFile={onRevertFile}
      onRefresh={vi.fn(async () => {})}
    />,
  )
  return onRevertFile
}

it("says it cannot tell which runs touched a file, rather than that none did", () => {
  pane(evidenceWith([
    { path: "src/handler.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "restore", baseCommit: commit } },
    { path: "src/replay.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "remove", baseCommit: commit } },
  ]))
  expect(screen.getAllByText("Domovoi cannot tell which runs touched this file")).toHaveLength(2)
  expect(screen.queryByText(/no test touched/i)).toBeNull()
})

it("offers Remove for a file that is not in the base commit", () => {
  pane(evidenceWith([
    { path: "src/handler.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "restore", baseCommit: commit } },
    { path: "src/replay.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "remove", baseCommit: commit } },
  ]))
  expect(screen.getByRole("button", { name: "Restore src/handler.ts" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Remove src/replay.ts" })).toBeTruthy()
})

it("names the commit in the confirmation when no checkpoint matches", async () => {
  const user = userEvent.setup()
  pane(evidenceWith([
    { path: "src/handler.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "restore", baseCommit: commit } },
    { path: "src/replay.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "remove", baseCommit: commit } },
  ]))
  await user.click(screen.getByRole("button", { name: "Restore src/handler.ts" }))
  expect(screen.getByText(/commit 8f3c1de/)).toBeTruthy()
  // The dialog always mentions the recovery checkpoint it takes before writing.
  // What must not appear is a named checkpoint as the restore source.
  expect(screen.queryByText(/checkpoint ckpt_/i)).toBeNull()
})

it("binds the confirmation to the commit it described", async () => {
  const user = userEvent.setup()
  const onRevertFile = pane(evidenceWith([
    { path: "src/handler.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "restore", baseCommit: commit, checkpointId: "ckpt_6b0e" } },
    { path: "src/replay.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "remove", baseCommit: commit } },
  ]))
  await user.click(screen.getByRole("button", { name: "Restore src/handler.ts" }))
  expect(screen.getByText(/checkpoint ckpt_6b0e/)).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Restore file" }))
  expect(onRevertFile).toHaveBeenCalledWith("src/handler.ts", commit)
})

it("offers no revert when the daemon says the target is unavailable", () => {
  pane(evidenceWith([
    { path: "src/handler.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "unavailable", reason: "target-not-observed" } },
    { path: "src/replay.ts", tests: { state: "unknown", reason: "file-access-not-recorded" }, revertTarget: { kind: "unavailable", reason: "unsupported-path" } },
  ]))
  expect(screen.queryByRole("button", { name: /Restore src|Remove src|Revert src/ })).toBeNull()
  expect(screen.getByText("Domovoi did not observe a version of this file to go back to.")).toBeTruthy()
  expect(screen.getByText("This path cannot be reverted one file at a time.")).toBeTruthy()
})
