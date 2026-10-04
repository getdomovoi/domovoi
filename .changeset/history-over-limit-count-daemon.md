---
"@getdomovoi/daemon": patch
---

`session.history` now gives a sent message's entry `annotationsOverLimit` when its recorded prompt
delivery left open annotations out for the per-turn limit, with the count from
`providerPromptDelivery.annotations.omitted.limit`. A message whose count is zero, or that has no
recorded delivery, gets no field.
