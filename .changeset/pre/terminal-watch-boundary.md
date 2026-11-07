---
"@getdomovoi/daemon": patch
---

A connection that watches a terminal gets output still waiting in the batch either in its record or
live, not both, including when it was already watching. Closed terminal records share one budget
of 1,048,576 characters and at most 16 records, and the oldest are dropped first when a new one
would not fit.
