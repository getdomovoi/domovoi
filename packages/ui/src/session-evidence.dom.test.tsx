import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SessionEvidence } from "@getdomovoi/protocol"

import { SessionEvidenceContent } from "./session-evidence"

afterEach(cleanup)

const evidence: SessionEvidence = {
  sessionId: "session-1",
  refreshedAt: "2026-09-01T12:00:00.000Z",
  workspace: {
    baseCommit: "a".repeat(40),
    diff: [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " const stable = 1",
      "-const before = 2",
      "+const after = 3",
      " export { stable }",
      "",
    ].join("\n"),
    diffTruncated: false,
    totalChangedFiles: 2,
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        staged: false,
        unstaged: true,
        additions: 1,
        deletions: 1,
        binary: false,
      },
      {
        path: "src/generated.ts",
        status: "untracked",
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null,
        binary: false,
      },
    ],
    filesTruncated: false,
  },
  tests: {
    passed: 0,
    failed: 0,
    totalRuns: 0,
    runs: [],
    runsTruncated: false,
  },
}

describe("SessionEvidenceContent revert and diff view", () => {
  it("takes a confirmation that names the recovery checkpoint before reverting one file", async () => {
    const user = userEvent.setup()
    const onRevertFile = vi.fn(async () => {})
    render(
      <SessionEvidenceContent
        connected
        evidence={evidence}
        error=""
        loading={false}
        onRefresh={vi.fn()}
        onRevertFile={onRevertFile}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Revert src/app.ts" }))
    expect(screen.getByText(/recovery checkpoint/i)).not.toBeNull()
    expect(screen.getByText(/before it changes the worktree/i)).not.toBeNull()

    await user.click(screen.getByRole("button", { name: "Keep the changes" }))
    expect(onRevertFile).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Revert src/generated.ts" }))
    await user.click(screen.getByRole("button", { name: "Revert file" }))
    expect(onRevertFile).toHaveBeenCalledWith("src/generated.ts")
  })

  it("offers no revert control when the client cannot revert", () => {
    render(
      <SessionEvidenceContent
        connected
        evidence={evidence}
        error=""
        loading={false}
        onRefresh={vi.fn()}
      />,
    )

    expect(screen.queryByRole("button", { name: "Revert src/app.ts" })).toBeNull()
  })

  it("switches the worktree diff between unified and split", async () => {
    const user = userEvent.setup()
    render(
      <SessionEvidenceContent
        connected
        evidence={evidence}
        error=""
        loading={false}
        onRefresh={vi.fn()}
      />,
    )

    expect(screen.getByLabelText("Unified diff")).not.toBeNull()
    expect(screen.queryByLabelText("Split diff")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Split" }))

    const split = screen.getByLabelText("Split diff")
    expect(screen.queryByLabelText("Unified diff")).toBeNull()
    expect(split.textContent).toContain("const before = 2")
    expect(split.textContent).toContain("const after = 3")

    await user.click(screen.getByRole("button", { name: "Unified" }))
    expect(screen.getByLabelText("Unified diff")).not.toBeNull()
  })
})
