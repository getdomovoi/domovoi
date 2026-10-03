---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

Ruling Q401: the workspace snapshot now carries turn timing, one source for "Worked for N" and
the header clock on desktop and tablet. `turns` lists, for each turn the snapshot's thread links,
its `id`, `sessionId`, `ordinal`, `startedAt`, `completedAt` when known, and `status`. The daemon
derives it from its usage ledger for every snapshot it sends and never stores it; it is absent
when the thread links no turn. A pending turn is running; completed and failed turns ended when
the daemon saw them end; an interrupted turn has `completedAt` only when the daemon saw it stop.

A turn that was still running when the daemon itself stopped has no `completedAt` in the
snapshot: the restart time is not when it ended. The ledger still records that restart time, and
now says so: its turn metadata, and the `turn` on `session.history` entries, carry
`completedAtSource: "daemon-restart"` for such a turn. Records written before this change carry
no mark. Phone and tablet access is unchanged.
