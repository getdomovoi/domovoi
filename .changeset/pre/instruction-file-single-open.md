---
"@getdomovoi/daemon": patch
---

Domovoi reads the repository instruction files it sends to Claude, Codex, OpenCode and Kilo by
opening each file once and reading only from that open file. Before, it checked a path and then
opened the path again, so a process writing in the worktree could swap the file for a link to a file
outside it between the check and the read, and the outside file's contents were sent as project
instructions. The file is now opened without following a link (`O_NOFOLLOW`, with `O_NONBLOCK` so a
named pipe cannot hold the open), must be the same file, by device and inode, that the check found,
must be a regular file of at most 128 KiB, and is read up to that limit. Each directory between the
worktree root and the file must be a real directory, not a link, and the same one before and after
the open; otherwise nothing is sent from that file.

A hard link has no target to resolve, so a worktree name hard-linked to a file outside the worktree
passed every path check and the outside file's contents were sent. The open file must now have
exactly one name (a link count of 1); a file with more names, inside the worktree or not, sends
nothing.

Windows has no `O_NOFOLLOW`. There the check before the open refuses a link, and the device and
inode comparison after the open refuses a link swapped in between. Node has no call that opens a file
relative to an open directory, so a directory swapped for a link and back again between these checks
is narrowed, not ruled out, on every platform.
