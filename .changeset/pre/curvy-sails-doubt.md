---
"@getdomovoi/daemon": patch
---

Bound evidence staging and reuse unchanged file identities. Keep oversized changes visible without enabling Commit.

Retain the second staging pass when a changed path has a filter attribute, so changing filter output cannot enable Commit with an unstable digest. Unused filter drivers do not prevent reuse.
