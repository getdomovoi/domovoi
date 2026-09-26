---
"@getdomovoi/daemon": patch
---

Name the installation step that ran out the bootstrap budget. An expired install reported only the
total, the phrase "including installation and verification", and the destination to inspect. That
does not say whether the download, the dependency install, the native terminal build or a
verification pass held the clock, which is the difference between retrying and diagnosing. The
refusal now appends the step that was still running and how long it had been running, and keeps the
unannotated total as its cause.

Nothing about cancellation changed. The same operation rejects at the same moment, an expired run
still publishes nothing, and staging cleanup still spends its own separate budget.
