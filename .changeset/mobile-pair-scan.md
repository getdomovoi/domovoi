---
"@getdomovoi/protocol": minor
"@getdomovoi/mobile": minor
---

Pairing by camera. The protocol gains `pairingPayloadSchema` and its
encoder and decoder: the text a pairing QR carries, a daemon address (TLS,
or plaintext on loopback only) and a client credential. The phone gains
`expo-camera` and a Scan a pairing code screen that reads it, names the
machine, asks once and connects; a refused camera pastes the same text.
