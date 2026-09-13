/**
 * Admission v1 over the frozen relay codec at
 * 531a46b6bbb9e8286c42f9ad60476d4332d792aa. No relay server or dialing.
 * See docs/relay-admission.md for framing, credential checks and limits.
 */
export { createRelayClient, createRelayResponder, relayPublicKeyFromPrivateKey } from "./channel.js"
export type { RelayCarrier, RelayChannel, RelayClient, RelayClientOptions, RelayResponderOptions } from "./channel.js"
export { relayIdentityPublicKeyIsValid, relaySuccessorSigningBytes, verifyRelayChannelSuccessor } from "./identity.js"
