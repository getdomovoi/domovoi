import { describe, expect, it } from "vitest"

import {
  transferBeginParamsSchema,
  transferBeginResultSchema,
  transferChunkParamsSchema,
  transferChunkResultSchema,
  maximumTransferBytes,
} from "./transfer-rpc.js"

const begin = {
  sessionId: "session-1",
  sourceMachineId: `machine-${"a".repeat(32)}`,
  method: "git-bundle" as const,
  digest: "d".repeat(64),
  totalBytes: 4_096,
  client: "desktop" as const,
}

describe("transfer rpc", () => {
  it("describes a transfer the target is asked to accept", () => {
    expect(transferBeginParamsSchema.safeParse(begin).success).toBe(true)
  })

  it("refuses a transfer larger than this build will take", () => {
    expect(transferBeginParamsSchema.safeParse({
      ...begin,
      totalBytes: maximumTransferBytes + 1,
    }).success).toBe(false)
  })

  it("refuses a digest that is not a sha256", () => {
    expect(transferBeginParamsSchema.safeParse({ ...begin, digest: "short" }).success).toBe(false)
  })

  it("names the transfer a target accepted", () => {
    expect(transferBeginResultSchema.safeParse({
      transferId: `transfer-${"b".repeat(32)}`,
    }).success).toBe(true)
  })

  it("carries a chunk against the transfer it belongs to", () => {
    expect(transferChunkParamsSchema.safeParse({
      transferId: `transfer-${"b".repeat(32)}`,
      sequence: 0,
      bytes: "AAAA",
      final: false,
      client: "desktop",
    }).success).toBe(true)
  })

  it("reports what the target did with a chunk", () => {
    expect(transferChunkResultSchema.safeParse({ state: "receiving" }).success).toBe(true)
    expect(transferChunkResultSchema.safeParse({
      state: "restored",
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "c".repeat(40),
    }).success).toBe(true)
    expect(transferChunkResultSchema.safeParse({
      state: "refused",
      reason: "digest-mismatch",
    }).success).toBe(true)
  })

  it("refuses a result that invents an outcome", () => {
    expect(transferChunkResultSchema.safeParse({ state: "done" }).success).toBe(false)
  })
})
