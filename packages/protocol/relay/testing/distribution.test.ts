import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import * as relay from "@getdomovoi/protocol/relay"
import { createRelayVectorCases } from "./vector-cases"
import fixture from "./cacophony-ik.json"

describe("published relay entry point", () => {
  for (const test of createRelayVectorCases(relay.createNoiseIk, fixture)) it(test.name, test.run)

  it("exposes only the suite-A codec and refuses test-oracle subpaths", () => {
    expect(Object.keys(relay).sort()).toEqual(["createNoiseIk", "relayNoiseSuite"])
    expect(relay.relayNoiseSuite).toBe("Noise_IK_25519_ChaChaPoly_SHA256")
    const require = createRequire(import.meta.url)
    for (const path of ["testing/node-noise-ik", "noise-ik", "testing/cacophony-ik.json"]) {
      expect(() => require.resolve(`@getdomovoi/protocol/relay/${path}`))
        .toThrow(expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }))
    }
  })
})
