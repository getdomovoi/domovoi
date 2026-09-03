import { z } from "zod"

import { canonicalBase64DecodedByteLength } from "./identifiers.js"

export const maximumTransferChunkBytes = 1_048_576
export const maximumTransferBytes = 2_147_483_648
export const maximumTransferChunkEncodedCharacters = Math.ceil(maximumTransferChunkBytes / 3) * 4

export const transferChunkSchema = z.object({
  sequence: z.number().int().min(0),
  bytes: z.string().max(maximumTransferChunkEncodedCharacters).refine(
    (encoded) => {
      const decoded = canonicalBase64DecodedByteLength(encoded)
      return decoded !== undefined && decoded <= maximumTransferChunkBytes
    },
    "Transfer chunk bytes must be canonical Base64 within the chunk ceiling",
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
