---
"@getdomovoi/mobile": minor
---

The phone keeps the daemon's relay identity pin in SecureStore and exposes it to the protocol's
recovery and adoption functions. The compare runs under one queue per backing store shared by
every handle, every write is confirmed by read-back, and an unconfirmed write is reported as
unconfirmed; the writable store is constructed only in the app process.
On the first greeting from a paired daemon the phone enrols the daemon's published relay
identity as its trusted pin, or recovers a distrusted pin from the daemon's signed successor
verified against the saved pin only.
