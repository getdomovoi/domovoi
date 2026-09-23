import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { UnifiedDiff } from "./session-evidence.js"

const diff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " const kept = 0",
  "-const old = 1",
  "+const next = 2",
].join("\n")

describe("UnifiedDiff", () => {
  afterEach(cleanup)

  it("colors an addition and a removal so the direction is readable", () => {
    render(<UnifiedDiff diff={diff} label="Unified diff" />)
    const added = screen.getByText("+const next = 2")
    const removed = screen.getByText("-const old = 1")
    expect(added.className).toContain("text-success")
    expect(added.className).toContain("bg-success/10")
    expect(removed.className).toContain("text-destructive")
    expect(removed.className).toContain("bg-destructive/10")
  })

  it("leaves context and headers uncolored, so only changes stand out", () => {
    render(<UnifiedDiff diff={diff} label="Unified diff" />)
    const context = screen.getByText("const kept = 0")
    const header = screen.getByText("@@ -1,2 +1,2 @@")
    expect(context.className).toContain("text-muted-foreground")
    expect(context.className).not.toContain("bg-success/10")
    expect(header.className).toContain("text-faint")
    expect(header.className).not.toContain("text-success")
  })

  it("carries the label, because two diffs can sit on one screen", () => {
    render(<UnifiedDiff diff={diff} label="Diff for src/app.ts" />)
    expect(screen.getByLabelText("Diff for src/app.ts")).toBeTruthy()
  })
})
