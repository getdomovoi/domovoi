---
"@getdomovoi/daemon": patch
---

On Windows the daemon runs Git by an absolute path. Windows looks for a bare command name in the current directory before PATH, and a session worktree is the current directory of most daemon Git commands, so a `git.exe` committed to a repository could run as you before any filter isolation. Every daemon Git command now takes the first `git.exe` in an absolute PATH entry, passing over empty, relative and drive-relative entries and never looking in the current directory, and refuses when there is none. On macOS and Linux Git is still found by the system's PATH search, which does not look in the current directory unless PATH names it, except for the Git commands of checkpoint, snapshot, restore, file revert, transfer, evidence and a new session's checkout: those run the first `git` in an absolute PATH entry, by its absolute path, found once per operation, and refuse when there is none.
