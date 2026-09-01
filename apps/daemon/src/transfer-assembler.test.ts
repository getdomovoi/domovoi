import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { maximumTransferChunkBytes, transferChunkSchema } from "@getdomovoi/protocol"

import { TransferAssembler } from "./transfer-assembler.js"

const bundle = Buffer.from("PACK bundle bytes for one session worktree")
const digest = createHash("sha256").update(bundle).digest("hex")

function chunk(sequence: number, bytes: Buffer, final = false) {
  return { sequence, bytes: bytes.toString("base64"), final }
}

describe("transfer stream", () => {
  it("accepts a bundle sent as ordered chunks", () => {
    const assembler = new TransferAssembler({ digest, totalBytes: bundle.length })
    const half = Math.ceil(bundle.length / 2)

    expect(assembler.accept(chunk(0, bundle.subarray(0, half)))).toEqual({ state: "receiving" })
    const done = assembler.accept(chunk(1, bundle.subarray(half), true))

    expect(done).toEqual({ state: "complete" })
    expect(assembler.bytes().equals(bundle)).toBe(true)
  })

  it("refuses a chunk that arrives out of order", () => {
    const assembler = new TransferAssembler({ digest, totalBytes: bundle.length })

    expect(assembler.accept(chunk(1, bundle))).toEqual({
      state: "refused",
      reason: "chunk-out-of-order",
    })
  })

  it("refuses a chunk it has already taken", () => {
    const assembler = new TransferAssembler({ digest, totalBytes: bundle.length })
    assembler.accept(chunk(0, bundle.subarray(0, 4)))

    expect(assembler.accept(chunk(0, bundle.subarray(0, 4)))).toEqual({
      state: "refused",
      reason: "chunk-out-of-order",
    })
  })

  it("refuses more bytes than the transfer declared", () => {
    const assembler = new TransferAssembler({ digest, totalBytes: 4 })

    expect(assembler.accept(chunk(0, bundle))).toEqual({
      state: "refused",
      reason: "transfer-too-large",
    })
  })

  it("refuses a bundle whose bytes do not match the digest", () => {
    const assembler = new TransferAssembler({
      digest: createHash("sha256").update("something else").digest("hex"),
      totalBytes: bundle.length,
    })

    expect(assembler.accept(chunk(0, bundle, true))).toEqual({
      state: "refused",
      reason: "digest-mismatch",
    })
  })

  it("hands back nothing once a late chunk refuses a completed transfer", () => {
    const assembler = new TransferAssembler({ digest, totalBytes: bundle.length })
    assembler.accept(chunk(0, bundle, true))

    expect(assembler.accept(chunk(1, bundle))).toEqual({
      state: "refused",
      reason: "chunk-out-of-order",
    })
    // A refused transfer must not look complete, or its empty bytes would
    // restore as an empty worktree.
    expect(() => assembler.bytes()).toThrow("Transfer is not complete")
  })

  it("refuses to hand back bytes it has not finished verifying", () => {
    const assembler = new TransferAssembler({ digest, totalBytes: bundle.length })
    assembler.accept(chunk(0, bundle.subarray(0, 4)))

    expect(() => assembler.bytes()).toThrow("Transfer is not complete")
  })

  it("bounds a single chunk", () => {
    const oversized = {
      sequence: 0,
      bytes: Buffer.alloc(maximumTransferChunkBytes + 1).toString("base64"),
      final: false,
    }

    expect(transferChunkSchema.safeParse(oversized).success).toBe(false)
  })
})
