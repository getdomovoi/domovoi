---
"@getdomovoi/ui": patch
---

The command palette takes the Desktop V2 frame: 660px wide at 96px from the top, a plain query
row with the scope on its right, and one line per row with a coloured dot, the label and the meta
on the right. The design's commands come first, and the commands it does not draw follow them.
Machines and skills sit under their own headings now that rows carry no kind tag.

Sessions on other machines follow the design. A machine left out after it did not answer stays
out, later queries included, until Add it back asks it again. Each machine header shows its answer
dot and a sweep while it is asked. A row picked on another machine stays on screen, marked
switching to that machine, until the session opens there. Row meta is the session's state and
age; a running session shows no duration, because the wire carries no turn start yet.
