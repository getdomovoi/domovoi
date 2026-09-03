import { expect, it } from "vitest"

import { diffByFile } from "./session-evidence.js"

const diff = [
  "diff --git a/src/one.ts b/src/one.ts",
  "index 111..222 100644",
  "--- a/src/one.ts",
  "+++ b/src/one.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1",
  "+const b = 2",
  "diff --git a/src/two.ts b/src/two.ts",
  "index 333..444 100644",
  "--- a/src/two.ts",
  "+++ b/src/two.ts",
  "@@ -5,1 +5,1 @@",
  "-const c = 3",
  "+const c = 4",
].join("\n")

it("splits a unified diff into the bytes belonging to each file", () => {
  const byFile = diffByFile(diff)

  expect([...byFile.keys()]).toEqual(["src/one.ts", "src/two.ts"])
  expect(byFile.get("src/one.ts")).toContain("+const b = 2")
  expect(byFile.get("src/one.ts")).not.toContain("const c = 3")
  expect(byFile.get("src/two.ts")).toContain("@@ -5,1 +5,1 @@")
})

it("names a renamed file by the path it now has", () => {
  const renamed = diffByFile([
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 90%",
    "rename from src/old.ts",
    "rename to src/new.ts",
  ].join("\n"))

  expect([...renamed.keys()]).toEqual(["src/new.ts"])
})

it("returns nothing for a diff the daemon did not send", () => {
  expect(diffByFile("").size).toBe(0)
})
