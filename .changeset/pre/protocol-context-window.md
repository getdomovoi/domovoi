---
"@getdomovoi/protocol": minor
---

Let `session.usage` carry context occupancy. `contextTokens` and
`contextWindowTokens` are both optional, and occupancy is rejected without the
window it was measured against, so a client can show a context readout only when
the provider reported both numbers.
