import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { SessionEvidence } from "@getdomovoi/protocol"

import { SessionEvidenceContent } from "./session-evidence"

const evidence: SessionEvidence = {
  sessionId: "session-1",
  refreshedAt: "2026-08-29T12:00:00.000Z",
  workspace: {
    baseCommit: "a".repeat(40),
    diff: "diff --git a/src/app.ts b/src/app.ts\n+changed\n",
    diffTruncated: true,
    totalChangedFiles: 3,
    files: [
      {
        path: "public/logo.png",
        status: "untracked",
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null,
        binary: true,
      },
      {
        path: "src/app.ts",
        status: "modified",
        staged: true,
        unstaged: true,
        additions: 3,
        deletions: 1,
        binary: false,
      },
    ],
    filesTruncated: true,
  },
  tests: {
    passed: 1,
    failed: 1,
    totalRuns: 2,
    runs: [{
      id: "tool-test",
      command: "pnpm test",
      commandTruncated: true,
      status: "failed",
      output: "1 test failed",
      outputTruncated: true,
      createdAt: "2026-08-29T11:59:00.000Z",
    }],
    runsTruncated: true,
  },
}

describe("SessionEvidenceContent", () => {
  it("renders bounded file, diff, and observed command-run states", () => {
    const markup = renderToStaticMarkup(
      <SessionEvidenceContent
        connected
        evidence={evidence}
        error=""
        loading={false}
        onRefresh={vi.fn()}
      />,
    )

    expect(markup).toContain("3 changed files")
    expect(markup).toContain("public/logo.png")
    expect(markup).toContain("untracked")
    expect(markup).toContain("binary")
    expect(markup).toContain("staged + unstaged")
    expect(markup).toContain("+3")
    expect(markup).toContain("−1")
    expect(markup).toContain("Only the first 2 changed files are shown")
    expect(markup).toContain("Diff output was truncated")
    expect(markup).toContain("Observed test runs")
    expect(markup).toContain("1 passed")
    expect(markup).toContain("1 failed")
    expect(markup).toContain("Command truncated")
    expect(markup).toContain("Output truncated")
    expect(markup).toContain("Older observed runs are not shown")
  })

  it("renders loading, error, and empty evidence states", () => {
    const loading = renderToStaticMarkup(
      <SessionEvidenceContent
        connected
        error=""
        loading
        onRefresh={vi.fn()}
      />,
    )
    const failed = renderToStaticMarkup(
      <SessionEvidenceContent
        connected
        error="Git evidence could not be read"
        loading={false}
        onRefresh={vi.fn()}
      />,
    )
    const empty = renderToStaticMarkup(
      <SessionEvidenceContent
        connected
        evidence={{
          ...evidence,
          workspace: {
            ...evidence.workspace,
            diff: "",
            diffTruncated: false,
            totalChangedFiles: 0,
            files: [],
            filesTruncated: false,
          },
          tests: {
            passed: 0,
            failed: 0,
            totalRuns: 0,
            runs: [],
            runsTruncated: false,
          },
        }}
        error=""
        loading={false}
        onRefresh={vi.fn()}
      />,
    )

    expect(loading).toContain("Refreshing evidence")
    expect(failed).toContain("Evidence unavailable")
    expect(failed).toContain("Git evidence could not be read")
    expect(empty).toContain("No working changes")
    expect(empty).toContain("No observed test runs")
  })
})
