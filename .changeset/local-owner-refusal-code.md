---
"@getdomovoi/protocol": minor
---

Add `localOwnerRequiredErrorCode` (`-32019`) for a method the daemon answers only
to its owner on a direct loopback connection. It is a policy refusal, not a
credential failure, so a client that receives it keeps the connection open.
