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

Every Codex thread Domovoi starts or resumes now marks the project untrusted for that thread:
`thread/start` and `thread/resume` carry `config.projects` entries with `trust_level = "untrusted"`
for each path Codex consults for trust, the canonical path of every directory from the session's
directory up to the project root and of the repository root, which for a linked worktree is the main
checkout. Codex then loads no project `.codex` configuration, hooks or rules, and no longer writes a
trusted entry for the project into the person's Codex `config.toml` when a Build thread starts. A
trust level the person set for these paths is overridden for Domovoi's threads only; their
`config.toml` is not changed. Codex turns shell snapshots off for untrusted projects.

An untrusted project also stops Codex reading the repository's `AGENTS.md`, so Domovoi reads it and
sends it with every Codex turn as `additionalContext`, including the first turn after a resume:
`AGENTS.override.md` if it is a file, otherwise `AGENTS.md`, at the worktree root, in Codex's own
"AGENTS.md instructions" format, within Codex's default 32 KiB budget and Domovoi's existing limits
for instruction files (a regular file of at most 128 KiB that resolves inside the worktree). Text
over Codex's 4,000-byte limit for one context value is sent as numbered entries so Codex does not
shorten it. The person's own `~/.codex/AGENTS.md` still loads through Codex.

Codex does not escape a context value, so an `AGENTS.md` could close the `INSTRUCTIONS` tag and its
own entry and open a forged `domovoi-sandbox` entry. Domovoi sends the `<` of any `INSTRUCTIONS` or
`domovoi-` tag in the file, opening or closing, in any case, as `&lt;`, and never splits a `&lt;`
across two numbered entries. The rest of the file is sent as written.
