---
"@getdomovoi/daemon": patch
---

A connection that joins a terminal gets output still waiting in the batch either in its record or
live, not both. Closed terminal records share one budget of 1,048,576 characters, and the oldest
are dropped first when a new one would not fit.
