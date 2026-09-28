---
"@getdomovoi/daemon": patch
---

The daemon's repository configuration reader now reads a repository's own Codex configuration
without running any of it, for the tool inventory and repository trust. It reads
`.codex/config.toml` as TOML data, `.codex/hooks.json`, and the skill folders `.codex/skills` and
`.agents/skills`, and counts `.codex/rules` in the configuration digest. It lists MCP servers
(a local server's command, redacted, and the names of the variables it receives; a remote
server's host and the names of the variables whose values Codex sends it, never an inline token
or header), each server's header helper by its program alone with every argument cut, tool
approval modes, hooks from both files, the names of the variables set for the agent's commands
(never their values), the approval and sandbox settings, each named permission profile's grants
(the profile it extends, workspace roots, filesystem access, network settings, domains and unix
sockets), the shell's variable filters, plugins, skills, and instruction overrides. An
instruction override is listed as present, never by its text. The file `model_instructions_file`
names is listed by its path and, when it is in the repository, hashed into the digest with the
same caps and link handling as every other file. Keys Codex ignores in a project file, such as
`notify` and model providers, are not listed, and like every byte of the file they are in the
digest.

Only the repository root's `.codex` folder is read, and a `.codex` folder that is Codex's own
home is skipped, as Codex skips it. The reader also returns trust refusal codes for Codex input
the digest does not cover: `nested-config` for a `.codex` folder or `.agents/skills` below the
root on a named session folder's way down, `main-checkout-hooks` when a linked worktree's main
checkout holds Codex hooks, `main-checkout-unknown` when a link or a mismatch is on the way to
that main checkout, and `instructions-outside` for an instruction file outside the repository or
reached through a link. Domovoi starts every Codex thread at a worktree's root, so nothing below
the root is checked unless a session folder is named.

TOML whose inline arrays and tables nest more than 64 levels deep, or that does not parse, is
reported unreadable with the reason `invalid-toml`. A parse that takes longer than 2 seconds is
reported unreadable with the reason `too-slow`; the parse is synchronous, so this refuses the
result and does not stop the parse. The TOML parser is smol-toml, which reads the document as
data and runs nothing from it.
