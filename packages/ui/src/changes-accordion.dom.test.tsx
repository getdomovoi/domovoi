import type { SessionEvidence } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { SessionEvidenceContent } from "./session-evidence.js"

afterEach(cleanup)

const diff = [
  "diff --git a/src/one.ts b/src/one.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1",
  "+const b = 2",
  "diff --git a/src/two.ts b/src/two.ts",
  "@@ -5,1 +5,1 @@",
  "-const c = 3",
].join("\n")

function evidence(overrides: Partial<SessionEvidence["workspace"]> = {}): SessionEvidence {
  return {
    sessionId: "session-1",
    refreshedAt: "2026-09-03T10:00:00.000Z",
    workspace: {
      baseCommit: "a".repeat(40),
      totalChangedFiles: 2,
      filesTruncated: false,
      diffTruncated: false,
      diff,
      files: [
        { path: "src/one.ts", status: "modified", staged: false, unstaged: true, additions: 1, deletions: 0, binary: false },
        { path: "src/two.ts", status: "modified", staged: false, unstaged: true, additions: 0, deletions: 1, binary: false },
      ],
      ...overrides,
    },
    tests: { passed: 0, failed: 0, totalRuns: 0, runs: [] },
  } as unknown as SessionEvidence
}

function props() {
  return { connected: true, evidence: evidence(), error: "", loading: false, onRefresh: vi.fn() }
}

it("keeps each file collapsed until it is opened", async () => {
  render(<SessionEvidenceContent {...props()} />)

  expect(screen.queryByLabelText("Diff for src/one.ts")).toBeNull()
  await userEvent.click(screen.getByRole("button", { name: "Show diff for src/one.ts" }))
  expect(screen.getByLabelText("Diff for src/one.ts").textContent).toContain("+const b = 2")
  expect(screen.queryByLabelText("Diff for src/two.ts")).toBeNull()
})

it("opens and closes every file at once", async () => {
  render(<SessionEvidenceContent {...props()} />)

  await userEvent.click(screen.getByRole("button", { name: "Expand all" }))
  expect(screen.getByLabelText("Diff for src/one.ts")).toBeTruthy()
  expect(screen.getByLabelText("Diff for src/two.ts")).toBeTruthy()

  await userEvent.click(screen.getByRole("button", { name: "Collapse all" }))
  expect(screen.queryByLabelText("Diff for src/one.ts")).toBeNull()
})

it("says when a file has no diff to show rather than opening empty", async () => {
  render(<SessionEvidenceContent {...props()} evidence={evidence({ diffTruncated: true })} />)

  await userEvent.click(screen.getByRole("button", { name: "Show diff for src/two.ts" }))
  expect(screen.getByLabelText("Diff for src/two.ts").textContent).toContain("-const c = 3")

  cleanup()
  render(<SessionEvidenceContent {...props()} evidence={evidence({ diff: "", diffTruncated: true })} />)
  await userEvent.click(screen.getByRole("button", { name: "Show diff for src/one.ts" }))
  expect(screen.getAllByText(/diff output was truncated/iu).length).toBeGreaterThan(0)
})
