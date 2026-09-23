---
"@getdomovoi/ui": patch
---

Let a prose plan be accepted from the plan panel

A provider that writes its plan as prose produces a plan document and no steps,
so the card that carries the decision row never rendered and the panel offered
no way to answer. The plan panel now carries the same decision row for a prose
plan, and says that selecting a line comments on it.
