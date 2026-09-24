---
"@getdomovoi/daemon": patch
---

Approval cards no longer claim every request is contained. The daemon wrote "Files and processes in
the session worktree" and "No agent network access granted" into every approval, although only
Codex runs commands in a sandbox, and an approved Codex request usually asks to run outside it. The
card's Affects and Network facts now come from the provider and the request: an unsandboxed
provider (Claude Code, OpenCode, Kilo, ACP agents) says an approved command can reach anything the
user account can and has the machine's network access; Codex says what its sandbox allows and what
running outside it means; a request about a file names the file and says whether it is outside the
session worktree.

Codex's line follows the session's mode: in Ask and Plan the sandbox reads anything the user
account can and writes nothing; in Build it writes only in the session worktree. A file path on the
card is redacted like the command, and a secret in it makes the gate a hard gate. Its control
characters show as escapes, and a long path is shortened in the middle. Inside or outside the
worktree is decided on the real path, so a link out of the worktree names where it leads.
