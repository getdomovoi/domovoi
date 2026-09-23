---
"@getdomovoi/daemon": patch
---

Codex sessions can no longer read common credential stores. Every Codex mode ran with whole-disk
read access, so a command such as `cat ~/.aws/credentials` ran inside the sandbox with no approval
card. The daemon now starts `codex app-server` with two permission profiles, `domovoi-read` for Ask
and Plan and `domovoi-build` for Build, and selects one per turn in place of the old sandbox policy.
Both keep the previous read, write and network limits and deny reads of `~/.ssh`, `~/.aws`,
`~/.domovoi`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.gnupg` and other credential
stores. Other reads outside the worktree still run without a card; a strict allow-list waits for a
survey of the toolchains commands load. A denied command fails with "Operation not permitted", and
commands that need `~/.gnupg` or `~/.npmrc`, such as signed commits, fail inside the sandbox too.
