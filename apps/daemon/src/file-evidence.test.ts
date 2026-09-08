import { describe, expect, it } from "vitest"
import type { ThreadItem } from "@getdomovoi/protocol"

import { fileEvidenceAssociations } from "./file-evidence.js"
import type { WorkspaceEvidence } from "./workspace.js"

const baseCommit = "a".repeat(40)
const file = {
  path: "src/app.ts", status: "modified" as const, staged: false, unstaged: true,
  additions: 1, deletions: 1, binary: false,
}
const workspace: WorkspaceEvidence = {
  baseCommit, diff: "", diffTruncated: false, filesTruncated: false,
  totalChangedFiles: 1, files: [file], revertTargets: [{ path: file.path, kind: "restore" }],
}
const checkpoint: ThreadItem = {
  id: "checkpoint-matching", sessionId: "session-1", kind: "checkpoint",
  label: "baseline", commit: baseCommit, createdAt: "2026-09-08T12:00:00Z",
}
const command: ThreadItem = {
  id: "run-1", sessionId: "session-1", kind: "tool", tool: "command", status: "failed",
  title: "pnpm test src/app.ts", output: "FAIL src/app.ts", createdAt: "2026-09-08T12:01:00Z",
}

describe("daemon file associations", () => {
  it.each([
    { label: "no runs", items: [] },
    { label: "matching command and output", items: [command] },
    { label: "mixed run statuses", items: [command, { ...command, id: "run-2", status: "completed" as const }] },
  ])(
    "keeps coverage unknown with $label", ({ items }) => {
      expect(fileEvidenceAssociations(workspace, "session-1", items)).toEqual([{
        path: file.path, tests: { state: "unknown", reason: "file-access-not-recorded" },
        revertTarget: { kind: "restore", baseCommit },
      }])
    },
  )

  it("uses only an exact same-session checkpoint, never a recovery or foreign checkpoint", () => {
    const items: ThreadItem[] = [
      checkpoint,
      { ...checkpoint, id: "checkpoint-recovery", commit: "b".repeat(40) },
      { ...checkpoint, id: "checkpoint-foreign", sessionId: "session-2" },
    ]
    expect(fileEvidenceAssociations(workspace, "session-1", items)[0]?.revertTarget)
      .toEqual({ kind: "restore", baseCommit, checkpointId: checkpoint.id })
    expect(fileEvidenceAssociations(workspace, "session-1", items.slice(1))[0]?.revertTarget)
      .toEqual({ kind: "restore", baseCommit })
  })

  it("reports path removal and an unavailable observation without inferring from Git status", () => {
    expect(fileEvidenceAssociations({
      ...workspace, revertTargets: [{ path: file.path, kind: "remove" }],
    }, "session-1", [checkpoint])[0]?.revertTarget)
      .toEqual({ kind: "remove", baseCommit, checkpointId: checkpoint.id })
    const { revertTargets: _targets, ...unobserved } = workspace
    expect(fileEvidenceAssociations(unobserved, "session-1", [checkpoint])[0]?.revertTarget)
      .toEqual({ kind: "unavailable", reason: "target-not-observed" })
  })

  it("does not advertise a revert that path validation will refuse", () => {
    const path = "a".repeat(1025)
    expect(fileEvidenceAssociations({
      ...workspace, files: [{ ...file, path }], revertTargets: [{ path, kind: "restore" }],
    }, "session-1", [checkpoint])[0]?.revertTarget)
      .toEqual({ kind: "unavailable", reason: "unsupported-path" })
  })
})
