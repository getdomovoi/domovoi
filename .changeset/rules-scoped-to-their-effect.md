---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": patch
"@getdomovoi/ui": patch
---

A standing approval rule now covers only what the approved request could reach. A file-tool
rule matched the tool anywhere in the worktree, so one "Always in this project" on an Edit approved
later edits to `package.json`, test files and runner configuration; and a rule for any other
provider tool matched on its bare name, so one WebFetch rule approved every later fetch, including
one that carries data out, and one MCP rule approved every call to that tool.

File-tool requests now resolve to a record scoped to the target file (`coverage: "tool-and-file"`,
`scope: "file"`, `path`), so a rule covers that tool on that file. Rules made for the whole
worktree stay listed and no longer match; Settings says so. Requests for provider tools that are
neither a shell command nor a file tool, such as WebFetch, WebSearch and MCP tools, stay unresolved,
so no standing rule can be made for them and each one asks.

A file-tool request aimed at the worktree root itself names no file and now stays unresolved. It
used to fail validation while resolving, so the request got no card and the provider waited for an
answer that never came. Resolving a request no longer throws at all: one it cannot fingerprint is
unresolved, which still raises a card and makes no standing rule. Claude's Read, Glob, Grep and Task
requests stay unresolved inside and outside the worktree, so each one asks and none can become a
standing rule.

A file-tool target is read the way the filesystem reads it: each link is followed before the `..`
after it applies, a dangling link leads where it points, and a relative path starts at the request's
directory. A rule for an inside file no longer matches a path that a link carries outside. The
Claude adapter passes the file name exactly as the provider will use it, untrimmed and with `..`
kept. A `package.json` that is not a regular file, or that is too large or too slow to read, leaves
a script run unresolved instead of holding the request.

A provider tool is identified by the tool that runs, not by fields in its input: an MCP request
whose input carries `command: "Edit"` and a `file_path` stays unresolved instead of taking the
Edit rule's digest, a Claude file tool is always named by its tool, and a Bash request never
sends a file path. Approving a file-tool card reads its target again first, the way a changed
package script already was: if the file the edit reaches changed while the card waited, for
example because a directory on its path became a link out of the worktree, the edit is not
released and the card is updated for review. A card updated this way keeps its hard gate. The
refusal for a file-tool card reads "The file target changed; review the updated approval before
allowing it"; a shell or script card keeps "The resolved command changed". The check runs when the
card is answered, not when the provider writes, so a target swapped in between still reaches the
provider. The path each waiting file-tool card was raised for is held in memory and dropped once
the card leaves, whether it was answered, archived, cleared by a provider disconnect, session close
or emergency stop, or expired.

A file-tool target that is a file with more than one hard link stays unresolved: its other names
share its bytes and may lie outside the worktree, so no standing rule applies to it and its card
offers no Always. Domovoi never releases an edit to such a file: moving one of its other names
changes nothing Domovoi reads at the file, so Allow once is refused with "This file has other names
Domovoi cannot check, so Domovoi will not release the edit.", both for a file that had another name
when its card was raised and for one that gained a name while the card waited (that card is also
rewritten under its next revision). A file that does not exist yet is unaffected. An
existing target that is not a regular file (a directory, FIFO, socket or device) stays unresolved
the same way, read with lstat only, so a FIFO is never opened; a regular file replaced by one while
its card waits is refused when the card is answered.
