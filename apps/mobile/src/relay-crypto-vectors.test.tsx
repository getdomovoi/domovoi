import { describe, it } from "@jest/globals"

import { relayVectorCases } from "../../../packages/protocol/relay/testing/vector-cases"

// jest-expo runs in Node. This checks the mobile transform/module environment,
// not Hermes execution, native entropy, or non-exportable key storage.
describe("experimental relay codec in the phone jest-expo runner", () => {
  for (const test of relayVectorCases) it(test.name, test.run)
})
