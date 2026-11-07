---
"@getdomovoi/daemon": patch
---

An OpenCode or Kilo subagent first seen while its thread has no active turn is now never linked to a
later turn, so none of its requests become a card, and neither do those of anything it starts. A
refusal the provider did not accept is kept and sent again when its card is answered or the
thread's next turn starts or ends. A deleted subagent's record is dropped, with a bounded record of
recent deletions so it is not adopted again.
