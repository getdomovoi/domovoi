---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
"@getdomovoi/mobile": patch
---

Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
and provider initialization report the running release instead of a fixed development version.
Production startup refreshes the persisted local version without changing machine identity.
Wire protocol compatibility and existing pairings are unchanged.
