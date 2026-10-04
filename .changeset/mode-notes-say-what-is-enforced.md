---
"@getdomovoi/ui": patch
---

The mode menu and the fresh session's "What it will do first" card now say what Plan and Ask hold
the provider to, as the daemon configures it. In Ask, Claude refuses edits and runs only its
read-only shell commands inside the worktree, opencode and kilo refuse edits and shell commands,
and Codex runs commands in a read-only sandbox and asks you first for a command that needs more.
Plan is Claude's own plan mode, opencode's and kilo's plan agent with edits and shell refused, or
Codex's read-only sandbox, which never asks. The old notes said Ask asks before each write and Plan
cannot run anything, which was not true for every provider. Ask shows a checkpoint row only for
Codex, the one provider that raises gates there.
