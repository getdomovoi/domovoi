import { describe, expect, it } from "vitest"

import { coverageIsKnown, coverageLabel, revertPrompt } from "./file-evidence-copy"

const commit = "8f3c1de4a2b7c9d0e1f2a3b4c5d6e7f8a9b0c1d2"

describe("coverage", () => {
  it("says it cannot tell, rather than that nothing touched the file", () => {
    const label = coverageLabel({ state: "unknown", reason: "file-access-not-recorded" })
    expect(label).toBe("Domovoi cannot tell which runs touched this file")
    expect(label).not.toMatch(/no test|not tested|0 runs/i)
  })

  it("treats a missing association as unknown, not as none", () => {
    expect(coverageLabel(undefined)).toBe("Domovoi cannot tell which runs touched this file")
    expect(coverageIsKnown(undefined)).toBe(false)
  })

  it("says none only when the daemon actually proved none", () => {
    expect(coverageLabel({ state: "known", runIds: [] })).toBe("No recorded run touched this file")
  })

  it("counts the runs it was given", () => {
    expect(coverageLabel({ state: "known", runIds: ["r1"] })).toBe("1 recorded run touched this file")
    expect(coverageLabel({ state: "known", runIds: ["r1", "r2"] })).toBe("2 recorded runs touched this file")
  })
})

describe("revert", () => {
  it("names a checkpoint when one exists for that exact commit", () => {
    const prompt = revertPrompt("src/handler.ts", { kind: "restore", baseCommit: commit, checkpointId: "ckpt_6b0e" })
    expect(prompt.available && prompt.confirmation).toContain("checkpoint ckpt_6b0e")
  })

  it("names the commit when no checkpoint record matches", () => {
    const prompt = revertPrompt("src/handler.ts", { kind: "restore", baseCommit: commit })
    expect(prompt.available && prompt.confirmation).toContain("commit 8f3c1de")
    expect(prompt.available && prompt.confirmation).not.toMatch(/checkpoint/)
  })

  it("removes a file that never existed in the base commit, and says so", () => {
    const prompt = revertPrompt("src/replay.ts", { kind: "remove", baseCommit: commit })
    expect(prompt.available && prompt.verb).toBe("Remove")
    expect(prompt.available && prompt.confirmation).toContain("does not exist in")
    // "Revert to the version in ..." would be a lie for a file with no earlier
    // version.
    expect(prompt.available && prompt.confirmation).not.toMatch(/restore .* to the version/i)
  })

  it("carries the commit the confirmation was made against", () => {
    const prompt = revertPrompt("src/handler.ts", { kind: "restore", baseCommit: commit })
    expect(prompt.available && prompt.expectedBaseCommit).toBe(commit)
  })

  it("offers nothing when the target is unavailable, and says which kind", () => {
    expect(revertPrompt("a", { kind: "unavailable", reason: "unsupported-path" })).toEqual({
      available: false,
      reason: "This path cannot be reverted one file at a time.",
    })
    expect(revertPrompt("a", { kind: "unavailable", reason: "target-not-observed" }).available).toBe(false)
  })

  it("keeps the legacy revert when a daemon predates the contract", () => {
    // Absence means the daemon never answered, not that it refused. Removing
    // the control there would take away a working action.
    const prompt = revertPrompt("src/app.ts", undefined)
    expect(prompt.available).toBe(true)
    expect(prompt.available && prompt.verb).toBe("Revert")
    expect(prompt.available && prompt.expectedBaseCommit).toBeUndefined()
    expect(prompt.available && prompt.confirmation).toContain("session base commit")
  })
})
