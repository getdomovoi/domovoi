---
"@getdomovoi/daemon": patch
---

Move machine credentials and their index behind a bounded serialized worker so a slow OS
keychain cannot stop unrelated RPC, provider or terminal delivery. Keep caller deadlines
across queueing, construction and native steps, without allowing timed-out work to be overtaken.
Recheck fleet eligibility after reads and preserve journal digest checks during index repair
and deletion. The local fleet-keychain recovery CLI uses the same worker.

No wire or pairing migration is required. Native work already entered can finish after the
caller expires; pending operations stay visible until reconciliation verifies the result.
A failed worker requires a daemon restart. Shutdown reports failure if its exit is unconfirmed.
