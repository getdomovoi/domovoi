import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

// secret-redaction-main-stage.ts is main's current redaction code, the #598
// terminal redactor included. It is a test oracle only: the differential
// fuzzes hold every path to hiding at least what it hides. Nothing in
// production imports it. Nothing edits it: its bytes are held to main's
// apps/daemon/src/secret-redaction.ts at fe145825 (unchanged since 1dd9ee76),
// by that file's Git object id. When main changes that file, copy it here and
// update the id.
const mainStageBlob = "f657798b68c26b529010877cd1aa7165a890d4b9"

describe("main's current redaction code", () => {
  it("is byte-identical to main's apps/daemon/src/secret-redaction.ts at fe145825", () => {
    const bytes = readFileSync(new URL("./secret-redaction-main-stage.ts", import.meta.url))
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
    expect(blob).toBe(mainStageBlob)
  })
})
