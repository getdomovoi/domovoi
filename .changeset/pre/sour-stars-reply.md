---
"@getdomovoi/daemon": minor
"@getdomovoi/protocol": minor
---

Add machine-local runtime discovery for remote session forms, with provider model
and reasoning choices, a complete default with Auto off, supported permission modes,
and explicit authentication, timeout, empty-catalog and discovery refusals.

Check provider readiness before offering or creating a runtime. Bound discovery
end to end, cancel expired catalog work, and prevent late results from poisoning
retries. Keep the existing model-list and session-create contracts and wire version.
