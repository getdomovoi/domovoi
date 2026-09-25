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
does, and the directory the request runs in is read the same way, so `deep-link/..` is the directory
the link leads to. Operands are read from that real directory, and a script's operands from its
package's directory.

Every approval card is made in one place. A new card, a card judged again before an Allow, a card
read back from disk, and a request a standing rule would answer are all settled the same way: the
execution is resolved, the operands come from the command and from that execution, and the
directory as written and at its real path, the file, every operand, and the directory and manifest
in the execution record are judged. Any credential path among them makes the card a hard gate and
is hidden, and a manifest reached through a link into a store hides the execution record in every
copy the daemon saves or sends. One 2 second deadline covers the whole request, the execution
lookup included; a lookup that runs out of time, or that the filesystem refuses, gives a hard gate
with the directory, the file and the execution record hidden, and the session is never held. Only
a settled card enters the workspace state, and every save and broadcast seals any approval that did
not, as a hard gate with its paths hidden. A standing rule answers only a settled request that is
not a hard gate.

Before an Allow is accepted, the card is settled again from the request as it is now: a link can
move to a credential path, and a package script can change, after the card was made. If the card
changes, it is saved and sent, and the Allow is refused with "The file target changed; review the
updated approval before allowing it", or, when only the resolved command changed, "The resolved
command changed; review the updated approval before allowing it".

An approval saved before this change is classified as written when the state loads and whenever it
is saved, so its stored copy is repaired: the directory, the directory in the execution record, the
manifest a script came from, and a file line written before its path was classified are hidden, and
the approval becomes a hard gate. When the daemon starts or opens a project, its saved approvals are
then settled at their real paths before any client sees them. A standing rule whose execution record
holds such a path is dropped.

A saved card keeps its file only as its file line, so at load and at Allow each path that line names
is followed on disk under the same 2 second deadline: a file that became a link into a credential
store is hidden and the card becomes a hard gate, and a line that no longer reads back as a path
(shortened, with an escaped character, or in another format) seals the card. A saved file line is
read back only when it reads exactly one way as one of the card's three file sentences, no path in
it holds that sentence wording (" in the session worktree", ", outside the session worktree" or
", through a link at "), and the reading renders back to the same line; any other line seals the
card, so a file name that holds the wording cannot be read as other paths. A sealed card keeps a
provider's own reach line and hides any other Affects line, whatever its format.

A saved card's execution record is not trusted at load or at Allow. The execution is resolved again
from the card's saved directory, command, and, for a file or read tool, the file its file line
names, through the same resolution a new card uses and under the same 2 second deadline. If the
fresh result differs from the saved record in digest, state, or reason, or any path or operand on
the card reaches a credential store, the card becomes a hard gate and its record is hidden. A saved
card whose directory or file line is hidden cannot be resolved again, so it is sealed. So is a
saved card for a file or read tool, such as Edit or Read, whose resolution reads a file path, when
its Affects line is not a file
line that reads back as a path, such as a provider's reach line or an older daemon's wording, since
nothing on it says which file to judge.

When a card hides a path (a credential file or store, a hidden directory, or any path on a sealed
card), that path is replaced with "[REDACTED]" in the card's operation and command lines, and the
rest of the agent's text stays, so `cat ~/.aws/credentials` shows as `cat [REDACTED]`. The path is
matched as written, at its real path, and in the forms the path classifier compares. A hidden file
is also matched relative to the worktree and relative to the directory the request runs in, each
as given and as it really lies, so `src/.env` or `.env` for a hidden `src/.env` requested from
`src` is replaced; each relative form with "/" or "\" and with or without a leading "./". A name
that only starts with the path, such as `x.env.example` beside a hidden `x.env`, is kept. The text is
not split into words first, so a hidden name that holds a comma, a space, a quote or a colon, such
as `src/.env,prod`, is replaced whole. A secret file that only the agent's text names, such as
`src/private.pem` in the operation of a card for `src/index.ts`, is judged by the same classifier,
replaced the same way, and makes the card a hard gate. The classifier reads `.env.example` and
`.envrc` as secret files too, so those names are replaced as well. A hidden
directory at the start of a longer path is replaced, and a shell word that decodes into the path
through quotes or escapes is replaced whole. An execution record whose command words hold the path
is hidden. This holds for new, settled, sealed and saved cards, in workspace.get, workspace.changed,
the store and approval receipts. A relative word under a directory that is itself a credential path
is replaced only when it exists there, so a program name such as `ls` stays.
