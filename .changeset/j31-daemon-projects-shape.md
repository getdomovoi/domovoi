---
"@getdomovoi/daemon": minor
---

Every snapshot the daemon sends lists its active projects in `projects` and states `projectCap`.
The daemon still keeps one project open at a time, so the list holds the open project, or nothing
before one is opened, and the cap is 1. A `session.create`, `tool.inventory` or `skill.*` call that
names a `projectId` other than the open project's is refused with "That project is not open. Open it
first, or leave projectId out to use the open project." Naming the open project answers as leaving
it out does. `project.close` is refused with "Closing a project is not available yet. Opening another
project switches to it after you confirm the sessions it stops." and changes nothing. A phone or
tablet credential cannot call it.
