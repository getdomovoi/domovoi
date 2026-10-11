---
"@getdomovoi/protocol": minor
---

A `session.history` message entry may carry an optional `annotationsOverLimit`: how many open
annotations a sent message left out for the per-turn limit. It is a positive integer and only valid
on a message whose role is `user`. Entries without it parse as before.
