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
