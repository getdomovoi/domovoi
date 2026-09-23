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
