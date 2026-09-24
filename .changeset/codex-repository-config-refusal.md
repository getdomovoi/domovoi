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
