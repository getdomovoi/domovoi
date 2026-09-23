---
"@getdomovoi/daemon": patch
---

An OpenCode or Kilo subagent is now bound to the turn that started it. When that turn ends, any
approval the subagent is still waiting on is refused on the provider and forgotten, so answering its
card later does nothing and the subagent's work does not run. Anything the subagent sends after its
turn ended is dropped instead of being attached to the next turn. Approvals the thread's own agent
asked for are unchanged.
