---
"@getdomovoi/daemon": patch
---

A read-only Git command from Claude Code now asks in a partial clone (a promisor remote, a
partial-clone filter or `extensions.partialClone`), because commands such as `git log --stat` fetch
missing objects on demand and run the remote's programs to do it. A pretty format with an escaped
`%%G` no longer counts as a signature placeholder.
