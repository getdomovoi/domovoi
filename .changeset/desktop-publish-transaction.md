---
"@getdomovoi/desktop": patch
---

Each publish of the shipped runtime writes a fresh directory, `<profile>/runtime/<version>/<id>`, and never moves, replaces or deletes an earlier copy. Preparing writes nothing, not even the profile or its runtime directory; those and the copy are made at publish, under the service-operation lease. Each publish leaves its private staging directory, empty, outside every profile. Copies earlier services used are left in place.
