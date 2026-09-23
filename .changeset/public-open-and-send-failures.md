---
"@getdomovoi/daemon": patch
---

`project.open` on a folder that is not a Git repository, a path that does not exist, or a repository with no commits now answers "That folder is not a Git repository with at least one commit" instead of "Internal daemon error", and `domovoid open` prints that sentence. The git error stays in the daemon log. When `session.send` cannot connect to the provider, resume its thread, or start a turn, the session records the classified provider failure, so clients show the sign-in, quota or change-model guidance, and the call answers with that failure's fixed message. Timeouts and cancellations keep their existing handling.
