---
"@getdomovoi/desktop": patch
---

Each publish of the shipped runtime writes a fresh directory, `<profile>/runtime/<version>/<id>`, and never moves, replaces or deletes an earlier copy. Preparing writes nothing; the copy is made at publish, under the service-operation lease. The private staging directory is removed only as an empty directory while it is still the one made for the copy. Copies earlier services used are left in place.
