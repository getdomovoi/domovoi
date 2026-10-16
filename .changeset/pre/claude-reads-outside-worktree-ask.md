---
"@getdomovoi/daemon": patch
---

Claude Code sessions now send reads outside the session worktree to an approval. Claude Code runs
its read-only commands (`cat`, `grep`, `find`, read-only `git` and others) and approves file reads
inside its working directory before Domovoi's approval callback runs, so `cat ~/.aws/credentials`
or a `Read` of a private key never produced an approval card, in any mode.

The daemon registers a `PreToolUse` hook for every Claude Code session. A `Bash`, `Read`, `Glob`,
`Grep`, `LS` or `NotebookRead` call that names a path outside the worktree (after following links),
starts with `~`, expands a variable, runs a bare `cd`, or runs from a shell directory outside the
worktree is sent to the approval path with the reason on the card. A read-only call that names a
secret, such as `git show HEAD:.env`, goes there too, so the credentials hard gate applies. In Ask,
which has no approvals, those calls are refused and recorded as a policy refusal. Reads that stay
inside the worktree still run without a card.

A standing rule no longer covers a `Read`, `Glob`, `Grep`, `LS` or `NotebookRead` of a path outside
the worktree: those requests are never fingerprinted, so each one asks.
