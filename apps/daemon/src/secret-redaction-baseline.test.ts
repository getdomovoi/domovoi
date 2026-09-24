import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

// secret-redaction-baseline.ts is main's redaction code, the oracle the
// differential fuzz holds the terminal redactor to. Nothing edits it: its bytes
// are held to the file at 8bda137f, by the Git object id of
// apps/daemon/src/secret-redaction.ts there.
const baselineBlob = "ba74856f6a2dea610bca6fd23b36374d58481578"

describe("main's redaction code", () => {
  it("is byte-identical to apps/daemon/src/secret-redaction.ts at 8bda137f", () => {
    const bytes = readFileSync(new URL("./secret-redaction-baseline.ts", import.meta.url))
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
    expect(blob).toBe(baselineBlob)
  })
})
