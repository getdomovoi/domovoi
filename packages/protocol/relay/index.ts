/**
 * Frozen Noise_IK_25519_ChaChaPoly_SHA256 wire composition, revision 34.
 * Byte/state changes require a compatibility break. External review is pending.
 * Pinned by relay/testing/wire-format.test.ts and its committed JSON fixtures.
 * No relay server, admission, key generation or key storage is supplied here.
 * See README.md and docs/relay-wire-format.md for the contract and limits.
 */
export { createNoiseIk, relayNoiseSuite } from "./noise-ik"
export type { NoiseIkOptions } from "./noise-ik"
