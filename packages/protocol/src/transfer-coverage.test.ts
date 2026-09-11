import { describe, expect, it } from "vitest"

import {
  sessionTransferCoverageSchema,
  sessionTransferExcludedKindSchema,
  sessionTransferIncludedKindSchema,
  sessionTransferWarningKindSchema,
} from "./transfer-coverage.js"

describe("transfer coverage bounds", () => {
  it.each([
    ["included", sessionTransferIncludedKindSchema.options],
    ["excluded", sessionTransferExcludedKindSchema.options],
    ["warnings", sessionTransferWarningKindSchema.options],
  ] as const)("allows every %s kind and rejects an oversized list", (field, kinds) => {
    const entries = kinds.map((kind) => ({ kind }))
    const coverage = { included: [], excluded: [], warnings: [], [field]: entries }
    expect(sessionTransferCoverageSchema.safeParse(coverage).success).toBe(true)

    const result = sessionTransferCoverageSchema.safeParse({
      ...coverage,
      [field]: [...entries, ...entries.slice(0, 1)],
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Oversized coverage was accepted")
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "too_big", maximum: kinds.length, path: [field] }),
    ]))
  })
})
