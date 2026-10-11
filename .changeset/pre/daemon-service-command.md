---
"@getdomovoi/daemon": minor
---

Add `domovoid service install`, `status`, and `remove`. The systemd user unit,
launchd agent, and Windows logon task generators now ship inside the package
instead of living as repository scripts no shipped command could reach.
