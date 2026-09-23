import { describe, expect, it } from "vitest"

import { unifiedDiffLines } from "./session-evidence.js"

const diff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " import { readFileSync } from 'node:fs'",
  "-const old = 1",
  "+const next = 2",
  "}",
].join("\n")

describe("unifiedDiffLines", () => {
  it("names every line so a reader sees which way it went", () => {
    expect(unifiedDiffLines(diff)).toEqual([
      { kind: "meta", text: "diff --git a/src/app.ts b/src/app.ts" },
      { kind: "meta", text: "@@ -1,3 +1,4 @@" },
      { kind: "context", text: " import { readFileSync } from 'node:fs'" },
      { kind: "del", text: "-const old = 1" },
      { kind: "add", text: "+const next = 2" },
      { kind: "context", text: "}" },
    ])
  })

  it("keeps a bare marker, because an emptied line is still a change", () => {
    expect(unifiedDiffLines("+\n-")).toEqual([
      { kind: "add", text: "+" },
      { kind: "del", text: "-" },
    ])
  })

  it("reads a file header as meta, not as an addition", () => {
    expect(unifiedDiffLines("+++ b/src/app.ts\n--- a/src/app.ts")).toEqual([
      { kind: "meta", text: "+++ b/src/app.ts" },
      { kind: "meta", text: "--- a/src/app.ts" },
    ])
  })

  it("reports nothing for an empty diff", () => {
    expect(unifiedDiffLines("")).toEqual([])
  })
})
