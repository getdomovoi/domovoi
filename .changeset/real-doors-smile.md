---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": minor
---

Skip unchanged project rows on save and preserve operational errors when restoring several active projects.

Configure the active-project admission cap with DOMOVOI_PROJECT_CAP, including saved service settings. Default to three and accept values from one through sixteen. Persist the cap only when explicitly set, so default service configurations remain readable by older daemons.

Keep several projects active while shared focus moves between them. Opening or refocusing a project preserves other projects' turns, terminals, approvals and queued sends. Restore every active project at restart, retain projects above a lowered cap, and mark missing folders unavailable before admitting new turns. Bound folder checks to two seconds and report an unknown availability state on errors or timeout; keep these projects active while refusing turns until a check succeeds.

Route session operations, skill reviews, approvals and repository trust through the owning active project. Select transfer targets by unique active Git lineage and refuse ambiguous targets.
