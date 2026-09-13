---
"@getdomovoi/cli": minor
---

The paired-daemon record can carry the daemon's relay identity pin, and `relayPinStore` exposes
it to the protocol's recovery and adoption functions with compare-and-swap. Every writer takes
one exclusive lock per backing store, beside the credential file or under $HOME for the keyring,
so two handles or two processes cannot both pass the same compare.
