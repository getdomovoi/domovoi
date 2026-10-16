---
"@getdomovoi/daemon": patch
---

In Ask, a Codex request to run a command outside its read-only sandbox raises a Domovoi card again.
Codex 0.162.1 sent such a request to the reviewer the person's own Codex configuration names, so
with `approvals_reviewer = "auto_review"` Codex decided it itself and Domovoi never saw it. Every
Codex thread and turn now names the person as the reviewer, a thread Codex reports routed to any
other reviewer is refused, and a report that Codex's own reviewer is deciding an approval stops the
Codex app-server.

An approved command can now write in the session worktree. The Codex sandbox refused all of
`~/.domovoi`, which holds the session worktrees, and Codex keeps every refusal for a command it runs
outside the sandbox, so an allowed write failed with "Operation not permitted" and, in Ask, Codex
could not read the worktree at all. The sandbox now refuses every entry of `~/.domovoi` except
`worktrees`, and the secret file patterns in every session worktree.

A Codex request Domovoi does not show as a card (a file change, a permissions grant, a question, an
MCP server's own request, the older approval requests, or one it does not know) is refused at once,
Codex is told, and the session shows the refusal in any mode. Before, Domovoi left most of these
unanswered and declined a tool server request it could not tie to a running call without showing
it. A refused request that names no session stops Codex, which every Codex session shows.
