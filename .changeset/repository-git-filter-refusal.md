---
"@getdomovoi/daemon": minor
---

`session.create`, `session.fork` and a session transfer arriving now refuse to check a repository out
when the new worktree would run a git filter the repository's own Git config sets. The worktree is
added without a checkout, Git's config is read as that worktree reads it (so a filter an
`includeIf "onbranch:"` include or a copied `config.worktree` sets is found), and it is checked
out only when no such filter would run. Otherwise the worktree and the branch it made are taken
away and nothing runs. `session.create` and `session.fork` answer with
`repositoryGitFilterErrorCode` and the drivers, the configuration digest and the repository's
trust read at that moment; a transfer keeps its existing refusal. Filters from the person's global
or system Git config, and the exact lines `git lfs install` writes, still run. The Git LFS
settings in the repository's own config that make git-lfs start a program (a custom transfer
agent's path or args, a standalone transfer agent, an extension's clean or smudge command) are
refused, reported and pinned like a filter command.

The repository trust digest now covers each filter driver the repository's own Git config sets,
by scope, key and value, so a grant pins them. A repository that sets none keeps the digest it
had, and every grant recorded for it keeps its meaning. `tool.inventory` lists those drivers in
the repository's `gitFilters` block, each held back: nothing runs a repository filter under trust
yet. A Git config the daemon cannot read (past its output cap, or any failure other than the
folder not being a Git repository) changes the digest and is listed as unreadable with its
reason, so trust granted over the readable config no longer applies.
