---
"@getdomovoi/daemon": patch
---

Give each provider message its own thread item.

The daemon keyed the streaming assistant item on the turn, so every message a
provider sent during one turn appended into a single item. Two messages ran
together with no separator, and because the item kept the position it was
created at, tool calls that ran between messages were placed after all of the
text instead of where they happened.

The Codex adapter now forwards the provider item id on an agent message delta,
the same way it already forwards it on command output, and the daemon keys the
assistant item on that id. Adapters that report no item id keep the previous
turn-scoped behaviour.
