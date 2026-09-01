import { createHash } from "node:crypto"

import { z } from "zod"

export const maximumTransferChunkBytes = 1_048_576
export const maximumTransferBytes = 2_147_483_648

// Base64 carries three bytes in four characters, so the byte count a chunk
// claims is read from the encoded form rather than trusted.
export function encodedByteLength(encoded: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  return Math.max(0, (encoded.length / 4) * 3 - padding)
}

export const transferChunkSchema = z.object({
  sequence: z.number().int().min(0),
  bytes: z.string().refine(
    (encoded) => encodedByteLength(encoded) <= maximumTransferChunkBytes,
    "Transfer chunk is too large",
  ),
  final: z.boolean(),
}).strict()

export const transferStreamRefusalSchema = z.enum([
  "chunk-out-of-order",
  "transfer-too-large",
  "digest-mismatch",
])

export type TransferStreamRefusal = z.infer<typeof transferStreamRefusalSchema>
export type TransferChunk = z.infer<typeof transferChunkSchema>

export type TransferAcceptance =
  | { state: "receiving" }
  | { state: "complete" }
  | { state: "refused"; reason: TransferStreamRefusal }

// A transfer carries a worktree between machines, so the target decides what it
// has received rather than trusting the sender's account of it: chunks arrive
// in order, within the size the transfer declared, and the assembled bytes must
// hash to the digest agreed before the first chunk.
export class TransferAssembler {
  readonly #digest: string
  readonly #totalBytes: number
  readonly #chunks: Buffer[] = []
  #received = 0
  #next = 0
  #complete = false
  #refused = false

  constructor(input: { digest: string; totalBytes: number }) {
    this.#digest = input.digest
    this.#totalBytes = Math.min(input.totalBytes, maximumTransferBytes)
  }

  accept(chunk: TransferChunk): TransferAcceptance {
    if (this.#refused || this.#complete) return this.#refuse("chunk-out-of-order")
    if (chunk.sequence !== this.#next) return this.#refuse("chunk-out-of-order")

    const bytes = Buffer.from(chunk.bytes, "base64")
    if (this.#received + bytes.length > this.#totalBytes) return this.#refuse("transfer-too-large")

    this.#chunks.push(bytes)
    this.#received += bytes.length
    this.#next += 1
    if (!chunk.final) return { state: "receiving" }

    const assembled = Buffer.concat(this.#chunks)
    if (createHash("sha256").update(assembled).digest("hex") !== this.#digest) {
      return this.#refuse("digest-mismatch")
    }
    this.#complete = true
    return { state: "complete" }
  }

  bytes(): Buffer {
    if (!this.#complete) throw new Error("Transfer is not complete")
    return Buffer.concat(this.#chunks)
  }

  #refuse(reason: TransferStreamRefusal): TransferAcceptance {
    this.#refused = true
    // Nothing partial is kept: a refused transfer must not leave bytes behind
    // that could be mistaken for a delivered worktree.
    this.#chunks.length = 0
    this.#received = 0
    return { state: "refused", reason }
  }
}
