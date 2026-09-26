---
"@getdomovoi/daemon": patch
---

The daemon resolves the PATH it looks for provider CLIs on at startup, from an override, the account's login shell and the launch environment, records it in tools.json, and names the absolute path each CLI was found at. A packaged app launched from Finder or the Dock no longer reports every harness as not installed.
