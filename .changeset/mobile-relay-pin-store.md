---
"@getdomovoi/mobile": minor
---

The phone keeps the daemon's relay identity pin in SecureStore and exposes it to the protocol's
recovery and adoption functions. The compare is done in the app process and every write is
confirmed by read-back; the writable store is constructed only in the app process.
