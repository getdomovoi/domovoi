---
"@getdomovoi/mobile": patch
---

Keep a gate's decision problem on the phone when it drops to watching.

A connection that drops while an answer is out leaves the phone watching. The approval screen drew
the decision problem only beside the decision buttons, so the sentence saying the answer may or may
not have landed disappeared when it mattered most. The screen now draws it above the watching note
too, still scoped to the approval it answered, as the tablet gate card does since #820.
