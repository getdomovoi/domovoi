---
"@getdomovoi/protocol": minor
---

The workspace snapshot can describe several active projects on one machine. It gains `projects`,
every active project, and `projectCap`, how many projects the daemon keeps active at once (at most
`maximumProjectCap`, 16). `project` stays and is the focused project: one of `projects`, and null
only when no project is active. Each session and approval rule must belong to one of `projects`. A
snapshot without `projects`, such as one a daemon stored before this, reads as its focused project
alone; `workspaceProjects` returns the list either way.

`session.create`, `tool.inventory` and every `skill.*` call take an optional `projectId`; left
out, the daemon uses the focused project. A project id is at most 256 UTF-16 code units, in a
snapshot as in a call, so every listed project can be named. `project.close` (`projectId`, `client`, optional
`confirmation`) is declared with its confirmation, error code -32022, and its result: the snapshot
and each session it stopped, `stopped` or `unconfirmed`. It is a control call that changes stored
state, and a phone or tablet credential may not make it. A `project.open` past the cap is refused
with error code -32021 and `{ kind: "project_cap", cap, activeProjectIds }`. The wire record now
also covers the repository git filter refusal the daemon already sends. The protocol version stays
0.8.0.
