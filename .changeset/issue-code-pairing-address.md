---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

`device.issueCode` answers with the address a device dials to spend the code, as
`pairingAddress`: `{ url, label?, loopback }`, the name on the certificate the daemon serves and
never the address it binds, or `{ problem }` when there is nothing a device could verify (no
certificate on a non-loopback listener, an unreadable certificate, a certificate naming no host or
several). The desktop pairing card, the web connect page and `domovoid pair` draw the same address
from this one answer; the command line no longer works it out on its own.
