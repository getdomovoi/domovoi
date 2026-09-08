import { describe, expect, it } from "vitest"

import { relayVectorCases } from "../../../packages/protocol/experimental/relay/vector-cases"
import fixture from "../../../packages/protocol/experimental/relay/cacophony-ik.json"
import { createNoiseIk } from "../../../packages/protocol/experimental/relay/noise-ik"

describe("experimental relay codec in the daemon Node runner", () => {
  for (const test of relayVectorCases) it(test.name, test.run)

  it("copies Node Buffer inputs instead of retaining their shared slice views", () => {
    const staticKey = Buffer.from(fixture.init_static, "hex")
    const ephemeralKey = Buffer.from(fixture.init_ephemeral, "hex")
    const responderPublicKey = Buffer.from(fixture.init_remote_static, "hex")
    const peer = createNoiseIk({ role: "initiator", suite: fixture.protocol_name,
      staticKey, ephemeralKey, responderPublicKey, prologue: Buffer.from(fixture.init_prologue, "hex") })
    staticKey.fill(0)
    ephemeralKey.fill(0)
    responderPublicKey.fill(0)
    expect(Buffer.from(peer.writeHandshake(Buffer.from(fixture.messages[0]!.payload, "hex"))).toString("hex"))
      .toBe(fixture.messages[0]!.ciphertext)
  })
})
