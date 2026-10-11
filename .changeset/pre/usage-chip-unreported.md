---
"@getdomovoi/ui": patch
---

The usage chip has three states of one shape: tokens, a separator, then a price or a ring.
With a reported cost it reads `42.1k · $0.38`. With no cost it reads `42.1k` alone and hides
the separator; "cost unavailable" is gone from the chip, the session row and the today row.
The popover gains a last row, "Provider window: not reported", saying the provider has not
stated its limit so no dial is drawn. The ring for a subscription waits on the wire carrying
the provider's window.
