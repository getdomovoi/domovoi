---
"@getdomovoi/cli": minor
---

The paired-daemon record can carry the daemon's relay identity pin, and `relayPinStore` exposes
it to the protocol's recovery and adoption functions with compare-and-swap. The file backend
takes an exclusive lock beside the credential file; the keyring backend serialises within the
process only.
