import { describe, expect, it } from "vitest"

import {
  phoneAndTabletRpcMethods,
  rpcMethodAuthorizations,
  rpcMethodMutations,
  rpcMethods,
  sessionHistoryEntrySchema,
  workspaceEvidenceSchema,
} from "./rpc.js"
import { workspaceSnapshotSchema } from "./schema.js"
import { threadItemSchema } from "./schema.js"
import { maximumCommittedPaths } from "./session-history-metadata.js"

// Walk finding F10 (ruled 2026-10-18): the agent's sandbox stays closed to
// .git, so Domovoi commits a session's work on the person's word, on the
// session branch only, and the thread records what it committed.
describe("session.commit", () => {
  const params = { sessionId: "session-1", message: "fix(api): retry the webhook", expectedHead: "a".repeat(40), expectedChangesDigest: `sha256:${"b".repeat(64)}`, client: "desktop" }

  it("is a control method that changes state, like a checkpoint or a file revert", () => {
    expect(rpcMethods["session.commit"].params.parse(params)).toEqual(params)
    expect(rpcMethodAuthorizations["session.commit"]).toBe("control")
    expect(rpcMethodMutations["session.commit"]).toBe("mutating")
    expect(rpcMethods["session.commit"].result).toBe(workspaceSnapshotSchema)
  })

  it("stays off a phone or tablet credential, as checkpoint.create and session.revertFile do", () => {
    expect(phoneAndTabletRpcMethods.has("session.commit")).toBe(false)
  })

  it("requires the digest even when the field is omitted entirely", () => {
    const { expectedChangesDigest: _digest, ...missing } = params
    expect(rpcMethods["session.commit"].params.safeParse(missing).success).toBe(false)
  })

  it("validates the digest on evidence while preserving older read-only evidence", () => {
    const workspace = { baseCommit: params.expectedHead, diff: "", diffTruncated: false, totalChangedFiles: 0, files: [], filesTruncated: false }
    expect(workspaceEvidenceSchema.parse(workspace)).toEqual(workspace)
    expect(workspaceEvidenceSchema.parse({ ...workspace, changesDigest: params.expectedChangesDigest }).changesDigest).toBe(params.expectedChangesDigest)
    for (const changesDigest of ["", "sha256:abc", `sha256:${"A".repeat(64)}`, "b".repeat(64), null]) {
      expect(workspaceEvidenceSchema.safeParse({ ...workspace, changesDigest }).success).toBe(false)
    }
  })

  it("trims the message the person typed and keeps its body lines", () => {
    expect(rpcMethods["session.commit"].params.parse({ ...params, message: "  feat: add login\n\nWhy it changed.  " }).message)
      .toBe("feat: add login\n\nWhy it changed.")
  })

  it.each([
    ["an empty message", { message: "" }],
    ["a blank message", { message: " \n\t " }],
    ["a message past 4096 UTF-16 units", { message: "m".repeat(4_097) }],
    ["a NUL in the message, which Git cannot take as an argument", { message: "feat: a\u0000b" }],
    ["no digest", { expectedChangesDigest: undefined }],
    ["a malformed digest", { expectedChangesDigest: "sha256:abc" }],
    ["no expected head", { expectedHead: undefined }],
    ["an expected head that is not a full commit id", { expectedHead: "abc123" }],
    ["no session", { sessionId: "" }],
    ["an unknown client", { client: "toaster" }],
    ["a field the method does not take", { push: true }],
    ["a branch the person names", { branch: "main" }],
  ])("refuses %s", (_name, change) => {
    expect(rpcMethods["session.commit"].params.safeParse({ ...params, ...change }).success).toBe(false)
  })
})

describe("commit checkpoints", () => {
  const committed = {
    message: "fix(api): retry the webhook",
    branch: "domovoi/session-1",
    paths: ["src/webhook.ts", "src/webhook.test.ts"],
    pathCount: 2,
    client: "desktop",
  }
  const checkpoint = {
    id: "checkpoint-commit", sessionId: "session-1", kind: "checkpoint", reason: "commit",
    label: "bbbbbbbb · fix(api): retry the webhook", commit: "b".repeat(40), committed, createdAt: "2026-10-18T12:00:00.000Z",
  }
  const history = {
    id: "thread:checkpoint-commit", sourceId: checkpoint.id, sessionId: checkpoint.sessionId, category: "checkpoints",
    reason: "commit", label: checkpoint.label, commit: checkpoint.commit, committed, createdAt: checkpoint.createdAt,
  }

  it("records the message, the branch, the files and the client on the thread item and its history entry", () => {
    expect(threadItemSchema.parse(checkpoint)).toEqual(checkpoint)
    expect(sessionHistoryEntrySchema.parse(history)).toEqual(history)
  })

  it("counts every committed file when it lists only the first ones", () => {
    const paths = Array.from({ length: maximumCommittedPaths }, (_, index) => `src/file-${index}.ts`)
    const many = { ...committed, paths, pathCount: 120 }
    expect(threadItemSchema.parse({ ...checkpoint, committed: many })).toMatchObject({ committed: many })
    expect(threadItemSchema.safeParse({ ...checkpoint, committed: { ...many, paths: [...paths, "one-more.ts"] } }).success).toBe(false)
  })

  it.each([
    ["a commit with no record of what it committed", { committed: undefined }],
    ["a commit with no sha", { commit: undefined }],
    ["a commit taken mid-turn", { midTurn: { providerTurnId: "turn-1", stability: "matched", changedPaths: [], changedPathCount: 0 } }],
    ["a record on a checkpoint Domovoi took for itself", { reason: "manual" }],
    ["a record on a legacy checkpoint", { reason: undefined }],
    ["a count below the listed files", { committed: { ...committed, pathCount: 1 } }],
    ["a commit of no files", { committed: { ...committed, paths: [], pathCount: 0 } }],
    ["an empty message", { committed: { ...committed, message: "" } }],
    ["an empty branch", { committed: { ...committed, branch: "" } }],
    ["a branch that is not a session branch", { committed: { ...committed, branch: "main" } }],
    ["a branch that carries other text", { committed: { ...committed, branch: "domovoi/NPM_TOKEN=abc" } }],
    // The branch is derived from the session's id, which the record already
    // holds, so it can carry nothing else, a token-shaped suffix included.
    ["another session's branch", { committed: { ...committed, branch: "domovoi/ghp_0123456789abcdefghijABCDEFGHIJklmnopqr" } }],
    ["an unknown client", { committed: { ...committed, client: "toaster" } }],
    ["a field the record does not hold", { committed: { ...committed, pushed: true } }],
  ])("refuses %s", (_name, change) => {
    expect(threadItemSchema.safeParse({ ...checkpoint, ...change }).success).toBe(false)
    expect(sessionHistoryEntrySchema.safeParse({ ...history, ...change }).success).toBe(false)
  })
})
