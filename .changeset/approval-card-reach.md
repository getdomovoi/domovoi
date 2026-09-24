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
account can except credential stores and secret files, and writes nothing; in Build it writes only
in the session worktree. A file path on the
card is redacted like the command, and a secret in it makes the gate a hard gate. Its control
characters show as escapes, and a long path is shortened in the middle. Inside or outside the
worktree is decided on the real path, so a link out of the worktree names where it leads.

One path classifier decides whether a path names a credential store or a secret file. It compares
path components after Unicode NFKC normalization with full case folding and without
default-ignorable code points, so a ligature such as "ﬁ", a fullwidth letter, or "ß" for "ss" reads
as the name it stands for. It takes either slash as a
separator, drops repeated separators and "." components, and judges a path both as written and with
".." applied. A store matches when its components appear in the path; the credential stores the
Codex sandbox refuses (such as `.git-credentials`, `.pgpass` and `~/.aws`) come from one list shared
by the sandbox, the card, and the command hard gate. A secret file matches on a component name: any
stem, including none, before `.pem`, `.key`, `.p12` or `.pfx`; `id_rsa`, `id_dsa`, `id_ecdsa` or
`id_ed25519` with any suffix; the `.env` family, a name that starts with `.env` or ends with `.env`
or `.envrc`, so `process.env.HOME` in a command or a file name is not one; and a few named files. When the card path, any
link followed on the way, any link target, or the file it ends at matches, the path is shown as
"[REDACTED]" with its location kept, and the gate is a hard gate. A command is split into shell words, each also
split on "=" and ":", and every word goes through the same classifier; a match makes the gate a hard
gate, as does the earlier command-line check. Shell words are read as a POSIX shell reads them, with
a backslash before a newline joining the lines and ANSI-C quotes such as `$'\x2eenv'` decoded the
way bash decodes them: escapes are bytes read as UTF-8, an octal escape past `\377` keeps its low
byte, and the quoted text ends at its first NUL byte. Words are also read with backslash as an
ordinary character, the way PowerShell and cmd read it. Other shell obfuscation (variables, command
substitution, `eval`, encodings, brace and glob expansion, and where another shell decodes an
ANSI-C quote differently from bash) is a known limit of matching command text.

`~/.docker` and `~/.domovoi` also hold ordinary files, so the card marks them by their secret files,
`config.json` and `daemon.token`. The store root itself, with or without a trailing slash, or with a
pattern such as `~/.docker/*`, names the whole store and is hidden and hard-gated too, so archiving
or copying it is a hard gate; a project's own `.docker/Dockerfile` and files in session worktrees
under `~/.domovoi` stay visible.

Each path is also judged at its real path when any of it exists: the card path, every operand of the
command and of a resolved script, and the directory the request runs in are resolved through the
filesystem, so a link with an ordinary name, or a name the filesystem treats as another, that reaches
a credential store makes the gate a hard gate. A path that does not exist yet is followed one
component at a time from its root, so a link is followed before a ".." after it, as the filesystem
does. The lookups for one request share a 2 second deadline; a lookup that runs out of time, or that
the filesystem refuses, treats the path as a credential path, so the card is a hard gate and the
session is never held. The directory the request runs in is persisted and sent with the card, so a
credential store there is shown as "[REDACTED]" with its location kept, the directory in the
execution record is hidden too, and the gate is a hard gate.

Before an Allow is accepted, the card's directory, file, and every operand are judged again on disk.
If a link has moved to a credential path since the card was made, which leaves the command text and
its execution digest unchanged, the Allow is refused and the card is shown again as a hard gate with
the path hidden.

An approval saved before this change is classified the same way, as written, when the state loads
and whenever it is saved, so its stored copy is repaired: the directory, the directory in the
execution record, the manifest a script came from, and a file line written before its path was
classified are hidden, and the approval becomes a hard gate. A standing rule whose execution record
holds such a path is dropped.
