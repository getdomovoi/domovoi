---
"@getdomovoi/daemon": patch
---

When an OpenCode or Kilo thread is stopped or its provider session is deleted, every approval still
pending for it or its subagents is refused on the provider and forgotten, so a later answer to its
card sends nothing. A provider-deleted session fails the active turn ("OpenCode deleted the
session") and unloads the thread. A deleted subagent's pending and failed refusals are dropped, and
an unknown session is adopted only from its creation event.
