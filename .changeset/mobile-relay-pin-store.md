---
"@getdomovoi/mobile": minor
---

The phone keeps the daemon's relay identity pin in SecureStore and exposes it to the protocol's
recovery and adoption functions. The compare runs under one queue per backing store shared by
every handle, every write is confirmed by read-back, and an unconfirmed write is reported as
unconfirmed; the writable store is constructed only in the app process.
