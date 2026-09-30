---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": patch
---

Phone and tablet credentials may now call `tool.inventory`, so the phone can show what the open
repository holds back, entry by entry. The method stays observe-tier and read-only: it reports
environment key names, never values, and commands the daemon has already redacted. Repository
trust is still granted and taken back from desktop or web only: `repository.trust` and
`repository.revokeTrust` remain outside the phone and tablet scope, and the daemon refuses them to
those credentials before reading their parameters.
