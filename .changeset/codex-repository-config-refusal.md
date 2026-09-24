---
"@getdomovoi/daemon": patch
---

Codex sessions are refused in a worktree that holds configuration Codex would load from the
repository itself: `.codex/config.toml`, `.codex/hooks.json` or `.codex/rules/*.rules`, in any
directory from the session's directory up to the project root. Codex loads these once the person
trusts the project, and they can start programs or change agent permissions. The refusal happens
before Codex is asked anything, at session start, fork, a switch onto Codex, resume and each turn,
and names the file: "Codex would load .codex/config.toml from this worktree, and that file can start
programs or change agent permissions. Domovoi does not load repository-brought configuration until a
trust gate ships. Remove .codex/config.toml from this worktree or use another provider here."

A session worktree is a linked git worktree, and Codex takes hook declarations for it from the
repository's main checkout: `.codex/hooks.json` and the `[hooks]` table of `.codex/config.toml`, in
the main checkout folder matching each directory from the session's directory up to the worktree
root. When the worktree is clean but the main checkout holds one of these files, the session is
refused at the same points and names the file and the main checkout: "Codex would load
.codex/hooks.json from this repository's main checkout at /path/to/repo, and that file can start
programs or change agent permissions. Domovoi does not load repository-brought configuration until a
trust gate ships. Remove .codex/hooks.json from the main checkout or use another provider here."
