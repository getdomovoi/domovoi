---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

A person can commit a session's work from the Changes tab. An agent's sandbox cannot write a
linked worktree's Git metadata, and it stays closed, so Domovoi makes the commit: the new
`session.commit` method commits every change in the session's own worktree as one commit on its
branch `domovoi/<session>`, with the person's message, through the isolated Git directory
checkpoints use (no repository hook, no program from repository config, unsigned). It refuses
when HEAD is on another branch, when the branch moved since the changes were read, in Ask and
Plan, while a turn runs, and when a path would add a credential, a private key or an environment
file. Nothing is pushed. The thread shows a commit checkpoint (`reason: "commit"`) with the
message, the branch, the files and the sha. Phone and tablet credentials cannot call it.
