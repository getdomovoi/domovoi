import { describe, expect, it } from "vitest"

import {
  maximumTransferChunkBytes,
  transferChunkSchema,
} from "./transfer-stream.js"

describe("transfer chunk bytes", () => {
  it("accepts canonical bounded Base64", () => {
    expect(transferChunkSchema.safeParse({
      sequence: 0,
      bytes: "QUJD",
      final: true,
    }).success).toBe(true)
  })

  it("refuses bytes outside the Base64 alphabet", () => {
    expect(transferChunkSchema.safeParse({
      sequence: 0,
      bytes: "!!!!",
      final: true,
    }).success).toBe(false)
  })

  it("refuses an odd-length encoding", () => {
    expect(transferChunkSchema.safeParse({
      sequence: 0,
      bytes: "abc",
      final: true,
    }).success).toBe(false)
  })

  it("refuses an empty chunk", () => {
    expect(transferChunkSchema.safeParse({ sequence: 0, bytes: "", final: true }).success)
      .toBe(false)
  })

  it("refuses a canonical chunk above the byte ceiling", () => {
    const largestLegalEncodedLength = Math.ceil(maximumTransferChunkBytes / 3) * 4
    expect(transferChunkSchema.safeParse({
      sequence: 0,
      bytes: "A".repeat(largestLegalEncodedLength + 4),
      final: true,
    }).success).toBe(false)
  })
})
