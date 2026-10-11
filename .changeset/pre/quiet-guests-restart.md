---
"@getdomovoi/daemon": patch
---

Add a guest crash supervisor with three bounded restarts, private atomic evidence and explicit exhaustion status. Stop and retire one supervisor registration, proving its loop and recorded children dead before task removal. Service status returns failure for exhausted, failed or unbound supervision while preserving its diagnostics. WSL installer selection remains pending.
