---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": patch
---

Fix provider usage accounting and persist dispatch attribution, deduplication and coverage across restart and transfer.

Versioned transfers use contract v2 to carry portable accounting. Both endpoints must support v2; strict v1 receivers cannot parse the added evidence.
