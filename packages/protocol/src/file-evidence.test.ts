import { describe, expect, it } from "vitest"

import { rpcMethods, sessionEvidenceSchema } from "./index.js"

const baseCommit = "a".repeat(40)
const run = {
  id: "run-1", command: "pnpm test", commandTruncated: false,
  status: "failed", outputTruncated: false, createdAt: "2026-09-08T12:00:00Z",
}
const file = {
  path: "src/app.ts", status: "modified", staged: false, unstaged: true,
  additions: 1, deletions: 1, binary: false,
}
const legacy = {
  sessionId: "session-1", refreshedAt: "2026-09-08T12:00:00Z",
  workspace: {
    baseCommit, diff: "", diffTruncated: false, filesTruncated: false,
    totalChangedFiles: 2, files: [file, { ...file, path: "src/other.ts" }],
  },
  tests: { passed: 0, failed: 1, totalRuns: 1, runsTruncated: false, runs: [run] },
}
const association = {
  path: file.path,
  tests: { state: "unknown", reason: "file-access-not-recorded" },
  revertTarget: { kind: "restore", baseCommit, checkpointId: "checkpoint-1" },
}
const evidence = {
  ...legacy,
  fileAssociations: [association, { ...association, path: "src/other.ts" }],
}

describe("per-file evidence contract", () => {
  it("opts into associations while preserving legacy evidence as unknown", () => {
    expect(rpcMethods["session.evidence"].params.parse({
      sessionId: "session-1", includeFileAssociations: true,
    })).toEqual({ sessionId: "session-1", includeFileAssociations: true })
    expect(sessionEvidenceSchema.parse(legacy)).toEqual(legacy)
    expect(sessionEvidenceSchema.parse(evidence)).toEqual(evidence)
  })

  it("distinguishes unknown links, a proven empty set and many-to-many links", () => {
    for (const tests of [
      association.tests,
      { state: "known", runIds: [] },
      { state: "known", runIds: [run.id] },
    ]) {
      const value = {
        ...evidence, fileAssociations: evidence.fileAssociations.map((entry) => ({ ...entry, tests })),
      }
      expect(sessionEvidenceSchema.parse(value)).toEqual(value)
    }
    const twoRuns = {
      ...evidence,
      tests: { ...legacy.tests, failed: 2, totalRuns: 2, runs: [run, { ...run, id: "run-2" }] },
      fileAssociations: evidence.fileAssociations.map((entry) => ({
        ...entry, tests: { state: "known", runIds: [run.id, "run-2"] },
      })),
    }
    expect(sessionEvidenceSchema.parse(twoRuns)).toEqual(twoRuns)
  })

  it("names a commit without inventing a checkpoint and represents removal or an unavailable target", () => {
    for (const revertTarget of [
      { kind: "restore", baseCommit },
      { kind: "remove", baseCommit },
      { kind: "remove", baseCommit, checkpointId: "checkpoint-1" },
      { kind: "unavailable", reason: "target-not-observed" },
      { kind: "unavailable", reason: "unsupported-path" },
    ]) {
      const value = {
        ...evidence,
        fileAssociations: evidence.fileAssociations.map((entry) => ({ ...entry, revertTarget })),
      }
      expect(sessionEvidenceSchema.parse(value)).toEqual(value)
    }
  })

  it.each([
    { fileAssociations: [] },
    { fileAssociations: [association] },
    { fileAssociations: [association, association] },
    { fileAssociations: [association, { ...association, path: "not-changed.ts" }] },
    ...[
      { tests: { state: "unknown", reason: "file-access-not-recorded", runIds: [] } },
      { tests: { state: "known", runIds: ["missing-run"] } },
      { tests: { state: "known", runIds: [run.id, run.id] } },
      { tests: { state: "known", runIds: Array.from({ length: 51 }, (_, i) => `run-${i}`) } },
      { revertTarget: { kind: "restore", baseCommit: "b".repeat(40) } },
      { revertTarget: { kind: "restore", baseCommit: "abcdef0" } },
      { revertTarget: { kind: "restore", baseCommit, checkpointId: "" } },
      { revertTarget: { kind: "unavailable", reason: "target-not-observed", baseCommit } },
    ].map((patch) => ({ fileAssociations: [
      { ...association, ...patch }, evidence.fileAssociations[1],
    ] })),
  ])("rejects missing, dangling, duplicate or contradictory associations %#", (patch) => {
    expect(sessionEvidenceSchema.safeParse({ ...evidence, ...patch }).success).toBe(false)
  })

  it("does not turn a truncated run list into complete file coverage", () => {
    const truncated = {
      ...evidence, tests: { ...legacy.tests, failed: 2, totalRuns: 2, runsTruncated: true },
    }
    expect(sessionEvidenceSchema.parse(truncated)).toEqual(truncated)
    for (const runIds of [[], [run.id]]) {
      expect(sessionEvidenceSchema.safeParse({
        ...truncated,
        fileAssociations: truncated.fileAssociations.map((entry) => ({
          ...entry, tests: { state: "known", runIds },
        })),
      }).success).toBe(false)
    }
  })

  it("never advertises an available revert for a path the revert RPC refuses", () => {
    const path = "a".repeat(1025)
    const value = {
      ...evidence,
      workspace: { ...legacy.workspace, totalChangedFiles: 1, files: [{ ...file, path }] },
      fileAssociations: [{ ...association, path }],
    }
    expect(sessionEvidenceSchema.safeParse(value).success).toBe(false)
    expect(sessionEvidenceSchema.safeParse({
      ...value,
      fileAssociations: [{ ...association, path, revertTarget: { kind: "unavailable", reason: "unsupported-path" } }],
    }).success).toBe(true)
  })

  it("binds a revert confirmation to a full commit SHA without breaking legacy requests", () => {
    const params = { sessionId: "session-1", path: file.path, client: "desktop" }
    const schema = rpcMethods["session.revertFile"].params
    expect(schema.parse(params)).toEqual(params)
    expect(schema.parse({ ...params, expectedBaseCommit: baseCommit }))
      .toEqual({ ...params, expectedBaseCommit: baseCommit })
    expect(schema.safeParse({ ...params, expectedBaseCommit: "abcdef0" }).success).toBe(false)
  })
})
