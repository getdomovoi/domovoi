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

export const transferStreamRefusalMessage: Record<TransferStreamRefusal, string> = {
  "chunk-out-of-order": "The transferred repository bytes arrived out of order, so the move was rejected",
  "transfer-too-large": "This session carries more than a transfer can send, so the move was rejected",
  "digest-mismatch": "The transferred repository bytes did not match their digest, so the move was rejected",
}
export type TransferChunk = z.infer<typeof transferChunkSchema>

export type TransferAcceptance =
  | { state: "receiving" }
  | { state: "complete" }
  | { state: "refused"; reason: TransferStreamRefusal }
