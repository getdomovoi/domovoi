---
"@getdomovoi/protocol": minor
---

Add the `tailnet.status` observe method and `tailnetListenerStatusSchema`: the
daemon's tailnet listener is off, listening on an address and port with the
certificate's expiry, or refused with a bounded reason and whether the daemon
retries on its own.
