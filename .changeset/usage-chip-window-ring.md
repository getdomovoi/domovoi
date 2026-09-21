---
"@getdomovoi/ui": patch
---

Draw the provider window ring on the usage chip

When a provider reports its rolling usage windows, the chip now carries a ring
beside the token count instead of the count alone. Two windows run at once, so
the ring shows the tighter of the two, and its label names which window it
drew and when that window resets. The ring turns to the warning colour at 85
percent. A provider that reports no window still draws no ring, because an
inferred limit would be invented precision.
