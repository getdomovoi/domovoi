---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Start a session names its project: it defaults to the open project, lists the projects this machine has opened, and takes a folder, and starting in another project opens it through the switch confirmation first. The sessions column keeps a section per project, with its own New session, so opening another project no longer empties it; choosing a session in another project opens that project, then the session. The daemon answers the new `project.list` with each saved project, its sessions, and whether its folder is present, missing or unreadable.
