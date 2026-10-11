---
"@getdomovoi/daemon": patch
---

A failed subagent refusal is retried only against the same link of that subagent, never against a
later subagent that reused the id, and a repeated deletion without a parent keeps the deletion's
original thread, so unloading that thread still clears it.
