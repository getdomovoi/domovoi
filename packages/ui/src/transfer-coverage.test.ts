import { describe, expect, it } from "vitest"
import {
  sessionTransferCoverageSchema,
  sessionTransferExcludedKindSchema,
  sessionTransferIncludedKindSchema,
  sessionTransferWarningKindSchema,
} from "@getdomovoi/protocol"

import { transferCoverageLists } from "./transfer-coverage.js"

describe("transferCoverageLists", () => {
  it("names every coverage kind the contract can report", () => {
    const coverage = sessionTransferCoverageSchema.parse({
      included: sessionTransferIncludedKindSchema.options.map((kind) => ({ kind })),
      excluded: sessionTransferExcludedKindSchema.options.map((kind) => ({ kind })),
      warnings: sessionTransferWarningKindSchema.options.map((kind) => ({ kind })),
    })

    const lists = transferCoverageLists(coverage)

    expect(lists.included).toHaveLength(sessionTransferIncludedKindSchema.options.length)
    expect(lists.excluded).toHaveLength(sessionTransferExcludedKindSchema.options.length)
    expect(lists.warnings).toHaveLength(sessionTransferWarningKindSchema.options.length)
    for (const line of [...lists.included, ...lists.excluded, ...lists.warnings]) {
      expect(line).not.toBe("")
      expect(line).not.toContain("undefined")
    }
  })

  it("names what a kind actually carries, so the list does not under-promise", () => {
    const coverage = sessionTransferCoverageSchema.parse({
      included: [{ kind: "thread" }, { kind: "runtime-settings" }],
      excluded: [],
      warnings: [],
    })

    const [thread, runtime] = transferCoverageLists(coverage).included

    expect(thread).toContain("tool and test history")
    expect(runtime).toContain("permission mode")
  })

  it("carries a count into the label when the daemon reports one", () => {
    const coverage = sessionTransferCoverageSchema.parse({
      included: [{ kind: "artifacts", count: 3 }, { kind: "thread" }],
      excluded: [],
      warnings: [],
    })

    expect(transferCoverageLists(coverage).included)
      .toEqual(["Artifacts (3)", "Thread, including tool and test history"])
  })
})
