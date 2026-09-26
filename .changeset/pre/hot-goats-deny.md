---
"@getdomovoi/daemon": patch
---

Reject overlapping bundle restores before repository inspection or fetch, including independent
service instances sharing a worktree root. Keep later incremental restores and concurrent restores
of different sessions working. Release owned filesystem claims on normal completion, failure and
cancellation; report a claim left by a killed process for explicit recovery with Domovoi stopped.
