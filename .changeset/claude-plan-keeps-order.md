---
"@getdomovoi/daemon": patch
---

A Claude working plan keeps the order the person gave it. Claude's task tools carry no order, so a
step the person inserted used to come back last, and one intermediate plan dropped it while Claude
adopted the edit. The daemon now applies each Claude task change to the working plan's own order
instead of replacing the plan: a task takes the step it showed before, else the first step with
the same text, else the step with its text before Claude reworded it, which is renamed in place.
A new or changed task that matches no step is appended, never dropped. A deleted task removes its
step. An unchanged task whose step the person removed stays out until Claude changes it. Which
step showed which task is held in memory, so after a daemon restart tasks match by text alone.
Steps already in the plan are never cut to fit the plan's size bounds. Codex, TodoWrite and ACP
plans still replace the plan, as they send the whole ordered list.
