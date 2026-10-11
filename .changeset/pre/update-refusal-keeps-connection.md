---
"@getdomovoi/daemon": patch
---

Refuse `update.status`, `update.check` and `update.activate` off the loopback
owner connection with `localOwnerRequiredErrorCode` instead of the authentication
code. The refusal conditions and message are unchanged. A client no longer reads
the refusal as a revoked credential, so a paired tab that opens Settings keeps
its connection.
