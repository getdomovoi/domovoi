---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

When a browser tab's pairing request gets no answer because the connection failed, closed or timed out, the card now offers Try again, which sends the same code again, instead of Type a new code. If the daemon did spend the code the first time, its usual refusal follows. The card says the browser paired if the machine lists it under Machines.

Only a connection failure is retried. If the daemon answered but this tab cannot keep the credential, or the reply cannot be read, the code is already spent: the card says so, offers no retry, and says to unpair the extra device under Machines.
