import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import * as baseline from "./secret-redaction-baseline.js"
import { redactDurableOutput } from "./secret-redaction.js"

// secret-redaction-baseline.ts is main's redaction code, run as the last stage
// of every redactor. Nothing edits it: its bytes are held to the file at
// 8bda137f, by the Git object id of apps/daemon/src/secret-redaction.ts there.
const baselineBlob = "ba74856f6a2dea610bca6fd23b36374d58481578"

describe("main's redaction code", () => {
  it("is byte-identical to apps/daemon/src/secret-redaction.ts at 8bda137f", () => {
    const bytes = readFileSync(new URL("./secret-redaction-baseline.ts", import.meta.url))
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
    expect(blob).toBe(baselineBlob)
  })

  // Main's code reads last, so it hides what it can still read. A first stage
  // that replaced a name but left part of its value would take away what main
  // reads the value by. The guarantee rests on the first stage replacing each
  // value it touches whole, which the differential fuzz checks.
  it("reads last, and cannot hide a value whose name an earlier stage took away", () => {
    const line = "curl --token \"abc zqxjwvkm\" -s"
    expect(baseline.redactDurableOutput(line).value).not.toContain("zqxjwvkm")
    const nameTakenPartOfValueLeft = line.replace("--token \"abc", "[REDACTED]")
    expect(baseline.redactDurableOutput(nameTakenPartOfValueLeft).value).toContain("zqxjwvkm")
    expect(redactDurableOutput(line).value).not.toContain("zqxjwvkm")
  })
})
