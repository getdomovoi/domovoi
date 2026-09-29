---
"@getdomovoi/daemon": patch
---

The daemon now decides repository trust per session worktree, in one module. A worktree is
trusted only when it holds nothing that refuses trust and its configuration digest is the one this
machine's grant names. Otherwise it is held back, with a reason code: `not-trusted` with no grant,
`cannot-trust` when the worktree holds input the digest does not cover, `config-changed` when its
configuration is not the one trusted, and `unreadable` when it cannot be read. A trusted verdict
gives the worktree's `.claude/settings.json`, `.mcp.json` and `.codex/config.toml` parsed from the
same bytes the digest covers. The reader returns those documents only when asked, so an inventory
read still holds no configuration text. Nothing loads under a trusted verdict yet.

Every call that opens a provider thread or starts a turn now carries the grant, looked up in the
trust store at that call: session creation, fork, provider restart, provider handoff, resume and
each turn. Resuming a thread only to archive it carries none. A trust store that fails is reported
and gives no grant. Every adapter ignores the grant for now.

`tool.inventory` now marks an entry held back where its adapter provably keeps it from the agent:
every entry from `.claude/settings.json` and `.mcp.json` for Claude Code, which starts with the
person's own settings only, and every entry from `.codex/config.toml` and `.codex/hooks.json` for
Codex, which refuses a worktree holding them. Skills, OpenCode, Kilo and the ACP agents stay
unmarked. `tool.inventory` and `repository.trust` read the repository root as a session's linked
worktree reads it, so hooks in the root's own `.codex` folder, which Codex would take into every
session, refuse trust there with `main-checkout-hooks`.
