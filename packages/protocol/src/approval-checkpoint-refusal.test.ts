import { describe, expect, it } from "vitest"

import {
  approvalCheckpointErrorCode,
  approvalCheckpointRefusalCauses,
  approvalCheckpointRefusalSchema,
  maximumApprovalCheckpointLockPathLength,
} from "./approval-checkpoint-refusal.js"
import * as protocol from "./index.js"

const kind = "approval-checkpoint-refused"

describe("approval checkpoint refusal", () => {
  it("has its own error code beside the other typed refusals", () => {
    expect(approvalCheckpointErrorCode).toBe(-32023)
    const codes = Object.entries(protocol)
      .filter(([name, value]) => name.endsWith("ErrorCode") && typeof value === "number")
      .map(([, value]) => value)
    expect(codes.filter((code) => code === approvalCheckpointErrorCode)).toHaveLength(1)
  })

  it("names a held lock by the path Git reported", () => {
    for (const lockPath of [
      "/Users/dana/acme-api/.git/refs/domovoi/checkpoints/0123.lock",
      "C:/Users/dana/acme-api/.git/index.lock",
      "/repo/.git/worktrees/session a/index.lock",
    ]) {
      const refusal = { kind, cause: "lock-held", lockPath }
      expect(approvalCheckpointRefusalSchema.parse(refusal)).toEqual(refusal)
    }
  })

  it("requires the lock path on a held lock, and only there", () => {
    expect(approvalCheckpointRefusalSchema.safeParse({ kind, cause: "lock-held" }).success).toBe(false)
    for (const cause of approvalCheckpointRefusalCauses.filter((candidate) => candidate !== "lock-held")) {
      expect(approvalCheckpointRefusalSchema.parse({ kind, cause })).toEqual({ kind, cause })
      expect(approvalCheckpointRefusalSchema.safeParse({ kind, cause, lockPath: "/repo/.git/index.lock" }).success, cause).toBe(false)
    }
  })

  it("lists every cause the daemon can tell apart", () => {
    expect(approvalCheckpointRefusalCauses).toEqual([
      "lock-held", "submodule-changes", "repository-config", "git-unavailable", "timed-out", "git-failed", "unknown",
    ])
  })

  it.each([
    ["empty", ""],
    ["not a lock file", "/repo/.git/index"],
    ["relative", ".git/index.lock"],
    ["a line break", "/repo/.git/index.lock\nAnother git process"],
    ["a control character", "/repo/.git/\u0007index.lock"],
    ["too long", `/${"a".repeat(maximumApprovalCheckpointLockPathLength)}.lock`],
  ])("rejects a lock path that is %s", (_name, lockPath) => {
    expect(approvalCheckpointRefusalSchema.safeParse({ kind, cause: "lock-held", lockPath }).success).toBe(false)
  })

  it.each([
    { kind: "session-attachment-refused", cause: "unknown" },
    { kind, cause: "invented" },
    { kind, cause: "unknown", message: "the daemon's words travel in the error message" },
    { kind },
  ])("rejects %j", (refusal) => {
    expect(approvalCheckpointRefusalSchema.safeParse(refusal).success).toBe(false)
  })
})
