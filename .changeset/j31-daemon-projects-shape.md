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

Stored state that a newer Domovoi wrote with several active projects, meaning a stored project
list naming another project, or a session or approval rule of another project with or without such
a list, is not loaded, and is not moved aside as corrupt. The store reads it before opening the
file for writing, from a private copy when the write-ahead log holds changes, so a refusal leaves
the database, its log and its index as they were. In a database damaged elsewhere, it is refused
before the database would be moved aside for salvage. The daemon does not start, says "Domovoi
state at <path> was written by a newer
Domovoi that keeps several projects open, and this daemon keeps one project open at a time. It was
left as it is and this daemon did not start. Run the newer Domovoi again.", and leaves the stored
rows as they are. A stored list naming only the open project is dropped when the state is read, so
it is not saved again after another project opens.
