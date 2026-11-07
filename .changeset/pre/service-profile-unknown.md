---
"@getdomovoi/daemon": patch
---

Given the caller's environment, install and removal refuse a registered launch agent or user unit whose saved configuration is missing, unreadable or malformed, with `ServiceProfileUnknownError`, before the handoff or any manager action: the profile it runs is not known. The command line, which passes no environment, is unchanged. Removal checks the caller's profile against the same read of service.json it then acts on.
