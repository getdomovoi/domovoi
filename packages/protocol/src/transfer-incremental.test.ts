import { describe, expect, it } from "vitest"

import { transferBeginParamsSchema, transferBeginResultSchema } from "./index.js"

const begin = {
  sessionId: "session-1",
  sourceMachineId: `machine-${"a".repeat(32)}`,
  method: "git-bundle" as const,
  digest: "d".repeat(64),
  totalBytes: 4_096,
  client: "desktop" as const,
}

describe("incremental transfer", () => {
  it("lets a source say which commit its bundle starts from", () => {
    expect(transferBeginParamsSchema.safeParse({
      ...begin,
      sinceCommit: "b".repeat(40),
    }).success).toBe(true)
  })

  it("refuses a base that is not a commit", () => {
    expect(transferBeginParamsSchema.safeParse({ ...begin, sinceCommit: "HEAD~1" }).success)
      .toBe(false)
  })

  it("lets a target say which commit it already holds", () => {
    expect(transferBeginResultSchema.safeParse({
      transferId: `transfer-${"c".repeat(32)}`,
      haveCommit: "b".repeat(40),
    }).success).toBe(true)
  })

  it("lets a target say it holds nothing yet", () => {
    expect(transferBeginResultSchema.safeParse({
      transferId: `transfer-${"c".repeat(32)}`,
    }).success).toBe(true)
  })
})
