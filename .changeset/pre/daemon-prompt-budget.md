---
"@getdomovoi/daemon": minor
---

Give the provider prompt composer one total budget and a documented drop order.
`providerPromptBudgetCodeUnits` lowers the 262,144 UTF-16 code unit default and is
validated with the other daemon options. Over budget, the composer drops project-default
skills, open annotations, then handoff history, annotations, and artifacts one item at a
time, stops as soon as the prompt fits, records every drop on the sent turn's
`providerPromptDelivery`, and refuses the turn when the request, working plan, and handoff
summary cannot fit.
