---
"@getdomovoi/ui": minor
---

Give a frozen session a way out. A move that stops leaves the session read-only,
and until now nothing in the product could release it, so recovery meant sending
a request by hand. Sessions that are moving, moved, released, or in conflict each
explain their own state, and where the daemon offers a recovery the notice
carries it behind a confirmation that states the trade before it is made.

A move that does not finish also says which stage it reached and what answers it,
instead of reporting every unfinished move with one sentence.
