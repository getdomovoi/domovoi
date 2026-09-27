---
"@getdomovoi/daemon": patch
---

Publishing the staged runtime is a transaction: `staged` carries a `revert` step, and once `installDaemonService` or `updateDaemonService` has published, every later failure (a failed check of the published runtime, a receipt or file operation, a manager command, a service that never reports ready) reverts it, on every platform, so the previous copy of that version is back.
