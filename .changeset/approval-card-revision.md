---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
"@getdomovoi/mobile": patch
---

An Allow now answers the approval card the person saw. When a file-tool card's target changed
while it waited, the daemon updated only the card's execution record, which no card shows, so a
second Allow could approve a different file, or make a standing rule for it, without that file ever
being on screen.

Approval cards carry a `revision`, a non-negative integer that the daemon raises each time it
rewrites a card. A card saved before this reads as revision 0. `approval.resolve` takes the
`revision` the client showed: it is required for `allow-once` and `always-project` and optional for
`deny` and `deny-explain`. The daemon refuses an Allow whose revision is not the card's current one,
with "The file target changed; review the updated approval before allowing it" on a file-tool card
and "The resolved command changed; review the updated approval before allowing it" on any other.
The desktop and web card, the phone approval and denial screens and the tablet card send the
revision of the card they show. The protocol version stays 0.8.0.

A file-tool card's Affects line names the file the edit reaches, read the way execution resolution
reads it: "The file src/index.ts in the session worktree.", or, when the file is outside the
worktree, "The file /path, outside the session worktree." with ", through a link at <path>" when a
link inside the worktree leads there. A path that names a credential file, or that a link carries to
one, shows as [REDACTED], and the card is a hard gate: it offers no Always, and no standing rule or
Build auto answers it. Other text passes through the durable secret redaction; a card whose path
that redaction changes is a hard gate too, as a secret anywhere else in a card makes it. Control characters in the path are
escaped and a path past 512 characters is shortened in the middle. The line is set when the card is
raised and read again when the card is answered: if the file changed, the card is rewritten with the
new line under the next revision, broadcast, and the Allow is refused. Every Allow on a file-tool
card is read again this way, including a card the daemon could not resolve (a file with another
hard link, say), and a change in its target, Affects line, sensitivity or execution record rewrites
the card and refuses the Allow. An unresolved card still offers no Always.

A blocked or unresolved record reads the same whatever is at the file, so the daemon also reads the
file itself when the card is raised, with lstat alone and without opening it: the kind of entry
(regular file, directory, FIFO, socket, device, link or nothing), its device, inode and link count,
and the path it really leads to. On Allow it reads the file the same way, and any difference is a
change whatever the record says: a file swapped for a directory, a FIFO, a link, another hard link
or another file, or removed, rewrites the card and refuses the Allow. A file with nothing at it
then and now is unchanged. The path Claude Code blocked on is kept with the card in memory, so the
file resolves on Allow as it did when the card was raised. A file-tool name with whitespace around
it is that tool: the card, its record and what the card hides use the trimmed name.

A card whose Affects line shows [REDACTED] carries `{ state: "unresolved", reason:
"sensitive-content" }` as its execution record in every copy the daemon saves or sends
(`workspace.get`, `workspace.changed`, the saved store), so no client receives the path the line
hides. The daemon keeps the real record in memory only, for the reading on Allow, and forgets it
when the card leaves.

A card's directory is the directory the request runs in. A path Claude Code blocked on is sent
beside the request as `blockedPath` and is never the card's directory; before this the Claude
adapter sent it as the request's directory, so a blocked credential path reached every client and
the saved store. A directory that names a credential store, or one the durable redaction changes,
shows as "[REDACTED] in the session worktree" or "[REDACTED], outside the session worktree", the
card is a hard gate, and a resolved execution record, which names the directory, is replaced as
above and kept in memory for the reading on Allow.
