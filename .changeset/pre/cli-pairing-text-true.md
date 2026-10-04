---
"@getdomovoi/cli": patch
---

`domovoi --help`, the not-paired message and the refusal for a pasted code no longer say that `domovoid pair --client cli` prints a credential. That command needs `--label` and prints a one-time pairing code, which `domovoi pair` refuses. The text now says so, and that a client credential comes from a device.pair request made with the daemon's own credential.
