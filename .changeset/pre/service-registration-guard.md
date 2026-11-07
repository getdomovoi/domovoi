---
"@getdomovoi/daemon": patch
---

With no saved service configuration, a caller's install or removal asks the service manager for a Domovoi registration, not only the definition file: a launchd job loaded under Domovoi's label or any `sh.domovoi.*` label, or a loaded `domovoi*` systemd user unit, refuses it as a service whose profile is not known. Removal compares the caller's profile with the one the saved configuration names under its own home. A saved configuration an install cannot read or parse refuses with the specific refusal.
