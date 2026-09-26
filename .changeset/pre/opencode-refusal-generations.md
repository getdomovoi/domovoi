---
"@getdomovoi/daemon": patch
---

A subagent refusal that fails after its OpenCode or Kilo thread was unloaded is dropped instead of
being kept for the thread's next load, and a subagent deletion seen before its creation is
remembered so the creation that follows adopts nothing.
