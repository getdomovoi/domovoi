---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

When a browser tab's pairing request gets no answer because the connection failed, closed or timed out, the card now offers Try again, which sends the same code again, instead of Type a new code. If the daemon did spend the code the first time, its usual refusal follows. The card says the browser paired if the machine lists it under Machines.

Only a connection failure is retried. If the daemon answered but this tab cannot keep the credential, or the reply cannot be read (including a malformed reply envelope carrying the request's id, which used to wait out the deadline and offer Try again), the code may already be spent: the card says so, offers no retry, and names the device this browser was enrolled as, to revoke in the desktop app on that machine under Machines. Only the machine's own desktop app can revoke a device.
