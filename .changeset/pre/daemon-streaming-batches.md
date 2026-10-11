---
"@getdomovoi/daemon": patch
---

Batch adjacent streaming workspace deltas within the named 32 millisecond
budget while preserving session and operation order. Flush queued deltas
before snapshots, turn boundaries, other agent events, and shutdown so clients
cannot apply streamed text twice. Reuse the active assistant item during a
turn instead of scanning the full thread for every token.
Mutating RPCs now return their snapshot once to the caller while still
broadcasting the same change to every other client.
