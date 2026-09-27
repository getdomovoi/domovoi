import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

// secret-redaction-main-stage.ts is main's current redaction code, the #598
// terminal redactor included. It is a test oracle only: the differential
// fuzzes hold every path to hiding at least what it hides. Nothing in
// production imports it. Nothing edits it: its bytes are held to main's
// apps/daemon/src/secret-redaction.ts at cc99a7b4 (the merge of #539), by
// that file's Git object id. When main changes that file, copy it here and
// update the id.
const mainStageBlob = "2373bfe2820c7e5b9fce978eeb1bfec8dd0a2696"

describe("main's current redaction code", () => {
  it("is byte-identical to main's apps/daemon/src/secret-redaction.ts at cc99a7b4", () => {
    const bytes = readFileSync(new URL("./secret-redaction-main-stage.ts", import.meta.url))
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
    expect(blob).toBe(mainStageBlob)
  })
})
