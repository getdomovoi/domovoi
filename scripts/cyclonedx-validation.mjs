import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import Ajv from "ajv"
import addFormats from "ajv-formats"
import addInternationalFormats from "ajv-formats-draft2019"

// All references are registered locally. No loadSchema hook or network fallback.
// These are the upstream 1.6 files, not a locally weakened subset of the schema.
const pinnedSchemas = {
  "spdx.schema.json": "baa9d3bd1ed57b6751b0887edead6b5063ff53ff7429cf85d476c6c94af0166e",
  "jsf-0.82.schema.json": "8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae",
  "bom-1.6.schema.json": "3e92dddbc30cf7f6a02b80f0942b1a4cfd4fb1c26f1dfc4310afa9d613cafb93",
}
let validate
export function validateCycloneDx(document) {
  // Upstream types specVersion as a string, not a version-specific constant.
  if (document?.specVersion !== "1.6") throw new Error("Expected a CycloneDX 1.6 document")
  if (!validate) {
    // Upstream has annotation keywords outside Ajv's strict vocabulary.
    // Disable strict-schema linting, not schema or format validation.
    const ajv = new Ajv({ strict: false, allErrors: true })
    addFormats(ajv)
    addInternationalFormats(ajv)
    for (const [file, digest] of Object.entries(pinnedSchemas)) {
      const bytes = readFileSync(new URL(`./fixtures/cyclonedx-1.6/${file}`, import.meta.url))
      if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error(`CycloneDX 1.6 schema digest differs: ${file}`)
      ajv.addSchema(JSON.parse(bytes))
    }
    validate = ajv.getSchema("http://cyclonedx.org/schema/bom-1.6.schema.json")
  }
  if (!validate(document)) throw new Error(`Invalid CycloneDX 1.6 document: ${JSON.stringify(validate.errors)}`)
}
