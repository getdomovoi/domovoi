---
"@getdomovoi/protocol": minor
---

Add `usage.window`, a read-only total of tokens, provider-reported cost, turns,
and sessions recorded on one daemon between two instants. The window is half
open, must end after it starts, and carries no per-session breakdown.
