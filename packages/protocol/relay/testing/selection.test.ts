import { describe, expect, it } from "vitest"
import { createNoiseIk } from "../index"
import { createNodeNoiseIk } from "./node-noise-ik"

describe("relay suite selection", () => {
  for (const factory of [createNoiseIk, createNodeNoiseIk]) {
    for (const suite of ["Noise_IK_25519_AESGCM_SHA256", "Noise_IK_P256_AESGCM_SHA256"]) {
      it(`${factory.name} refuses ${suite} without a fallback`, () => {
        expect(() => factory({ role: "responder", suite, prologue: new Uint8Array(),
          staticKey: new Uint8Array(32).fill(1), ephemeralKey: new Uint8Array(32).fill(2),
        })).toThrow("Relay channel rejected")
      })
    }
  }
})
