---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

`session.send` accepts text files and worktree file paths as attachments beside images, at most two in total. Text files are written into the session worktree for the agent to read; worktree paths must stay inside the worktree. New refusal reasons: `invalid-text` and `invalid-workspace-file`.
