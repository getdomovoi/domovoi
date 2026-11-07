---
"@getdomovoi/mobile": minor
---

The phone keeps the daemon's relay identity pin in SecureStore and exposes it to the protocol's
recovery and adoption functions. The compare runs under one queue per backing store shared by
every handle, every write is confirmed by read-back, and an unconfirmed write is reported as
unconfirmed; the writable store is constructed only in the app process.
Once the daemon has answered the greeting (never on a snapshot pushed before it) the phone enrols the daemon's published relay
identity as its trusted pin, or recovers a distrusted pin from the daemon's signed successor
verified against the saved pin only.
Pins are kept per machine, so pairing with a different daemon starts without one.
