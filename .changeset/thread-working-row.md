---
"@getdomovoi/ui": patch
---

Show the working row while a turn runs before its first tool call

A running turn drew nothing in the thread until the agent called a tool, so a
long first pause looked like a stall. The thread now renders the activity row in
its working state, with the pulse bar, until a tool row takes over the signal.
