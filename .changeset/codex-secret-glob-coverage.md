---
"@getdomovoi/daemon": patch
---

The Codex sandbox now refuses the file names Domovoi's approval cards treat as secret in any letter
case, in the session's own worktree and in every session worktree. Before, its patterns matched only
lower case on Linux and in Codex's own reads, so `DAEMON.TOKEN`, `config/Credentials.json` or `.ENV`
stayed readable, and they matched a private key only at the start of a name, so `backup-id_ed25519`
and `keys/old.id_dsa` stayed readable. The thread's own worktree also gains the names only session
worktrees refused: `daemon.token`, `credentials.json`, `gh/hosts.yml`, `*.p12`, `*.pfx`, the other
private keys, the rest of the `.env` family, and the credential stores, such as `.ssh` and `.aws`,
by name. One table generates every list, and the history scan that names committed copies Codex can
still read through Git now reads the same names. The sandbox notice and the model's instructions
list them. Still readable: a secret name inside a longer file name after a space, colon, equals sign,
quote or backslash (`my daemon.token`), a name followed by a comma (`daemon.token,old`), and a name
written with Unicode compatibility characters such as fullwidth letters.
