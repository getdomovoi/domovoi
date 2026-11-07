---
"@getdomovoi/protocol": minor
---

A system thread item may carry an optional `connectionId` (a UUID) and `clientId`, the same shape a
receipt uses, naming the connection that asked for a pause. Rows written before the fields existed
parse as before.
