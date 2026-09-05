---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/mobile": patch
---

Carry a `protocol-mismatch` payload on every `protocolVersionMismatchErrorCode`
(`-32012`) refusal: the refusing daemon's protocol version, the client's, and the
`protocolCompatibility` result between them, validated by `protocolMismatchSchema`.
`system.hello` and `device.claim` send it with their sentence unchanged. The fleet
dialer reads the peer's version from the payload and falls back to the sentence
only for a daemon that predates it, and the phone names both versions from the
payload with the same fallback.
