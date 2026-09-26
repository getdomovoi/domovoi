---
"@getdomovoi/cli": patch
---

Wait on the credential lock when Windows answers EPERM or EBUSY for an open
that races the holder's unlink, instead of failing the operation.
