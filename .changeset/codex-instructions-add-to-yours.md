---
"@getdomovoi/daemon": patch
---

Domovoi's note about the files the Codex sandbox refuses is now added to your own Codex developer
instructions instead of replacing them. Before each Codex thread starts, Domovoi asks Codex for the
`developer_instructions` it resolved for the session worktree (`config/read`) and sends both. If
Codex cannot answer that request, the thread does not start.
