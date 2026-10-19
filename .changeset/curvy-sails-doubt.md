---
"@getdomovoi/daemon": patch
---

Bound evidence staging and reuse unchanged file identities. Keep oversized changes visible without enabling Commit.

Retain the second staging pass when clean or process filters are configured, so changing filter output cannot enable Commit with an unstable digest.
