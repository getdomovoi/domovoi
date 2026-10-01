---
"@getdomovoi/protocol": minor
---

`repository.trust` takes an optional `gitFilters: { reviewed: true }`. A client sends it when it showed the person every git filter the repository's own Git config sets, from `tool.inventory`'s `repository.gitFilters` read with the same `configDigest`. Only a grant made with it lets the daemon run those filters; a grant made without it, by an older client or before filters could run, keeps them held back, and a refusal over a filter under such a grant reports the repository as trusted.

Each `clean`, `smudge` and `process` entry in `tool.inventory`'s `repository.gitFilters` carries `required`: `"true"`, `"false"` or `"unset"`, the driver's effective `filter.<driver>.required`, which the trust digest pins. A Git LFS setting carries none.
